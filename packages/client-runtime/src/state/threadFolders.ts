import {
  MAX_THREAD_FOLDER_DEPTH,
  type ThreadFolder,
  type ThreadFolderId,
} from "@t3tools/contracts";

import { planPinnedMove, toSortableTimestamp } from "./threadSort.ts";

// Web/desktop organizational views use the project's authoritative folder list.
// Placement never changes execution or delegation; older clients may ignore it.

/** A folder or any structurally compatible projection of one. */
export type ThreadFolderLike = Pick<ThreadFolder, "id" | "parentId" | "orderKey" | "createdAt">;

// One shared rule with pinned threads: user-arranged keys first (plain string
// comparison), keyless folders in creation order below, id as the tiebreak.
export function sortThreadFolders<T extends ThreadFolderLike>(folders: readonly T[]): T[] {
  if (folders.length < 2) return [...folders];
  const identityTiebreak = (left: T, right: T) =>
    toSortableTimestamp(left.createdAt)! - toSortableTimestamp(right.createdAt)! ||
    left.id.localeCompare(right.id);
  return [...folders].sort((left, right) => {
    const leftKey = left.orderKey;
    const rightKey = right.orderKey;
    if (leftKey === null && rightKey === null) return identityTiebreak(left, right);
    if (leftKey === null) return 1;
    if (rightKey === null) return -1;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : identityTiebreak(left, right);
  });
}

export interface ThreadFolderNode<TFolder extends ThreadFolderLike = ThreadFolder> {
  readonly folder: TFolder;
  /** 1-based nesting depth; roots are 1. */
  readonly depth: number;
  readonly children: ReadonlyArray<ThreadFolderNode<TFolder>>;
}

/**
 * Depth-first tree in display order. A corrupted parent chain (a cycle, or a
 * parent the server no longer has) lifts that folder to the root of the walk
 * instead of rendering it nowhere or looping forever; the server prevents
 * these states, this only bounds the damage of receiving one.
 */
export function buildThreadFolderTree<TFolder extends ThreadFolderLike>(
  folders: readonly TFolder[],
): ReadonlyArray<ThreadFolderNode<TFolder>> {
  const ids = new Set(folders.map((folder) => folder.id));
  const byId = new Map(folders.map((folder) => [folder.id as string, folder]));
  // A folder whose parent chain loops would otherwise be bucketed under its
  // cycle partner and vanish from the walk; lift it to the root instead.
  const hasTerminatingAncestry = (folder: TFolder): boolean => {
    const seen = new Set<string>([folder.id as string]);
    let current: TFolder | undefined = folder;
    while (current.parentId !== null) {
      if (
        current.parentId === undefined ||
        !ids.has(current.parentId) ||
        seen.has(current.parentId)
      )
        return false;
      seen.add(current.parentId);
      current = byId.get(current.parentId);
      if (current === undefined) return false;
    }
    return true;
  };
  const childrenOf = new Map<string, TFolder[]>();
  for (const folder of sortThreadFolders(folders)) {
    // A parent the list no longer contains lifts to the root.
    const key =
      folder.parentId !== null && ids.has(folder.parentId) && hasTerminatingAncestry(folder)
        ? folder.parentId
        : "";
    const bucket = childrenOf.get(key);
    if (bucket === undefined) childrenOf.set(key, [folder]);
    else bucket.push(folder);
  }
  const walk = (
    parentId: string,
    depth: number,
    seen: ReadonlySet<string>,
  ): ReadonlyArray<ThreadFolderNode<TFolder>> =>
    (childrenOf.get(parentId) ?? []).map((folder) => {
      // A cycle can only reach here through corrupt data; render the folder
      // as a leaf rather than recursing into its own subtree again.
      const children = seen.has(folder.id)
        ? []
        : walk(folder.id, depth + 1, new Set([...seen, folder.id]));
      return { folder, depth, children };
    });
  return walk("", 1, new Set());
}

/** The folder holding a thread, or null when the thread is ungrouped. A
    corrupt list naming a thread twice resolves to its first claim. */
