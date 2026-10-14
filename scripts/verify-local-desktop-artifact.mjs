import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import { extractFile, listPackage } from "@electron/asar";
import Plist from "plist";

const [archiveArgument, expectedSha] = process.argv.slice(2);
NodeAssert.ok(
  archiveArgument && /^[a-f0-9]{40}$/.test(expectedSha ?? ""),
  "Usage: verify-local-desktop-artifact.mjs <zip> <source-sha>",
);
const archive = NodePath.resolve(archiveArgument);
NodeAssert.ok(archive.endsWith(".zip"), "The artifact must be a ZIP archive.");
const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-local-artifact-"));
try {
  NodeChildProcess.execFileSync("ditto", ["-x", "-k", archive, scratch]);
  const apps = NodeFS.readdirSync(scratch).filter((entry) => entry.endsWith(".app"));
  NodeAssert.deepEqual(apps, ["T3 Code (Local).app"]);
  const app = NodePath.join(scratch, apps[0]);
  const contents = NodePath.join(app, "Contents");
  const info = Plist.parse(NodeFS.readFileSync(NodePath.join(contents, "Info.plist"), "utf8"));
  NodeAssert.equal(info.CFBundleIdentifier, "com.t3tools.t3code.local");
  NodeAssert.deepEqual(
    info.CFBundleURLTypes.flatMap((type) => type.CFBundleURLSchemes),
    ["t3code-local"],
  );
  NodeAssert.ok(info.NSAppleEventsUsageDescription);
  NodeAssert.equal(
    NodeChildProcess.execFileSync(
      "lipo",
      ["-archs", NodePath.join(contents, "MacOS", info.CFBundleExecutable)],
      { encoding: "utf8" },
    ).trim(),
    "arm64",
  );
  NodeChildProcess.execFileSync("codesign", ["--verify", "--deep", "--strict", app]);
  const signing = NodeChildProcess.spawnSync("codesign", ["-d", "--verbose=4", app], {
    encoding: "utf8",
  });
  NodeAssert.equal(signing.status, 0);
  NodeAssert.match(signing.stderr, /flags=.*runtime/);
  NodeAssert.match(signing.stderr, /Signature=adhoc/);
  const entitlements = Plist.parse(
    NodeChildProcess.execFileSync("codesign", ["-d", "--entitlements", ":-", app], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  for (const key of ["automation.apple-events", "cs.allow-jit", "cs.disable-library-validation"]) {
    NodeAssert.equal(entitlements[`com.apple.security.${key}`], true);
  }
  const asar = NodePath.join(contents, "Resources", "app.asar");
  const metadata = JSON.parse(extractFile(asar, "package.json").toString());
  NodeAssert.equal(metadata.t3codeLocalBuild, true);
  NodeAssert.equal(metadata.t3codeCommitHash, expectedSha);
  const serverVersionOutput = NodeChildProcess.execFileSync(
    NodePath.join(contents, "MacOS", info.CFBundleExecutable),
    [NodePath.join(asar, "apps/server/dist/bin.mjs"), "--version"],
    {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        T3CODE_HOME: NodePath.join(scratch, "version-probe-home"),
      },
    },
  ).trim();
  NodeAssert.equal(serverVersionOutput, `t3 v${metadata.version}`);
  NodeAssert.equal(
    NodeFS.existsSync(NodePath.join(contents, "Resources", "app-update.yml")),
    false,
  );
  NodeAssert.equal(
    listPackage(asar).some((path) => /\/(auth\.json|settings\.json|statev2\.sqlite)$/.test(path)),
    false,
  );
  NodeAssert.equal(
    NodeFS.existsSync(
      NodePath.join(contents, "Resources", "resource-monitor", "t3-resource-monitor"),
    ),
    true,
  );

  // Execute the shipped boot code up to main, with a test environment, without starting a GUI or provider.
  const env = {};
  let enteredMain = false;
  NodeVM.runInNewContext(extractFile(asar, "apps/desktop/dist-electron/boot.cjs").toString(), {
    process: { env },
    exports: {},
    require(id) {
      if (id === "electron") return { app: { isPackaged: true } };
      if (id === "../../../package.json") return metadata;
      if (id === "node:os") return { homedir: () => "/test-user" };
      if (id === "node:path") return { join: NodePath.join };
      if (/^\.\/rolldown-runtime-[A-Za-z0-9_-]+\.cjs$/.test(id)) {
        const exports = {};
        NodeVM.runInNewContext(
          extractFile(asar, `apps/desktop/dist-electron/${id.slice(2)}`).toString(),
          { exports },
        );
        return exports;
      }
      if (id === "./compileCache.cjs") return {};
      if (id === "./main.cjs") {
        NodeAssert.equal(env.T3_LOCAL_BUILD, "1");
        NodeAssert.equal(env.T3CODE_HOME, "/test-user/.t3-zcode-test");
        NodeAssert.equal(env.T3CODE_PORT, "49883");
        enteredMain = true;
        return {};
      }
      throw new Error(`Unexpected boot dependency: ${id}`);
    },
  });
  NodeAssert.equal(enteredMain, true);
  const manifest = {
    sourceSha: expectedSha,
    integratedUpstreamSha: process.env.T3CODE_INTEGRATED_UPSTREAM_SHA ?? null,
    version: metadata.version,
    serverVersion: metadata.version,
    appId: info.CFBundleIdentifier,
    platform: "darwin",
    arch: "arm64",
    signing: "ad-hoc",
    notarized: false,
    archive: NodePath.basename(archive),
    sha256: NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(archive)).digest("hex"),
  };
  NodeFS.writeFileSync(
    archive.replace(/\.zip$/, ".build.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log("Local artifact signature, identity, profile bootstrap and revision verified.");
} finally {
  NodeFS.rmSync(scratch, { recursive: true, force: true });
}
