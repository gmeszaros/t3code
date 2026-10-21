// @effect-diagnostics nodeBuiltinImport:off - Exercises the real filesystem swap and rollback boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  applyPendingLocalUpdate,
  readPendingLocalUpdate,
  stageLocalUpdate,
} from "./LocalUpdateStaging.ts";

function fixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "local-update-test-"));
  const app = NodePath.join(root, "T3 Code (Local).app");
  const staging = NodePath.join(root, ".t3-local-update-test");
  const stagedApp = NodePath.join(staging, "T3 Code (Local).app");
  const base = NodePath.join(root, "profile");
  NodeFS.mkdirSync(app);
  NodeFS.writeFileSync(NodePath.join(app, "revision"), "old");
  NodeFS.mkdirSync(stagedApp, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(stagedApp, "revision"), "new");
  NodeFS.mkdirSync(base);
  const pending = {
    appPath: app,
    stagingRoot: staging,
    fromVersion: "0.1.2-local.1.1",
    version: "0.1.2-local.2.1",
    sourceSha: "a".repeat(40),
  };
  const marker = NodePath.join(base, "local-update-pending.json");
  NodeFS.writeFileSync(marker, JSON.stringify(pending));
  return {
    root,
    app,
    staging,
    stagedApp,
    base,
    marker,
    pending,
    [Symbol.dispose]() {
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("Local update application before session startup", () => {
  it("replaces the app only when explicitly applied and retains a rollback", () => {
    using f = fixture();
    expect(readPendingLocalUpdate(f.base, f.app)?.version).toBe(f.pending.version);
    expect(NodeFS.readFileSync(NodePath.join(f.app, "revision"), "utf8")).toBe("old");
    const verified: string[] = [];
    expect(
      applyPendingLocalUpdate(f.base, f.app, f.pending.fromVersion, (path) => {
        verified.push(path);
      }),
    ).toBe(true);
    expect(verified).toEqual([f.stagedApp, f.app, f.app]);
    expect(NodeFS.readFileSync(NodePath.join(f.app, "revision"), "utf8")).toBe("new");
    expect(NodeFS.readFileSync(NodePath.join(f.staging, "previous.app/revision"), "utf8")).toBe(
      "old",
    );
    expect(applyPendingLocalUpdate(f.base, f.app, f.pending.version, () => {})).toBe(false);
  });

  it("leaves the app untouched on verification failure or a changed installed version", () => {
    using f = fixture();
    expect(() => applyPendingLocalUpdate(f.base, f.app, f.pending.version, () => {})).toThrow(
      "Installed app changed",
    );
    expect(() =>
      applyPendingLocalUpdate(f.base, f.app, f.pending.fromVersion, () => {
        throw new Error("bad signature");
      }),
    ).toThrow("bad signature");
    expect(NodeFS.readFileSync(NodePath.join(f.app, "revision"), "utf8")).toBe("old");
  });

  it("restores the old bundle if verification fails after replacement", () => {
    using f = fixture();
    let calls = 0;
    expect(() =>
      applyPendingLocalUpdate(f.base, f.app, f.pending.fromVersion, () => {
        if (++calls === 3) throw new Error("post-install failure");
      }),
    ).toThrow("post-install failure");
    expect(NodeFS.readFileSync(NodePath.join(f.app, "revision"), "utf8")).toBe("old");
    expect(NodeFS.existsSync(f.marker)).toBe(true);
  });

  it("rejects a marker pointing outside the app's staging directory", () => {
    using f = fixture();
    NodeFS.writeFileSync(
      f.marker,
      JSON.stringify({ ...f.pending, stagingRoot: NodePath.join(f.root, "unrelated") }),
    );
    expect(() => readPendingLocalUpdate(f.base, f.app)).toThrow("Invalid pending");
    expect(NodeFS.readFileSync(NodePath.join(f.app, "revision"), "utf8")).toBe("old");
  });
});

describe("Local update download integrity", () => {
  it("rejects corrupt downloads and removes all temporary staging files", async () => {
    using f = fixture();
    NodeFS.unlinkSync(f.marker);
    using fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            version: f.pending.version,
            appId: "com.t3tools.t3code.local",
            platform: "darwin",
            arch: "arm64",
            archive: `T3-Code-Local-${f.pending.version}-arm64.zip`,
            sha256: "0".repeat(64),
            sourceSha: f.pending.sourceSha,
          }),
        ),
      )
      .mockResolvedValueOnce(new Response("corrupt archive"));
    const before = NodeFS.readdirSync(f.root);
    await expect(
      stageLocalUpdate({
        baseDir: f.base,
        appPath: f.app,
        currentVersion: f.pending.fromVersion,
        version: f.pending.version,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("checksum mismatch");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(NodeFS.readdirSync(f.root)).toEqual(before);
    expect(NodeFS.existsSync(f.marker)).toBe(false);
    expect(NodeFS.readFileSync(NodePath.join(f.app, "revision"), "utf8")).toBe("old");
  });

  it("cleans the staging directory when the download connection fails", async () => {
    using f = fixture();
    NodeFS.unlinkSync(f.marker);
    using _fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            version: f.pending.version,
            appId: "com.t3tools.t3code.local",
            platform: "darwin",
            arch: "arm64",
            archive: `T3-Code-Local-${f.pending.version}-arm64.zip`,
            sha256: "0".repeat(64),
            sourceSha: f.pending.sourceSha,
          }),
        ),
      )
      .mockRejectedValueOnce(new Error("connection closed"));
    const before = NodeFS.readdirSync(f.root);
    await expect(
      stageLocalUpdate({
        baseDir: f.base,
        appPath: f.app,
        currentVersion: f.pending.fromVersion,
        version: f.pending.version,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("connection closed");
    expect(NodeFS.readdirSync(f.root)).toEqual(before);
    expect(NodeFS.existsSync(f.marker)).toBe(false);
  });
});