export function threadFolderIdForThread(
  folders: readonly ThreadFolder[],
  threadId: string,
): ThreadFolderId | null {
  for (const folder of folders) {
    if (folder.threadIds.includes(threadId as ThreadFolder["threadIds"][number])) return folder.id;
  }
  return null;
}

export interface ThreadFolderView<TThread> {
  /** Environment/project-qualified identity for all client view state. */
  readonly key: string;
  readonly projectKey: string;
  readonly folder: ThreadFolder;
  readonly depth: number;
  /** Member threads, in the order they arrived in `threads`. */
  readonly threads: readonly TThread[];
  /** Members whose work is running; collapsed folders surface this count.
      Counted from `workingThreadIds`, not from `threads`, so the count stays
      right while the Working shelf keeps running members out of the list. */
  readonly workingCount: number;
}

export interface ThreadFolderGrouping<TThread> {
  /** Threads that belong to no folder, in the order they arrived. */
  readonly ungrouped: ReadonlyArray<TThread>;
  /** Every folder of the project, depth-first in display order. Empty
      folders are included so a freshly created folder stays visible. */
  readonly views: ReadonlyArray<ThreadFolderView<TThread>>;
}

/**
 * Split an ordered thread list into folder views plus the ungrouped rest.
 * `folders` must be the list of ONE project; callers group their threads by
 * project first, so native thread IDs are resolved only inside their owner.
 * `workingThreadIds` counts running members even when the caller's list
 * excludes them (the Working shelf folds them away).
 */
export function groupThreadsByFolder<TThread extends { readonly id: string }>(input: {
  readonly folders: readonly ThreadFolder[];
  readonly threads: readonly TThread[];
  readonly workingThreadIds?: ReadonlySet<string>;
}): ThreadFolderGrouping<TThread> {
  const membersByFolderId = new Map<ThreadFolderId, TThread[]>();
  const ungrouped: TThread[] = [];
  const folderIdForThread = new Map<string, ThreadFolderId>();
  for (const folder of input.folders) {
    for (const threadId of folder.threadIds) {
      if (!folderIdForThread.has(threadId)) folderIdForThread.set(threadId, folder.id);
    }
  }
  for (const thread of input.threads) {
    const folderId = folderIdForThread.get(thread.id);
    if (folderId === undefined) {
      ungrouped.push(thread);
      continue;
    }
    (membersByFolderId.get(folderId) ?? membersByFolderId.set(folderId, []).get(folderId)!).push(
      thread,
    );
  }
  const views: ThreadFolderView<TThread>[] = [];
  const visit = (nodes: ReadonlyArray<ThreadFolderNode>) => {
    for (const node of nodes) {
      const threads = membersByFolderId.get(node.folder.id) ?? [];
      views.push({
        key: node.folder.id,
        projectKey: "",
        folder: node.folder,
        depth: node.depth,
        threads,
        workingCount:
          input.workingThreadIds === undefined
            ? 0
            : node.folder.threadIds.filter((id) => input.workingThreadIds!.has(id)).length,
      });
      visit(node.children);
    }
  };
  visit(buildThreadFolderTree(input.folders));
  return { ungrouped, views };
}

/**
 * Assignments to move one folder up or down among its displayed siblings,
 * with the same single-write-per-move semantics as pinned threads. Null at
 * the ends of the sibling list. Callers issue one `threadFolder.reorder`
 * command per assignment.
 */
export function planThreadFolderReorder(input: {
  /** The project's full folder list (the authoritative server state). */
  readonly folders: readonly ThreadFolder[];
  readonly movedId: ThreadFolderId;
  readonly direction: "up" | "down";
}): ReadonlyArray<{ readonly folderId: ThreadFolderId; readonly orderKey: string }> | null {
  const moved = input.folders.find((folder) => folder.id === input.movedId);
  if (moved === undefined) return null;
  const siblings = sortThreadFolders(
    input.folders.filter((folder) => folder.parentId === moved.parentId),
  );
  const assignments = planPinnedMove({
    orderedIds: siblings.map((folder) => folder.id),
    keysById: new Map(siblings.map((folder) => [folder.id, folder.orderKey])),
    movedId: input.movedId,
    direction: input.direction,
  });
  if (assignments === null) return null;
  return assignments.map((assignment) => ({
    folderId: assignment.id as ThreadFolderId,
    orderKey: assignment.orderKey,
  }));
}

