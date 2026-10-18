import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  type ThreadFolder,
  ThreadFolderId,
  ThreadId,
  MAX_THREAD_FOLDER_DEPTH,
  MAX_THREAD_FOLDERS_PER_PROJECT,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import {
  decodeThreadFolderCommandRejection,
  encodeThreadFolderCommandRejection,
  planThreadFolderCommand,
  ThreadFolderCommandInvariantError,
  ThreadFolderCommandMissingFolderError,
  ThreadFolderCommandMissingProjectError,
  ThreadFolderCommandMissingThreadError,
  type ThreadFolderCommand,
} from "./ThreadFolderCommands.ts";
import type { ProjectRow } from "./ProjectStore.ts";

const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const occurredAt = DateTime.formatIso(now);
const projectId = ProjectId.make("project-folders");
const eventId = EventId.make("event-folders");

const row = (overrides: Partial<ProjectRow> = {}): ProjectRow => ({
  projectId,
  title: "Folders",
  workspaceRoot: "/tmp/folders",
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  threadFolders: [],
  createdAt: "2025-12-01T00:00:00.000Z",
  updatedAt: "2025-12-01T00:00:00.000Z",
  deletedAt: null,
  ...overrides,
});

let folderCounter = 0;
const folder = (overrides: Partial<ThreadFolder> = {}): ThreadFolder => {
  folderCounter += 1;
  return {
    id: ThreadFolderId.make(`folder-${folderCounter}`),
    parentId: null,
    title: `Folder ${folderCounter}`,
    orderKey: null,
    threadIds: [],
    createdAt: "2025-12-01T00:00:00.000Z",
    updatedAt: "2025-12-01T00:00:00.000Z",
    ...overrides,
  };
};

type CommandInput = ThreadFolderCommand extends infer C
  ? C extends ThreadFolderCommand
    ? Omit<C, "commandId" | "projectId">
    : never
  : never;

const command = (input: CommandInput): ThreadFolderCommand =>
  ({ commandId: CommandId.make("folder-command"), projectId, ...input }) as ThreadFolderCommand;

const plan = (input: {
  readonly command: ThreadFolderCommand;
  readonly project?: ProjectRow;
  readonly noProject?: boolean;
  readonly folders?: ReadonlyArray<ThreadFolder>;
  readonly placementTarget?: { readonly exists: boolean; readonly belongsToProject: boolean };
}) =>
  planThreadFolderCommand({
    command: input.command,
    state: {
      project: input.noProject ? undefined : (input.project ?? row()),
      folders: input.folders ?? [],
      ...(input.placementTarget === undefined ? {} : { placementTarget: input.placementTarget }),
    },
    eventId,
    now,
  });

const foldersOf = (planned: ReturnType<typeof plan>): ReadonlyArray<ThreadFolder> => {
  if (!Result.isSuccess(planned)) throw new Error("Expected an accepted folder command");
  if (planned.success.type !== "project.thread-folders-updated")
    throw new Error("Expected folder update");
  assert.equal(planned.success.type, "project.thread-folders-updated");
  assert.equal(planned.success.aggregateKind, "project");
  assert.equal(planned.success.aggregateId, projectId);
  assert.equal(planned.success.commandId, CommandId.make("folder-command"));
  assert.equal(planned.success.payload.updatedAt, occurredAt);
  return planned.success.payload.threadFolders;
};

const failureOf = (planned: ReturnType<typeof plan>): { readonly _tag: string } => {
  if (!Result.isFailure(planned)) throw new Error("Expected a rejected folder command");
  return planned.failure;
};

