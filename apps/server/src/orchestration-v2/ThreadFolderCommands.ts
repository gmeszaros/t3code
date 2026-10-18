import {
  CommandId,
  type EventId,
  MAX_THREAD_FOLDER_DEPTH,
  MAX_THREAD_FOLDERS_PER_PROJECT,
  ProjectId,
  type ThreadFolder,
  ThreadFolderId,
  ThreadFolderTitle,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { UnsequencedProjectEvent } from "../persistence/OrchestrationEventStore.ts";
import type { ProjectRow } from "./ProjectStore.ts";

export interface ThreadFolderCreateCommand {
  readonly type: "threadFolder.create";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly folderId: ThreadFolderId;
  readonly title: ThreadFolderTitle;
  readonly parentId?: ThreadFolderId | null;
}

export interface ThreadFolderRenameCommand {
  readonly type: "threadFolder.rename";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly folderId: ThreadFolderId;
  readonly title: ThreadFolderTitle;
}

export interface ThreadFolderMoveCommand {
  readonly type: "threadFolder.move";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly folderId: ThreadFolderId;
  readonly parentId: ThreadFolderId | null;
}

export interface ThreadFolderReorderCommand {
  readonly type: "threadFolder.reorder";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly folderId: ThreadFolderId;
  readonly orderKey: string;
}

export interface ThreadFolderRemoveCommand {
  readonly type: "threadFolder.remove";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly folderId: ThreadFolderId;
}

export interface ThreadFolderPlaceThreadCommand {
  readonly type: "threadFolder.placeThread";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly folderId: ThreadFolderId | null;
}

export type ThreadFolderCommand =
  | ThreadFolderCreateCommand
  | ThreadFolderRenameCommand
  | ThreadFolderMoveCommand
  | ThreadFolderReorderCommand
  | ThreadFolderRemoveCommand
  | ThreadFolderPlaceThreadCommand;

export class ThreadFolderCommandInvariantError extends Schema.TaggedError<ThreadFolderCommandInvariantError>()(
  "ThreadFolderCommandInvariantError",
  {
    commandType: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Thread folder command invariant failed (${this.commandType}): ${this.detail}`;
  }
}

/** The command targets a folder that does not exist in the project. */
export class ThreadFolderCommandMissingFolderError extends Schema.TaggedError<ThreadFolderCommandMissingFolderError>()(
  "ThreadFolderCommandMissingFolderError",
  {
    commandType: Schema.String,
    folderId: ThreadFolderId,
  },
) {
  override get message(): string {
    return `Folder '${this.folderId}' does not exist for command '${this.commandType}'.`;
  }
}

/** The command targets a project that does not exist or was deleted. */
export class ThreadFolderCommandMissingProjectError extends Schema.TaggedError<ThreadFolderCommandMissingProjectError>()(
  "ThreadFolderCommandMissingProjectError",
  {
    commandType: Schema.String,
    projectId: ProjectId,
  },
) {
  override get message(): string {
    return `Project '${this.projectId}' does not exist for command '${this.commandType}'.`;
  }
}

/** A thread placement named a thread that is missing or belongs elsewhere. */
export class ThreadFolderCommandMissingThreadError extends Schema.TaggedError<ThreadFolderCommandMissingThreadError>()(
  "ThreadFolderCommandMissingThreadError",
  {
    commandType: Schema.String,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `Thread '${this.threadId}' does not exist in this project for command '${this.commandType}'.`;
  }
}

export const ThreadFolderCommandRejection = Schema.Union([
  ThreadFolderCommandInvariantError,
  ThreadFolderCommandMissingFolderError,
  ThreadFolderCommandMissingProjectError,
  ThreadFolderCommandMissingThreadError,
]);
export type ThreadFolderCommandRejection = typeof ThreadFolderCommandRejection.Type;

const ThreadFolderCommandRejectionJson = Schema.fromJsonString(ThreadFolderCommandRejection);
/**
 * A rejected receipt stores its rejection as JSON, so a retried command id
 * replays the same typed error even when a fresh plan would now succeed.
 */
export const encodeThreadFolderCommandRejection = Schema.encodeSync(
  ThreadFolderCommandRejectionJson,
);
/** None for receipts that predate structured rejections. */
export const decodeThreadFolderCommandRejection = Schema.decodeUnknownOption(
  ThreadFolderCommandRejectionJson,
);

/** What the planner needs to know about the thread a placement command names. */
export interface ThreadFolderPlacementTarget {
  readonly exists: boolean;
  readonly belongsToProject: boolean;
}

export interface ThreadFolderCommandState {
  /** The target project's active row, when it exists. */
  readonly project: ProjectRow | undefined;
  /** The project's persisted folder list; empty for pre-folder projects. */
  readonly folders: ReadonlyArray<ThreadFolder>;
  /** Only read for `threadFolder.placeThread`. */
  readonly placementTarget?: ThreadFolderPlacementTarget;
}

const isFolderTitle = Schema.is(ThreadFolderTitle);

/** Depth of one folder from its roots; a corrupt cycle counts what is walkable. */
export function threadFolderDepth(
  folders: ReadonlyArray<ThreadFolder>,
  folderId: ThreadFolderId,
): number {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  let depth = 1;
  let current = byId.get(folderId);
  const visited = new Set<ThreadFolderId>([folderId]);
  while (current?.parentId !== null && current?.parentId !== undefined) {
    if (visited.has(current.parentId)) break;
    visited.add(current.parentId);
    current = byId.get(current.parentId);
    depth += 1;
  }
  return depth;
}

/** Height of the subtree rooted at one folder (1 for a leaf). */
function subtreeHeight(folders: ReadonlyArray<ThreadFolder>, folderId: ThreadFolderId): number {
  let height = 1;
  for (const child of folders) {
    if (child.parentId !== folderId) continue;
    height = Math.max(height, 1 + subtreeHeight(folders, child.id));
  }
  return height;
}

function isDescendant(
  folders: ReadonlyArray<ThreadFolder>,
  ancestorId: ThreadFolderId,
  candidateId: ThreadFolderId,
): boolean {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  let current = byId.get(candidateId);
  const visited = new Set<ThreadFolderId>([candidateId]);
  while (current?.parentId !== null && current?.parentId !== undefined) {
    if (current.parentId === ancestorId) return true;
    if (visited.has(current.parentId)) break;
    visited.add(current.parentId);
    current = byId.get(current.parentId);
  }
  return false;
}

/**
 * Decide one thread folder command against the project's current folder state.
 * Every accepted command emits the full post-command folder list, so the fold
 * and every client converge by replacement. The caller reads `state` under the
 * project's lock and commits the planned event.
 */
export function planThreadFolderCommand(input: {
  readonly command: ThreadFolderCommand;
  readonly state: ThreadFolderCommandState;
  readonly eventId: EventId;
  readonly now: DateTime.Utc;
}): Result.Result<UnsequencedProjectEvent, ThreadFolderCommandRejection> {
  const { command, state } = input;
  const occurredAt = DateTime.formatIso(input.now);
  const invariant = (detail: string) =>
    Result.fail(new ThreadFolderCommandInvariantError({ commandType: command.type, detail }));
  const missingProject = () =>
    Result.fail(
      new ThreadFolderCommandMissingProjectError({
        commandType: command.type,
        projectId: command.projectId,
      }),
    );
  // Null only reaches this helper from a placement check that already ruled
  // the command out, so the rejected id is presentation only there.
  const missingFolder = (folderId: ThreadFolderId | null) =>
    Result.fail(
      new ThreadFolderCommandMissingFolderError({
        commandType: command.type,
        folderId: folderId as ThreadFolderId,
      }),
    );

  if (state.project === undefined || state.project.deletedAt !== null) return missingProject();
  const folders = state.folders;
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  // Create names a folder that must not exist yet, and only a thread
  // placement may name no folder at all (ungrouping the thread). Every other
  // command targets a folder that has to be there already.
  const folderId = command.folderId;
  const folder = folderId === null ? undefined : byId.get(folderId);
  if (
    command.type !== "threadFolder.create" &&
    !(command.type === "threadFolder.placeThread" && folderId === null) &&
    folder === undefined
  ) {
    return missingFolder(folderId);
  }

  const emit = (nextFolders: ReadonlyArray<ThreadFolder>) =>
    Result.succeed({
      eventId: input.eventId,
      aggregateKind: "project" as const,
      aggregateId: command.projectId,
      occurredAt,
      commandId: command.commandId,
      causationEventId: null,
      correlationId: command.commandId,
      metadata: {},
      type: "project.thread-folders-updated",
      payload: {
        projectId: command.projectId,
        threadFolders: [...nextFolders],
        updatedAt: occurredAt,
      },
    }) satisfies Result.Result<UnsequencedProjectEvent, never>;

  switch (command.type) {
    case "threadFolder.create": {
      if (folders.length >= MAX_THREAD_FOLDERS_PER_PROJECT) {
        return invariant(
          `A project holds at most ${MAX_THREAD_FOLDERS_PER_PROJECT} thread folders.`,
        );
      }
      if (folder !== undefined) {
        return invariant(`Folder '${command.folderId}' already exists.`);
      }
      if (!isFolderTitle(command.title)) return invariant("Folder titles must not be blank.");
      const parentId = command.parentId ?? null;
      if (parentId !== null && !byId.has(parentId)) return missingFolder(parentId);
      const depth = parentId === null ? 1 : threadFolderDepth(folders, parentId) + 1;
      if (depth > MAX_THREAD_FOLDER_DEPTH) {
        return invariant(`Thread folders nest at most ${MAX_THREAD_FOLDER_DEPTH} levels deep.`);
      }
      return emit([
        ...folders,
        {
          id: command.folderId,
          parentId,
          title: command.title,
          orderKey: null,
          threadIds: [],
          createdAt: occurredAt,
          updatedAt: occurredAt,
        },
      ]);
    }

    case "threadFolder.rename": {
      if (!isFolderTitle(command.title)) return invariant("Folder titles must not be blank.");
      return emit(
        folders.map((entry) =>
          entry.id === command.folderId
            ? { ...entry, title: command.title, updatedAt: occurredAt }
            : entry,
        ),
      );
    }

    case "threadFolder.move": {
      if (command.parentId !== null) {
        if (!byId.has(command.parentId)) return missingFolder(command.parentId);
        // Moving a folder under itself or its own subtree would orphan a cycle.
        if (command.parentId === command.folderId) {
          return invariant("A folder cannot become its own parent.");
        }
        if (isDescendant(folders, command.folderId, command.parentId)) {
          return invariant("A folder cannot move under its own subtree.");
        }
        const newDepth = threadFolderDepth(folders, command.parentId) + 1;
        if (newDepth + subtreeHeight(folders, command.folderId) - 1 > MAX_THREAD_FOLDER_DEPTH) {
          return invariant(`Thread folders nest at most ${MAX_THREAD_FOLDER_DEPTH} levels deep.`);
        }
      }
      return emit(
        folders.map((entry) =>
          entry.id === command.folderId
            ? { ...entry, parentId: command.parentId, updatedAt: occurredAt }
            : entry,
        ),
      );
    }

    case "threadFolder.reorder": {
      // The RPC schema already bounds order keys (TrimmedNonEmptyString, the
      // thread.pin.reorder contract), so this only records the new key.
      return emit(
        folders.map((entry) =>
          entry.id === command.folderId
            ? { ...entry, orderKey: command.orderKey, updatedAt: occurredAt }
            : entry,
        ),
      );
    }

    case "threadFolder.remove": {
      // Safe by construction: subfolders and member threads lift to the removed
      // folder's parent, so no thread is ever deleted or left orphaned.
      const parentId = folder?.parentId ?? null;
      const memberThreadIds = folder?.threadIds ?? [];
      return emit(
        folders
          .filter((entry) => entry.id !== command.folderId)
          .map((entry) => {
            if (entry.parentId === command.folderId) {
              return { ...entry, parentId, updatedAt: occurredAt };
            }
            if (parentId !== null && entry.id === parentId && memberThreadIds.length > 0) {
              return {
                ...entry,
                threadIds: [...entry.threadIds, ...memberThreadIds],
                updatedAt: occurredAt,
              };
            }
            return entry;
          }),
      );
    }

    case "threadFolder.placeThread": {
      const target = state.placementTarget;
      if (target === undefined || !target.exists || !target.belongsToProject) {
        return Result.fail(
          new ThreadFolderCommandMissingThreadError({
            commandType: command.type,
            threadId: command.threadId,
          }),
        );
      }
      return emit(
        folders.map((entry) => {
          const withoutThread = entry.threadIds.includes(command.threadId)
            ? {
                ...entry,
                threadIds: entry.threadIds.filter((id) => id !== command.threadId),
                updatedAt: occurredAt,
              }
            : entry;
          if (
            entry.id === command.folderId &&
            !withoutThread.threadIds.includes(command.threadId)
          ) {
            return {
              ...withoutThread,
              threadIds: [...withoutThread.threadIds, command.threadId],
              updatedAt: occurredAt,
            };
          }
          return withoutThread;
        }),
      );
    }
  }
}