/** Scoped project key: thread and folder ids are only unique per environment. */
export function threadFolderProjectKey(environmentId: string, projectId: string): string {
  return JSON.stringify([environmentId, projectId]);
}

/** Folder view state must include the authoritative environment and project. */
export function threadFolderViewKey(projectKey: string, folderId: string): string {
  return JSON.stringify([projectKey, folderId]);
}

/** Working counts and membership claims use the full thread location. */
export function threadFolderThreadKey(thread: {
  readonly environmentId: string;
  readonly projectId: string;
  readonly id: string;
}): string {
  return threadFolderViewKey(
    threadFolderProjectKey(thread.environmentId, thread.projectId),
    thread.id,
  );
}

/** 1-based nesting depth of one folder; a corrupt parent chain counts only
    what is walkable, so a cycle can never loop this forever. */
export function threadFolderDepth(folders: readonly ThreadFolderLike[], folderId: string): number {
  const byId = new Map<string, ThreadFolderLike>(
    folders.map((folder) => [folder.id as string, folder]),
  );
  let depth = 1;
  let current = byId.get(folderId);
  const seen = new Set<string>([folderId]);
  while (current !== undefined && current.parentId !== null && !seen.has(current.parentId)) {
    seen.add(current.parentId);
    current = byId.get(current.parentId);
    depth += 1;
  }
  return depth;
}

/**
 * `groupThreadsByFolder` across every project at once: each thread is grouped
 * by the folders of its own environment-qualified project, and the views
 * render in the folder map's project order, then depth-first within it. The
 * ungrouped rest keeps the caller's order regardless of which project each
 * thread belongs to. A project with no folders contributes no views.
 */
export function groupThreadsByProjectFolders<
  TThread extends {
    readonly id: string;
    readonly projectId: string;
    readonly environmentId: string;
  },
>(input: {
  readonly foldersByProjectKey: ReadonlyMap<string, readonly ThreadFolder[]>;
  readonly threads: readonly TThread[];
  readonly workingThreadIds?: ReadonlySet<string>;
}): ThreadFolderGrouping<TThread> {
  const threadsByProjectKey = new Map<string, TThread[]>();
  for (const thread of input.threads) {
    const key = threadFolderProjectKey(thread.environmentId, thread.projectId);
    (threadsByProjectKey.get(key) ?? threadsByProjectKey.set(key, []).get(key)!).push(thread);
  }
  const claimed = new Set<string>();
  const views: ThreadFolderView<TThread>[] = [];
  for (const [projectKey, folders] of input.foldersByProjectKey) {
    if (folders.length === 0) continue;
    const grouping = groupThreadsByFolder({
      folders,
      threads: threadsByProjectKey.get(projectKey) ?? [],
      ...(input.workingThreadIds === undefined
        ? {}
        : {
            workingThreadIds: new Set(
              folders
                .flatMap((folder) => folder.threadIds)
                .filter((id) => input.workingThreadIds!.has(threadFolderViewKey(projectKey, id))),
            ),
          }),
    });
    for (const view of grouping.views) {
      for (const thread of view.threads) claimed.add(threadFolderThreadKey(thread));
      views.push({ ...view, projectKey, key: threadFolderViewKey(projectKey, view.folder.id) });
    }
  }
  return {
    ungrouped: input.threads.filter((thread) => !claimed.has(threadFolderThreadKey(thread))),
    views,
  };
}

export interface CollapsedFolderView<TThread> {
  readonly view: ThreadFolderView<TThread>;
  /** Member rows the sidebar renders under this header: all of them while
      expanded, only kept-visible ones while collapsed. */
  readonly visibleThreads: readonly TThread[];
}

