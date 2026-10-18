import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ExecutionEnvironmentCapabilities } from "./environment.ts";
import { OrchestrationProjectShell } from "./orchestrationProject.ts";
import { ThreadFolder, ThreadFolderMutation } from "./threadFolder.ts";

const decodeMutation = Schema.decodeUnknownSync(ThreadFolderMutation);
const decodeShell = Schema.decodeUnknownSync(OrchestrationProjectShell);
const decodeCapabilities = Schema.decodeUnknownSync(ExecutionEnvironmentCapabilities);
const decodeFolder = Schema.decodeUnknownSync(ThreadFolder);

const folder = {
  id: "018f3c4e-0000-7000-8000-000000000001",
  parentId: null,
  title: "Research",
  orderKey: null,
  threadIds: ["018f3c4e-0000-7000-8000-00000000aaaa"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const shell = {
  id: "018f3c4e-0000-7000-8000-000000000002",
  title: "T3 Code",
  workspaceRoot: "/work/t3",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const commandBase = {
  commandId: "018f3c4e-0000-7000-8000-000000000003",
  projectId: "018f3c4e-0000-7000-8000-000000000002",
};

describe("ThreadFolder", () => {
  it("round trips through its wire schema", () => {
    expect(decodeFolder(folder)).toEqual(folder);
  });
});

describe("ThreadFolderMutation", () => {
  it("decodes every folder command variant", () => {
    expect(
      decodeMutation({
        type: "threadFolder.create",
        ...commandBase,
        folderId: folder.id,
        title: "New",
      }),
    ).toEqual({ type: "threadFolder.create", ...commandBase, folderId: folder.id, title: "New" });
    expect(
      decodeMutation({
        type: "threadFolder.move",
        ...commandBase,
        folderId: folder.id,
        parentId: null,
      }),
    ).toEqual({ type: "threadFolder.move", ...commandBase, folderId: folder.id, parentId: null });
    expect(
      decodeMutation({
        type: "threadFolder.placeThread",
        ...commandBase,
        threadId: folder.threadIds[0],
        folderId: null,
      }),
    ).toEqual({
      type: "threadFolder.placeThread",
      ...commandBase,
      threadId: folder.threadIds[0],
      folderId: null,
    });
  });

  it("accepts an optional parent on create and rejects blank titles and order keys", () => {
    expect(
      decodeMutation({
        type: "threadFolder.create",
        ...commandBase,
        folderId: folder.id,
        title: "Nested",
        parentId: folder.id,
      }).type,
    ).toBe("threadFolder.create");
    expect(() =>
      decodeMutation({
        type: "threadFolder.rename",
        ...commandBase,
        folderId: folder.id,
        title: "   ",
      }),
    ).toThrow();
    expect(() =>
      decodeMutation({
        type: "threadFolder.reorder",
        ...commandBase,
        folderId: folder.id,
        orderKey: "  ",
      }),
    ).toThrow();
  });
});

describe("thread folder version skew", () => {
  it("decodes shells from servers that predate folders", () => {
    const decoded = decodeShell(shell);
    expect(decoded.threadFolders).toBeUndefined();
  });

  it("decodes shells that carry folders and ignores fields it does not know", () => {
    const decoded = decodeShell({ ...shell, threadFolders: [folder], futureField: { any: true } });
    expect(decoded.threadFolders).toEqual([folder]);
  });

  it("lets the pre-folder project-shell decoder ignore additive hierarchy metadata", () => {
    const { threadFolders: _folders, ...legacyFields } = OrchestrationProjectShell.fields;
    const decodeLegacyShell = Schema.decodeUnknownSync(Schema.Struct(legacyFields));
    expect(decodeLegacyShell({ ...shell, threadFolders: [folder] })).toEqual(
      decodeLegacyShell(shell),
    );
  });

  it("treats a missing capability flag as unsupported folder organization", () => {
    expect(decodeCapabilities({}).threadFolders).toBeUndefined();
    expect(decodeCapabilities({ threadFolders: true }).threadFolders).toBe(true);
  });
});