describe("planThreadFolderCommand", () => {
  it("rejects every command for a missing or deleted project", () => {
    const missing = plan({
      command: command({
        type: "threadFolder.create",
        folderId: ThreadFolderId.make("f"),
        title: "A",
      }),
      noProject: true,
    });
    assert.instanceOf(failureOf(missing), ThreadFolderCommandMissingProjectError);
    const deleted = plan({
      command: command({
        type: "threadFolder.create",
        folderId: ThreadFolderId.make("f"),
        title: "A",
      }),
      project: row({ deletedAt: occurredAt }),
    });
    assert.instanceOf(failureOf(deleted), ThreadFolderCommandMissingProjectError);
  });

  describe("threadFolder.create", () => {
    it("appends a keyless empty folder and emits the full list", () => {
      const existing = [folder({ id: ThreadFolderId.make("root") })];
      const next = foldersOf(
        plan({
          command: command({
            type: "threadFolder.create",
            folderId: ThreadFolderId.make("new"),
            title: "New",
          }),
          folders: existing,
        }),
      );
      assert.equal(next.length, 2);
      assert.deepEqual(next[1], {
        id: ThreadFolderId.make("new"),
        parentId: null,
        title: "New",
        orderKey: null,
        threadIds: [],
        createdAt: occurredAt,
        updatedAt: occurredAt,
      });
    });

    it("nests under an existing parent", () => {
      const parent = folder({ id: ThreadFolderId.make("parent") });
      const next = foldersOf(
        plan({
          command: command({
            type: "threadFolder.create",
            folderId: ThreadFolderId.make("child"),
            title: "Child",
            parentId: parent.id,
          }),
          folders: [parent],
        }),
      );
      assert.equal(next[1]?.parentId, parent.id);
    });

    it("rejects a duplicate folder id, an unknown parent, and a blank title", () => {
      const existing = [folder({ id: ThreadFolderId.make("root") })];
      assert.instanceOf(
        failureOf(
          plan({
            command: command({
              type: "threadFolder.create",
              folderId: existing[0]!.id,
              title: "Again",
            }),
            folders: existing,
          }),
        ),
        ThreadFolderCommandInvariantError,
      );
      assert.instanceOf(
        failureOf(
          plan({
            command: command({
              type: "threadFolder.create",
              folderId: ThreadFolderId.make("new"),
              title: "New",
              parentId: ThreadFolderId.make("nope"),
            }),
          }),
        ),
        ThreadFolderCommandMissingFolderError,
      );
      assert.instanceOf(
        failureOf(
          plan({
            command: command({
              type: "threadFolder.create",
              folderId: ThreadFolderId.make("new"),
              title: "   ",
            }),
          }),
        ),
        ThreadFolderCommandInvariantError,
      );
    });

    it(`rejects nesting deeper than ${MAX_THREAD_FOLDER_DEPTH}`, () => {
      const folders: ThreadFolder[] = [];
      for (let depth = 0; depth < MAX_THREAD_FOLDER_DEPTH; depth += 1) {
        folders.push(
          folder({
            id: ThreadFolderId.make(`level-${depth}`),
            parentId: depth === 0 ? null : ThreadFolderId.make(`level-${depth - 1}`),
          }),
        );
      }
      const deepest = folders[folders.length - 1]!;
      assert.instanceOf(
        failureOf(
          plan({
            command: command({
              type: "threadFolder.create",
              folderId: ThreadFolderId.make("too-deep"),
              title: "Too deep",
              parentId: deepest.id,
            }),
            folders,
          }),
        ),
        ThreadFolderCommandInvariantError,
      );
    });

    it(`rejects the ${MAX_THREAD_FOLDERS_PER_PROJECT + 1}th folder of a project`, () => {
      const folders = Array.from({ length: MAX_THREAD_FOLDERS_PER_PROJECT }, (_, index) =>
        folder({ id: ThreadFolderId.make(`bulk-${index}`) }),
      );
      assert.instanceOf(
        failureOf(
          plan({
            command: command({
              type: "threadFolder.create",
              folderId: ThreadFolderId.make("one-too-many"),
              title: "One too many",
            }),
            folders,
          }),
        ),
        ThreadFolderCommandInvariantError,
      );
    });
  });

  describe("threadFolder.rename", () => {
    it("changes only the title of the named folder", () => {
      const target = folder({ id: ThreadFolderId.make("target"), title: "Before" });
      const other = folder({ id: ThreadFolderId.make("other"), title: "Untouched" });
      const next = foldersOf(
        plan({
          command: command({ type: "threadFolder.rename", folderId: target.id, title: "After" }),
          folders: [target, other],
        }),
      );
      assert.equal(next.length, 2);
      assert.equal(next[0]!.title, "After");
      assert.equal(next[0]!.updatedAt, occurredAt);
      assert.equal(next[1]!.title, "Untouched");
      assert.equal(next[1]!.updatedAt, "2025-12-01T00:00:00.000Z");
    });

    it("rejects a blank title and an unknown folder", () => {
      const target = folder({ id: ThreadFolderId.make("target") });
      assert.instanceOf(
        failureOf(
          plan({
            command: command({ type: "threadFolder.rename", folderId: target.id, title: "" }),
            folders: [target],
          }),
        ),
        ThreadFolderCommandInvariantError,
      );
      assert.instanceOf(
        failureOf(
          plan({
            command: command({
              type: "threadFolder.rename",
              folderId: ThreadFolderId.make("nope"),
              title: "X",
            }),
          }),
        ),
        ThreadFolderCommandMissingFolderError,
      );
    });
  });

  describe("threadFolder.move", () => {
    const tree = () => {
      const root = folder({ id: ThreadFolderId.make("root") });
      const child = folder({ id: ThreadFolderId.make("child"), parentId: root.id });
      return [root, child] as const;
    };

    it("moves a folder to the root and under another folder", () => {
      const [root, child] = tree();
      const next = foldersOf(
        plan({
          command: command({ type: "threadFolder.move", folderId: child.id, parentId: null }),
          folders: [root, child],
        }),
      );
      assert.equal(next[1]!.parentId, null);

      const sibling = folder({ id: ThreadFolderId.make("sibling") });
      const nested = foldersOf(
        plan({
          command: command({ type: "threadFolder.move", folderId: child.id, parentId: sibling.id }),
          folders: [root, child, sibling],
        }),
      );
      assert.equal(nested[1]!.parentId, sibling.id);
    });

    it("rejects becoming its own parent or descending into its own subtree", () => {
      const [root, child] = tree();
      assert.instanceOf(
        failureOf(
          plan({
            command: command({ type: "threadFolder.move", folderId: root.id, parentId: root.id }),
            folders: [root, child],
          }),
        ),
        ThreadFolderCommandInvariantError,
      );
      assert.instanceOf(
        failureOf(
          plan({
            command: command({ type: "threadFolder.move", folderId: root.id, parentId: child.id }),
            folders: [root, child],
          }),
        ),
        ThreadFolderCommandInvariantError,
      );
    });

    it("rejects an unknown target parent", () => {
      const [root] = tree();
      assert.instanceOf(
        failureOf(
          plan({
            command: command({
              type: "threadFolder.move",
              folderId: root.id,
              parentId: ThreadFolderId.make("nope"),
            }),
            folders: tree(),
          }),
        ),
        ThreadFolderCommandMissingFolderError,
      );
    });

    it(`rejects a move that would push the subtree past ${MAX_THREAD_FOLDER_DEPTH}`, () => {
      const chain: ThreadFolder[] = [];
      for (let depth = 0; depth < MAX_THREAD_FOLDER_DEPTH; depth += 1) {
        chain.push(
          folder({
            id: ThreadFolderId.make(`chain-${depth}`),
            parentId: depth === 0 ? null : ThreadFolderId.make(`chain-${depth - 1}`),
          }),
        );
      }
      const subtreeRoot = folder({ id: ThreadFolderId.make("subtree") });
      const subtreeChild = folder({
        id: ThreadFolderId.make("subtree-child"),
        parentId: subtreeRoot.id,
      });
      const deepest = chain[chain.length - 1]!;
      assert.instanceOf(
        failureOf(
          plan({
            command: command({
              type: "threadFolder.move",
              folderId: subtreeRoot.id,
              parentId: deepest.id,
            }),
            folders: [...chain, subtreeRoot, subtreeChild],
          }),
        ),
        ThreadFolderCommandInvariantError,
      );
    });
  });

  describe("threadFolder.reorder", () => {
    it("records the sibling order key", () => {
      const target = folder({ id: ThreadFolderId.make("target") });
      const next = foldersOf(
        plan({
          command: command({ type: "threadFolder.reorder", folderId: target.id, orderKey: "a0" }),
          folders: [target],
        }),
      );
      assert.equal(next[0]!.orderKey, "a0");
    });

    it("rejects an unknown folder", () => {
      assert.instanceOf(
        failureOf(
          plan({
            command: command({
              type: "threadFolder.reorder",
              folderId: ThreadFolderId.make("nope"),
              orderKey: "a0",
            }),
          }),
        ),
        ThreadFolderCommandMissingFolderError,
      );
    });
  });

  describe("threadFolder.remove", () => {
    it("lifts child folders and member threads to the removed folder's parent", () => {
      const parent = folder({
        id: ThreadFolderId.make("parent"),
        threadIds: [ThreadId.make("kept")],
      });
      const removed = folder({
        id: ThreadFolderId.make("removed"),
        parentId: parent.id,
        threadIds: [ThreadId.make("lifted")],
      });
      const child = folder({ id: ThreadFolderId.make("child"), parentId: removed.id });
      const next = foldersOf(
        plan({
          command: command({ type: "threadFolder.remove", folderId: removed.id }),
          folders: [parent, removed, child],
        }),
      );
      assert.deepEqual(
        next.map((entry) => entry.id),
        [parent.id, child.id],
      );
      assert.equal(next[1]!.parentId, parent.id);
      assert.deepEqual(next[0]!.threadIds, [ThreadId.make("kept"), ThreadId.make("lifted")]);
    });

    it("ungroups threads and re-roots children when removing a root folder", () => {
      const removed = folder({
        id: ThreadFolderId.make("removed"),
        threadIds: [ThreadId.make("member")],
      });
      const child = folder({ id: ThreadFolderId.make("child"), parentId: removed.id });
      const next = foldersOf(
        plan({
          command: command({ type: "threadFolder.remove", folderId: removed.id }),
          folders: [removed, child],
        }),
      );
      assert.deepEqual(
        next.map((entry) => entry.id),
        [child.id],
      );
      assert.equal(next[0]!.parentId, null);
      assert.equal(next.flatMap((entry) => entry.threadIds).length, 0);
    });

    it("rejects an unknown folder without touching anything", () => {
      assert.instanceOf(
        failureOf(
          plan({
            command: command({
              type: "threadFolder.remove",
              folderId: ThreadFolderId.make("nope"),
            }),
          }),
        ),
        ThreadFolderCommandMissingFolderError,
      );
    });
  });

  describe("threadFolder.placeThread", () => {
    const target = { exists: true, belongsToProject: true };
    const threadId = ThreadId.make("thread-1");
    const source = () => folder({ id: ThreadFolderId.make("source"), threadIds: [threadId] });

    it("moves the thread between folders without duplicating it", () => {
      const destination = folder({ id: ThreadFolderId.make("destination") });
      const next = foldersOf(
        plan({
          command: command({
            type: "threadFolder.placeThread",
            threadId,
            folderId: destination.id,
          }),
          folders: [source(), destination],
          placementTarget: target,
        }),
      );
      assert.deepEqual(next[0]!.threadIds, []);
      assert.deepEqual(next[1]!.threadIds, [threadId]);
    });

    it("ungroups the thread when placed with no folder", () => {
      const next = foldersOf(
        plan({
          command: command({ type: "threadFolder.placeThread", threadId, folderId: null }),
          folders: [source()],
          placementTarget: target,
        }),
      );
      assert.deepEqual(next[0]!.threadIds, []);
    });

    it("never duplicates a thread already in the target folder", () => {
      const next = foldersOf(
        plan({
          command: command({
            type: "threadFolder.placeThread",
            threadId,
            folderId: ThreadFolderId.make("source"),
          }),
          folders: [source()],
          placementTarget: target,
        }),
      );
      assert.deepEqual(next[0]!.threadIds, [threadId]);
    });

    it("rejects threads that are missing, deleted, or owned by another project", () => {
      const placements = [
        undefined,
        { exists: false, belongsToProject: true },
        { exists: true, belongsToProject: false },
      ] as const;
      for (const placementTarget of placements) {
        const planned = plan({
          command: command({ type: "threadFolder.placeThread", threadId, folderId: null }),
          folders: [source()],
          ...(placementTarget === undefined ? {} : { placementTarget }),
        });
        assert.instanceOf(failureOf(planned), ThreadFolderCommandMissingThreadError);
      }
    });

    it("rejects an unknown target folder", () => {
      assert.instanceOf(
        failureOf(
          plan({
            command: command({
              type: "threadFolder.placeThread",
              threadId,
              folderId: ThreadFolderId.make("nope"),
            }),
            folders: [source()],
            placementTarget: target,
          }),
        ),
        ThreadFolderCommandMissingFolderError,
      );
    });
  });

  it("re-encodes every rejection so a retried command id replays the same typed error", () => {
    const rejections = [
      new ThreadFolderCommandInvariantError({
        commandType: "threadFolder.create",
        detail: "duplicate",
      }),
      new ThreadFolderCommandMissingFolderError({
        commandType: "threadFolder.remove",
        folderId: ThreadFolderId.make("gone"),
      }),
      new ThreadFolderCommandMissingProjectError({ commandType: "threadFolder.rename", projectId }),
      new ThreadFolderCommandMissingThreadError({
        commandType: "threadFolder.placeThread",
        threadId: ThreadId.make("t"),
      }),
    ] as const;
    for (const rejection of rejections) {
      const decoded = Option.getOrThrow(
        decodeThreadFolderCommandRejection(encodeThreadFolderCommandRejection(rejection)),
      );
      assert.isTrue(decoded._tag === rejection._tag, `expected ${rejection._tag} to round trip`);
      assert.equal(decoded.message, rejection.message);
    }
  });
});