export interface FolderCollapsedGrouping<TThread> {
  /** Threads that belong to no folder, unchanged from the grouping. */
  readonly ungrouped: ReadonlyArray<TThread>;
  /** Visible headers only. Collapsed ancestors hide descendant headers except
      the ancestry needed to retain a caller-selected route row. */
  readonly views: ReadonlyArray<CollapsedFolderView<TThread>>;
  /** `ungrouped` followed by every view's visible rows, in render order. */
  readonly visibleThreads: ReadonlyArray<TThread>;
}

/**
 * Apply sidebar collapse flags to a folder grouping. A collapsed folder hides
 * subtree except the ancestry and rows the caller keeps visible. A visible
 * collapsed header aggregates activity from its descendants.
 */
export function applyFolderCollapse<TThread extends { readonly id: string }>(input: {
  readonly grouping: ThreadFolderGrouping<TThread>;
  /** Collapse flags by qualified view key; absent or false means expanded. */
  readonly collapsedById: Readonly<Record<string, boolean | undefined>>;
  readonly keepVisible?: (thread: TThread) => boolean;
}): FolderCollapsedGrouping<TThread> {
  const views: CollapsedFolderView<TThread>[] = [];
  const ancestors: { view: ThreadFolderView<TThread>; blocked: boolean }[] = [];
  const allViews = input.grouping.views;
  for (let index = 0; index < allViews.length; index += 1) {
    const view = allViews[index]!;
    while (
      ancestors.length > 0 &&
      (ancestors.at(-1)!.view.projectKey !== view.projectKey ||
        ancestors.at(-1)!.view.depth >= view.depth)
    )
      ancestors.pop();
    const blocked = ancestors.at(-1)?.blocked === true;
    const collapsed = input.collapsedById[view.key] === true;
    // Keep just the route's ancestry and route row through a collapsed branch.
    let routeInSubtree = view.threads.some((thread) => input.keepVisible?.(thread));
    let subtreeWorkingCount = view.workingCount;
    for (let next = index + 1; next < allViews.length; next += 1) {
      const descendant = allViews[next]!;
      if (descendant.projectKey !== view.projectKey || descendant.depth <= view.depth) break;
      subtreeWorkingCount += descendant.workingCount;
      routeInSubtree ||= descendant.threads.some((thread) => input.keepVisible?.(thread));
    }
    if (!blocked || routeInSubtree) {
      views.push({
        view: collapsed ? { ...view, workingCount: subtreeWorkingCount } : view,
        visibleThreads:
          blocked || collapsed
            ? view.threads.filter((thread) => input.keepVisible?.(thread))
            : view.threads,
      });
    }
    ancestors.push({ view, blocked: blocked || collapsed });
  }
  return {
    ungrouped: input.grouping.ungrouped,
    views,
    visibleThreads: [
      ...input.grouping.ungrouped,
      ...views.flatMap((entry) => entry.visibleThreads),
    ],
  };
}

/** Legal destinations for an existing subtree, in deterministic display order. */
export function threadFolderMoveTargets(folders: readonly ThreadFolder[], movedId: ThreadFolderId) {
  const moved = folders.find((folder) => folder.id === movedId);
  if (moved === undefined) return [];
  const flattened: { folder: ThreadFolder; depth: number }[] = [];
  const visit = (nodes: readonly ThreadFolderNode[]) => {
    for (const node of nodes) {
      flattened.push(node);
      visit(node.children);
    }
  };
  visit(buildThreadFolderTree(folders));
  const start = flattened.findIndex((node) => node.folder.id === movedId);
  const descendants = new Set<ThreadFolderId>([movedId]);
  let height = 1;
  for (let index = start + 1; index < flattened.length; index += 1) {
    const node = flattened[index]!;
    if (node.depth <= flattened[start]!.depth) break;
    descendants.add(node.folder.id);
    height = Math.max(height, node.depth - flattened[start]!.depth + 1);
  }
  return [
    { parentId: null, title: "Project root", depth: 0 },
    ...flattened
      .filter(
        (node) =>
          !descendants.has(node.folder.id) && node.depth + height <= MAX_THREAD_FOLDER_DEPTH,
      )
      .map((node) => ({
        parentId: node.folder.id,
        title: node.folder.title,
        depth: node.depth,
      })),
  ].filter((target) => target.parentId !== moved.parentId);
}
