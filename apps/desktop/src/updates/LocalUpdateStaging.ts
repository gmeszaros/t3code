// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Native staging boundary streams the archive to disk; synchronous apply runs before the application runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

const runFile = NodeUtil.promisify(NodeChildProcess.execFile);

const MARKER = "local-update-pending.json";
const PREFIX = ".t3-local-update-";
const APP_NAME = "T3 Code (Local).app";
const VERSION = /^\d+\.\d+\.\d+-local\.\d+\.\d+$/;

export interface PendingLocalUpdate {
  appPath: string;
  stagingRoot: string;
  fromVersion: string;
  version: string;
  sourceSha: string;
  error?: string;
}

export function readPendingLocalUpdate(
  baseDir: string,
  appPath: string,
): PendingLocalUpdate | null {
  const file = NodePath.join(baseDir, MARKER);
  if (!NodeFS.existsSync(file)) return null;
  const pending: PendingLocalUpdate = JSON.parse(NodeFS.readFileSync(file, "utf8"));
  if (
    pending.appPath !== appPath ||
    NodePath.dirname(pending.stagingRoot) !== NodePath.dirname(appPath) ||
    !NodePath.basename(pending.stagingRoot).startsWith(PREFIX) ||
    !VERSION.test(pending.version) ||
    !VERSION.test(pending.fromVersion) ||
    !/^[a-f0-9]{40}$/.test(pending.sourceSha)
  )
    throw new Error("Invalid pending Local update");
  return pending;
}

export function localAppPath(resourcesPath: string): string {
  return NodePath.resolve(resourcesPath, "../..");
}

function verifyLocalBundle(appPath: string, version: string, sourceSha?: string): void {
  const plist = (key: string) =>
    NodeChildProcess.execFileSync(
      "/usr/libexec/PlistBuddy",
      ["-c", `Print :${key}`, NodePath.join(appPath, "Contents/Info.plist")],
      { encoding: "utf8", timeout: 30_000 },
    ).trim();
  if (
    plist("CFBundleIdentifier") !== "com.t3tools.t3code.local" ||
    plist("CFBundleShortVersionString") !== version
  )
    throw new Error("Local bundle identity mismatch");
  NodeChildProcess.execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], {
    timeout: 120_000,
  });
  if (sourceSha) {
    // Electron's filesystem reads files inside asar without unpacking the application.
    const metadata = JSON.parse(
      NodeFS.readFileSync(
        NodePath.join(appPath, "Contents/Resources/app.asar/package.json"),
        "utf8",
      ),
    );
    if (
      metadata.t3codeLocalBuild !== true ||
      metadata.version !== version ||
      metadata.t3codeCommitHash !== sourceSha
    )
      throw new Error("Local bundle revision mismatch");
  }
}

export function applyPendingLocalUpdate(
  baseDir: string,
  appPath: string,
  currentVersion: string,
  verify = verifyLocalBundle,
): boolean {
  const pending = readPendingLocalUpdate(baseDir, appPath);
  if (!pending) return false;
  try {
    if (pending.fromVersion !== currentVersion)
      throw new Error("Installed app changed after staging");
    const staged = NodePath.join(pending.stagingRoot, APP_NAME);
    const rollback = NodePath.join(pending.stagingRoot, "previous.app");
    verify(staged, pending.version, pending.sourceSha);
    verify(appPath, currentVersion);
    if (NodeFS.existsSync(rollback)) throw new Error("Update rollback already exists");
    NodeFS.renameSync(appPath, rollback);
    try {
      NodeFS.renameSync(staged, appPath);
      // The moved archive is unchanged; avoid Electron's cached asar at the old app path.
      verify(appPath, pending.version);
      NodeFS.unlinkSync(NodePath.join(baseDir, MARKER));
    } catch (error) {
      if (NodeFS.existsSync(appPath)) NodeFS.renameSync(appPath, staged);
      NodeFS.renameSync(rollback, appPath);
      throw error;
    }
    // Retain the previous bundle for recovery, outside the installed application.
    return true;
  } catch (error) {
    NodeFS.writeFileSync(
      NodePath.join(baseDir, MARKER),
      JSON.stringify({
        ...pending,
        error: error instanceof Error ? error.message : "Local installation failed",
      }),
      { mode: 0o600 },
    );
    throw error;
  }
}

