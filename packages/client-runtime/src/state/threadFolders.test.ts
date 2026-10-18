import { type ThreadFolder, ThreadFolderId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyFolderCollapse,
  buildThreadFolderTree,
  groupThreadsByProjectFolders,
  planThreadFolderReorder,
  sortThreadFolders,
  threadFolderDepth,
  threadFolderIdForThread,
  threadFolderProjectKey,
  threadFolderThreadKey,
  threadFolderMoveTargets,
} from "./threadFolders.ts";

let folderCounter = 0;
const folder = (overrides: Partial<ThreadFolder> = {}): ThreadFolder => {
  folderCounter += 1;
  return {
    id: ThreadFolderId.make(`folder-${folderCounter}`),
    parentId: null,
    title: `Folder ${folderCounter}`,
    orderKey: null,
    threadIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
};

const threadId = (id: string) => ThreadId.make(id);

describe("sortThreadFolders", () => {
  it("orders keyed folders first, keyless folders by creation below, id as tiebreak", () => {
    const keylessOld = folder({ createdAt: "2026-01-01T00:00:00.000Z" });
    const keylessNew = folder({ createdAt: "2026-02-01T00:00:00.000Z" });
    const keyedB = folder({ orderKey: "b" });
    const keyedA = folder({ orderKey: "a" });

    const sorted = sortThreadFolders([keylessNew, keyedB, keylessOld, keyedA]);

    expect(sorted.map((entry) => entry.id)).toEqual([
      keyedA.id,
      keyedB.id,
      keylessOld.id,
      keylessNew.id,
    ]);
  });
});

describe("buildThreadFolderTree", () => {
  it("walks depth-first in display order and labels nesting depth from 1", () => {
    const rootA = folder({ orderKey: "a" });
    const rootB = folder({ orderKey: "b" });
    const child = folder({ parentId: rootB.id });
    const grandchild = folder({ parentId: child.id });

    const tree = buildThreadFolderTree([grandchild, rootB, child, rootA]);

    expect(tree.map((node) => [node.folder.id, node.depth])).toEqual([
      [rootA.id, 1],
      [rootB.id, 1],
    ]);
    expect(tree[1]!.children.map((node) => [node.folder.id, node.depth])).toEqual([[child.id, 2]]);
    expect(tree[1]!.children[0]!.children.map((node) => [node.folder.id, node.depth])).toEqual([
      [grandchild.id, 3],
    ]);
  });

  it("lifts a folder whose parent is missing from the list to the root", () => {
    const orphan = folder({ parentId: ThreadFolderId.make("vanished") });

    const tree = buildThreadFolderTree([orphan]);

    expect(tree.map((node) => node.folder.id)).toEqual([orphan.id]);
    expect(tree[0]!.depth).toBe(1);
  });

  it("renders folders stuck in a parent cycle at the root instead of dropping them", () => {
    const a = folder();
    const b = folder({ parentId: a.id });
    // Corrupt state the server prevents: a claims its own child as parent.
    const corrupt = { ...a, parentId: b.id };

    const tree = buildThreadFolderTree([corrupt, b]);

    expect(tree.map((node) => node.folder.id)).toEqual([corrupt.id, b.id]);
  });
});

describe("threadFolderIdForThread", () => {
  it("returns the first folder claiming the thread, null when ungrouped", () => {
    const first = folder({ threadIds: [threadId("t1")] });
    const second = folder({ threadIds: [threadId("t1")] });

    expect(threadFolderIdForThread([first, second], "t1")).toBe(first.id);
    expect(threadFolderIdForThread([second], "t2")).toBeNull();
  });
});

describe("groupThreadsByProjectFolders", () => {
  const environmentA = "environment-a";
  const environmentB = "environment-b";
  const listThread = (environmentId: string, projectId: string, id: string) => ({
    id: threadId(id),
    environmentId,
    projectId,
  });

  it("partitions threads exactly once across ungrouped and folder views", () => {
    const members = folder({ threadIds: [threadId("t1"), threadId("t2")] });
    const threads = [
      listThread(environmentA, "project-a", "t0"),
      listThread(environmentA, "project-a", "t1"),
      listThread(environmentA, "project-a", "t2"),
    ];

    const grouping = groupThreadsByProjectFolders({
      foldersByProjectKey: new Map([
        [threadFolderProjectKey("environment-a", "project-a"), [members]],
      ]),
      threads,
    });

    const grouped = [...grouping.ungrouped, ...grouping.views.flatMap((view) => view.threads)].map(
      (thread) => thread.id,
    );
    expect(grouped).toEqual(["t0", "t1", "t2"]);
    expect(grouping.views.map((view) => view.folder.id)).toEqual([members.id]);
  });

  it("never groups a thread into another project's or environment's folder", () => {
    const foreignClaim = folder({ threadIds: [threadId("foreign")] });
    const threads = [listThread(environmentB, "project-b", "foreign")];

    const grouping = groupThreadsByProjectFolders({
      foldersByProjectKey: new Map([
        [threadFolderProjectKey("environment-a", "project-a"), [foreignClaim]],
        [threadFolderProjectKey("environment-b", "project-b"), []],
      ]),
      threads,
    });

    // The thread stays ungrouped; project A's folder renders as an empty
    // header with none of project B's threads inside it.
    expect(grouping.ungrouped.map((thread) => thread.id)).toEqual(["foreign"]);
    expect(grouping.views.map((view) => view.folder.id)).toEqual([foreignClaim.id]);
    expect(grouping.views[0]!.threads).toEqual([]);
  });

  it("counts running members by id even when the Working shelf keeps them out of the list", () => {
    const members = folder({ threadIds: [threadId("busy"), threadId("idle")] });
    const activeThreads = [listThread(environmentA, "project-a", "idle")];

    const withWorking = groupThreadsByProjectFolders({
      foldersByProjectKey: new Map([
        [threadFolderProjectKey("environment-a", "project-a"), [members]],
      ]),
      threads: activeThreads,
      workingThreadIds: new Set([
        threadFolderThreadKey(listThread(environmentA, "project-a", "busy")),
      ]),
    });
    const withoutWorking = groupThreadsByProjectFolders({
      foldersByProjectKey: new Map([
        [threadFolderProjectKey("environment-a", "project-a"), [members]],
      ]),
      threads: activeThreads,
    });

    expect(withWorking.views[0]!.workingCount).toBe(1);
    expect(withWorking.views[0]!.threads.map((thread) => thread.id)).toEqual(["idle"]);
    expect(withoutWorking.views[0]!.workingCount).toBe(0);
  });

  it("keeps an empty folder visible so a fresh folder can be named", () => {
    const empty = folder();

    const grouping = groupThreadsByProjectFolders({
      foldersByProjectKey: new Map([
        [threadFolderProjectKey("environment-a", "project-a"), [empty]],
      ]),
      threads: [],
    });

    expect(grouping.views.map((view) => view.folder.id)).toEqual([empty.id]);
  });
});

describe("planThreadFolderReorder", () => {
  it("writes the moved folder's key so it sorts before its previous neighbor", () => {
    const first = folder({ orderKey: "b" });
    const second = folder({ orderKey: "d" });
    const third = folder({ orderKey: "f" });

    const assignments = planThreadFolderReorder({
      folders: [first, second, third],
      movedId: second.id,
      direction: "up",
    });
    expect(assignments).not.toBeNull();
    expect(assignments!.map((assignment) => assignment.folderId)).toEqual([second.id]);

    const reordered = sortThreadFolders(
      [first, second, third].map((entry) =>
        entry.id === second.id ? { ...entry, orderKey: assignments![0]!.orderKey } : entry,
      ),
    );
    expect(reordered.map((entry) => entry.id)).toEqual([second.id, first.id, third.id]);
  });

  it("returns null at the ends of the sibling list and for an unknown folder", () => {
    const first = folder({ orderKey: "b" });
    const second = folder({ orderKey: "d" });

    expect(
      planThreadFolderReorder({ folders: [first, second], movedId: first.id, direction: "up" }),
    ).toBeNull();
    expect(
      planThreadFolderReorder({ folders: [first, second], movedId: second.id, direction: "down" }),
    ).toBeNull();
    expect(
      planThreadFolderReorder({
        folders: [first, second],
        movedId: ThreadFolderId.make("nope"),
        direction: "up",
      }),
    ).toBeNull();
  });

  it("reorders only among siblings of the same parent", () => {
    const root = folder();
    const childA = folder({ parentId: root.id, orderKey: "b" });
    const childB = folder({ parentId: root.id, orderKey: "d" });
    const otherParent = folder({ orderKey: "m" });

    const assignments = planThreadFolderReorder({
      folders: [root, childA, childB, otherParent],
      movedId: childB.id,
      direction: "up",
    });

    expect(assignments!.map((assignment) => assignment.folderId)).toEqual([childB.id]);
  });
});

describe("threadFolderDepth", () => {
  it("counts nesting from 1 and terminates on a corrupt cycle", () => {
    const root = folder();
    const child = folder({ parentId: root.id });
    const grandchild = folder({ parentId: child.id });

    expect(threadFolderDepth([root, child, grandchild], root.id)).toBe(1);
    expect(threadFolderDepth([root, child, grandchild], grandchild.id)).toBe(3);

    const a = folder();
    const corrupt = { ...a, parentId: a.id };
    expect(threadFolderDepth([corrupt], corrupt.id)).toBe(1);
  });
});

describe("applyFolderCollapse", () => {
  const groupingFor = () => {
    const members = folder({ threadIds: [threadId("t1"), threadId("t2")] });
    const threads = [
      { id: threadId("t0"), environmentId: "environment-a", projectId: "project-a" },
      { id: threadId("t1"), environmentId: "environment-a", projectId: "project-a" },
      { id: threadId("t2"), environmentId: "environment-a", projectId: "project-a" },
    ];
    const grouping = groupThreadsByProjectFolders({
      foldersByProjectKey: new Map([
        [threadFolderProjectKey("environment-a", "project-a"), [members]],
      ]),
      threads,
    });
    return { members, grouping };
  };

  it("shows every member row while expanded", () => {
    const { members, grouping } = groupingFor();

    const collapsed = applyFolderCollapse({ grouping, collapsedById: {} });

    expect(collapsed.ungrouped.map((thread) => thread.id)).toEqual(["t0"]);
    expect(collapsed.views[0]!.visibleThreads.map((thread) => thread.id)).toEqual(["t1", "t2"]);
    expect(collapsed.visibleThreads.map((thread) => thread.id)).toEqual(["t0", "t1", "t2"]);
    expect(collapsed.views[0]!.view.folder.id).toBe(members.id);
  });

  it("hides a collapsed folder's rows but keeps the header and ungrouped rows", () => {
    const { grouping } = groupingFor();

    const collapsed = applyFolderCollapse({
      grouping,
      collapsedById: { [grouping.views[0]!.key]: true },
    });

    expect(collapsed.views).toHaveLength(1);
    expect(collapsed.views[0]!.visibleThreads).toEqual([]);
    expect(collapsed.visibleThreads.map((thread) => thread.id)).toEqual(["t0"]);
  });

  it("never hides the row the user has open behind a collapsed folder", () => {
    const { grouping } = groupingFor();

    const collapsed = applyFolderCollapse({
      grouping,
      collapsedById: { [grouping.views[0]!.key]: true },
      keepVisible: (thread) => thread.id === threadId("t2"),
    });

    expect(collapsed.views[0]!.visibleThreads.map((thread) => thread.id)).toEqual(["t2"]);
    expect(collapsed.visibleThreads.map((thread) => thread.id)).toEqual(["t0", "t2"]);
  });
});

describe("qualified folder views", () => {
  const row = (environmentId: string, projectId = "p", id = "same") => ({
    environmentId,
    projectId,
    id,
  });
  it("keeps duplicate native thread IDs and folder IDs independent across environments and projects", () => {
    const sharedFolder = folder({ threadIds: [threadId("same")] });
    const threads = [row("e1"), row("e2"), row("e1", "other")];
    const grouping = groupThreadsByProjectFolders({
      foldersByProjectKey: new Map([
        [threadFolderProjectKey("e1", "p"), [sharedFolder]],
        [threadFolderProjectKey("e2", "p"), []],
        [threadFolderProjectKey("e1", "other"), [sharedFolder]],
      ]),
      threads,
      workingThreadIds: new Set([threadFolderThreadKey(threads[0]!)]),
    });
    expect(grouping.ungrouped).toEqual([threads[1]]);
    expect(grouping.views.flatMap((view) => view.threads)).toEqual([threads[0], threads[2]]);
    expect(new Set(grouping.views.map((view) => view.key)).size).toBe(2);
    expect(grouping.views.map((view) => view.workingCount)).toEqual([1, 0]);
    const collapsed = applyFolderCollapse({
      grouping,
      collapsedById: { [grouping.views[0]!.key]: true },
    });
    expect(collapsed.visibleThreads).toEqual([threads[1], threads[2]]);
  });
  it("separates matching folder IDs and activity in two environments", () => {
    const sharedFolder = folder({ threadIds: [threadId("same")] });
    const threads = [row("e1"), row("e2")];
    const grouping = groupThreadsByProjectFolders({
      foldersByProjectKey: new Map([
        [threadFolderProjectKey("e1", "p"), [sharedFolder]],
        [threadFolderProjectKey("e2", "p"), [sharedFolder]],
      ]),
      threads,
      workingThreadIds: new Set([threadFolderThreadKey(threads[0]!)]),
    });
    expect(grouping.views.map((view) => view.workingCount)).toEqual([1, 0]);
    expect(grouping.views[0]!.key).not.toEqual(grouping.views[1]!.key);
    const collapsed = applyFolderCollapse({
      grouping,
      collapsedById: { [grouping.views[0]!.key]: true },
    });
    expect(collapsed.visibleThreads).toEqual([threads[1]]);
  });
  it.each([true, false])(
    "collapses descendant headers and rows, aggregates work, and keeps only the route ancestry (shelf=%s)",
    (shelf) => {
      const root = folder({ threadIds: [threadId("root")] });
      const child = folder({ parentId: root.id, threadIds: [threadId("child")] });
      const grandchild = folder({
        parentId: child.id,
        threadIds: [threadId("route"), threadId("busy")],
      });
      const sibling = folder({ parentId: root.id, threadIds: [threadId("sibling")] });
      const other = folder({ threadIds: [threadId("other")] });
      const threads = ["root", "child", "route", "busy", "sibling", "other"]
        .filter((id) => !shelf || id !== "busy")
        .map((id) => row("e1", "p", id));
      const grouping = groupThreadsByProjectFolders({
        foldersByProjectKey: new Map([
          [threadFolderProjectKey("e1", "p"), [root, child, grandchild, sibling, other]],
          [threadFolderProjectKey("e2", "p"), [root]],
        ]),
        threads,
        workingThreadIds: new Set([threadFolderThreadKey(row("e1", "p", "busy"))]),
      });
      const collapsedById = { [grouping.views[0]!.key]: true };
      const closed = applyFolderCollapse({ grouping, collapsedById });
      expect(closed.views.map(({ view }) => view.folder.id)).toEqual([root.id, other.id, root.id]);
      expect(closed.visibleThreads.map((thread) => thread.id)).toEqual(["other"]);
      expect(closed.views.map(({ view }) => view.workingCount)).toEqual([1, 0, 0]);
      const routeOpen = applyFolderCollapse({
        grouping,
        collapsedById,
        keepVisible: (thread) => thread.id === "route",
      });
      expect(routeOpen.views.map(({ view }) => view.folder.id)).toEqual([
        root.id,
        child.id,
        grandchild.id,
        other.id,
        root.id,
      ]);
      expect(routeOpen.visibleThreads.map((thread) => thread.id)).toEqual(["route", "other"]);
      const expanded = applyFolderCollapse({ grouping, collapsedById: {} });
      expect(expanded.visibleThreads).toHaveLength(threads.length);
    },
  );
});

describe("threadFolderMoveTargets", () => {
  it("offers root and legal parents in tree order, excluding the current parent, own subtree and depth-invalid targets", () => {
    const root = folder();
    const moved = folder({ parentId: root.id });
    const child = folder({ parentId: moved.id });
    const other = folder();
    const level2 = folder({ parentId: other.id });
    const level3 = folder({ parentId: level2.id });
    const level4 = folder({ parentId: level3.id });
    const level5 = folder({ parentId: level4.id });
    const folders = [root, moved, child, other, level2, level3, level4, level5];
    expect(threadFolderMoveTargets(folders, moved.id).map((target) => target.parentId)).toEqual([
      null,
      other.id,
      level2.id,
      level3.id,
    ]);
    expect(threadFolderMoveTargets(folders, other.id).map((target) => target.parentId)).toEqual([]);
    expect(threadFolderMoveTargets(folders, ThreadFolderId.make("missing"))).toEqual([]);
  });
});
