import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  ProjectId,
  ThreadFolderId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** Organizational thread folders never exceed this depth of nesting. */
export const MAX_THREAD_FOLDER_DEPTH = 5;
/** A project holds at most this many folders, empty ones included. */
export const MAX_THREAD_FOLDERS_PER_PROJECT = 100;

export const ThreadFolderTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
export type ThreadFolderTitle = typeof ThreadFolderTitle.Type;

/**
 * One user-managed organizational folder inside a project. A folder owns its
 * member threads; placement never changes where a thread executes. `orderKey`
 * arranges siblings (null sorts last by creation order), and `threadIds`
 * records the threads placed in this folder.
 */
export const ThreadFolder = Schema.Struct({
  id: ThreadFolderId,
  parentId: Schema.NullOr(ThreadFolderId),
  title: ThreadFolderTitle,
  orderKey: Schema.NullOr(TrimmedNonEmptyString),
  threadIds: Schema.Array(ThreadId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadFolder = typeof ThreadFolder.Type;

const ThreadFolderCommandBase = {
  commandId: CommandId,
  projectId: ProjectId,
} as const;

export const ThreadFolderMutation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("threadFolder.create"),
    ...ThreadFolderCommandBase,
    folderId: ThreadFolderId,
    title: ThreadFolderTitle,
    parentId: Schema.optional(Schema.NullOr(ThreadFolderId)),
  }),
  Schema.Struct({
    type: Schema.Literal("threadFolder.rename"),
    ...ThreadFolderCommandBase,
    folderId: ThreadFolderId,
    title: ThreadFolderTitle,
  }),
  Schema.Struct({
    type: Schema.Literal("threadFolder.move"),
    ...ThreadFolderCommandBase,
    folderId: ThreadFolderId,
    parentId: Schema.NullOr(ThreadFolderId),
  }),
  Schema.Struct({
    type: Schema.Literal("threadFolder.reorder"),
    ...ThreadFolderCommandBase,
    folderId: ThreadFolderId,
    // Sibling order keys share the fractional-key format used by thread
    // pinning (see thread.pin.reorder), which validates the same way.
    orderKey: TrimmedNonEmptyString,
  }),
  // Removing a folder never deletes threads or interrupts their work: child
  // folders and member threads lift to the removed folder's parent.
  Schema.Struct({
    type: Schema.Literal("threadFolder.remove"),
    ...ThreadFolderCommandBase,
    folderId: ThreadFolderId,
  }),
  Schema.Struct({
    type: Schema.Literal("threadFolder.placeThread"),
    ...ThreadFolderCommandBase,
    threadId: ThreadId,
    folderId: Schema.NullOr(ThreadFolderId),
  }),
]);
export type ThreadFolderMutation = typeof ThreadFolderMutation.Type;

export class ThreadFolderMutationError extends Schema.TaggedError<ThreadFolderMutationError>()(
  "ThreadFolderMutationError",
  {
    commandId: CommandId,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const ThreadFolderMutationResult = Schema.Struct({
  threadFolders: Schema.Array(ThreadFolder),
});
export type ThreadFolderMutationResult = typeof ThreadFolderMutationResult.Type;