export async function stageLocalUpdate(options: {
  baseDir: string;
  appPath: string;
  currentVersion: string;
  version: string;
  signal: AbortSignal;
}): Promise<void> {
  const { version, signal } = options;
  if (!VERSION.test(version)) throw new Error("Invalid Local version");
  if (NodePath.basename(options.appPath) !== APP_NAME)
    throw new Error("Unsupported Local app location");
  if (readPendingLocalUpdate(options.baseDir, options.appPath))
    throw new Error("A Local update is already staged");
  const stem = `T3-Code-Local-${version}-arm64`;
  const url = `https://github.com/gmeszaros/t3code/releases/download/v${version}/${stem}`;
  const response = await fetch(`${url}.build.json`, { signal });
  if (!response.ok) throw new Error("Could not download Local update manifest");
  const manifest = await response.json();
  if (
    manifest.version !== version ||
    manifest.appId !== "com.t3tools.t3code.local" ||
    manifest.platform !== "darwin" ||
    manifest.arch !== "arm64" ||
    manifest.archive !== `${stem}.zip` ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
    !/^[a-f0-9]{40}$/.test(manifest.sourceSha)
  )
    throw new Error("Invalid Local update manifest");
  const root = NodeFS.mkdtempSync(NodePath.join(NodePath.dirname(options.appPath), PREFIX));
  let committed = false;
  try {
    const archive = NodePath.join(root, "update.zip");
    const download = await fetch(`${url}.zip`, { signal });
    if (!download.ok || !download.body) throw new Error("Could not download Local update archive");
    const hash = NodeCrypto.createHash("sha256");
    let received = 0;
    const file = await NodeFS.promises.open(archive, "wx", 0o600);
    const reader = download.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > 512 * 1024 * 1024)
          throw new Error("Local update archive exceeds size limit");
        hash.update(value);
        await file.writeFile(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      await file.close();
    }
    if (hash.digest("hex") !== manifest.sha256) throw new Error("Local update checksum mismatch");
    signal.throwIfAborted();
    await runFile("/usr/bin/ditto", ["-x", "-k", archive, root], { timeout: 120_000, signal });
    const staged = NodePath.join(root, APP_NAME);
    await runFile("/usr/bin/codesign", ["--verify", "--deep", "--strict", staged], {
      timeout: 120_000,
      signal,
    });
    const readPlist = async (key: string) =>
      (
        await runFile(
          "/usr/libexec/PlistBuddy",
          ["-c", `Print :${key}`, NodePath.join(staged, "Contents/Info.plist")],
          { timeout: 30_000, signal },
        )
      ).stdout.trim();
    if (
      (await readPlist("CFBundleIdentifier")) !== "com.t3tools.t3code.local" ||
      (await readPlist("CFBundleShortVersionString")) !== version
    )
      throw new Error("Local bundle identity mismatch");
    const metadata = JSON.parse(
      NodeFS.readFileSync(
        NodePath.join(staged, "Contents/Resources/app.asar/package.json"),
        "utf8",
      ),
    );
    if (
      metadata.t3codeLocalBuild !== true ||
      metadata.version !== version ||
      metadata.t3codeCommitHash !== manifest.sourceSha
    )
      throw new Error("Local bundle revision mismatch");
    signal.throwIfAborted();
    NodeFS.unlinkSync(archive);
    NodeFS.mkdirSync(options.baseDir, { recursive: true });
    const pending: PendingLocalUpdate = {
      appPath: options.appPath,
      stagingRoot: root,
      fromVersion: options.currentVersion,
      version,
      sourceSha: manifest.sourceSha,
    };
    const marker = NodePath.join(options.baseDir, MARKER);
    NodeFS.writeFileSync(`${marker}.tmp`, JSON.stringify(pending), { mode: 0o600 });
    NodeFS.renameSync(`${marker}.tmp`, marker);
    committed = true;
  } finally {
    if (!committed) await NodeFS.promises.rm(root, { recursive: true, force: true });
  }
}
