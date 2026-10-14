#!/usr/bin/env node
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeUtil from "node:util";
import * as NodeURL from "node:url";

const root = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const { values } = NodeUtil.parseArgs({
  options: {
    version: { type: "string" },
    "output-dir": { type: "string", default: "release-local" },
    "upstream-sha": { type: "string" },
  },
});
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone packager validates the real host before launching an Effect process.
NodeAssert.equal(NodeOS.platform(), "darwin", "Local packaging requires macOS.");
// oxlint-disable-next-line t3code/no-global-process-runtime -- The packaged native payload must match the real host architecture.
NodeAssert.equal(NodeOS.arch(), "arm64", "Local packaging requires Apple Silicon.");
const output = NodePath.resolve(root, values["output-dir"]);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.PATH = `${NodePath.dirname(process.execPath)}:${NodePath.join(root, "node_modules/.bin")}:${env.PATH}`;
Object.assign(env, {
  T3_LOCAL_BUILD: "1",
  T3CODE_DESKTOP_SIGNED: "false",
  CSC_IDENTITY_AUTO_DISCOVERY: "false",
});
const capture = (command, args) =>
  NodeChildProcess.execFileSync(command, args, { cwd: root, env, encoding: "utf8" }).trim();
const run = (script, args = []) =>
  NodeChildProcess.execFileSync(process.execPath, [script, ...args], {
    cwd: root,
    env,
    stdio: "inherit",
  });
NodeAssert.equal(
  capture("git", ["status", "--porcelain", "--untracked-files=normal"]),
  "",
  "Commit the reviewed source before packaging.",
);
const sha = capture("git", ["rev-parse", "HEAD"]);
let upstream = values["upstream-sha"];
if (!upstream) {
  capture("git", [
    "fetch",
    "--filter=blob:none",
    "--no-tags",
    "https://github.com/pingdotgg/t3code.git",
    "main",
  ]);
  upstream = capture("git", ["merge-base", "HEAD", "FETCH_HEAD"]);
}
NodeAssert.match(upstream, /^[a-f0-9]{40}$/);
capture("git", ["merge-base", "--is-ancestor", upstream, "HEAD"]);
const date = new Date().toISOString().replace(/[-:T]/g, "");
const metadata = capture(process.execPath, [
  "scripts/resolve-nightly-release.ts",
  "--date",
  date.slice(0, 8),
  "--run-number",
  "1",
  "--sha",
  sha,
]);
const base = /^base_version=(.+)$/m.exec(metadata)?.[1];
NodeAssert.ok(base, "Could not resolve the release base version.");
const version = values.version ?? `${base}-local.${date.slice(0, 8)}.${Number(date.slice(8, 14))}`;
NodeAssert.match(version, /^\d+\.\d+\.\d+-local\.\d+\.\d+$/);
NodeAssert.equal(
  NodeFS.existsSync(output) && NodeFS.readdirSync(output).some((name) => name.endsWith(".zip")),
  false,
  "Use an output directory without previous ZIP artifacts.",
);
env.T3CODE_DESKTOP_VERSION = version;
env.T3CODE_INTEGRATED_UPSTREAM_SHA = upstream;
const packages = ["apps/server", "apps/desktop", "apps/web", "packages/contracts"].map((name) =>
  NodePath.join(root, name, "package.json"),
);
const originals = packages.map((file) => NodeFS.readFileSync(file));
const envFile = NodePath.join(root, ".env");
const createdEnv = !NodeFS.existsSync(envFile);
console.log(`Building Local ${version} from ${sha}; upstream ${upstream}`);
try {
  if (createdEnv) NodeFS.copyFileSync(NodePath.join(root, ".env.example"), envFile);
  run("scripts/update-release-package-versions.ts", [version]);
  run("scripts/build-desktop-artifact.ts", [
    "--platform",
    "mac",
    "--arch",
    "arm64",
    "--target",
    "zip",
    "--output-dir",
    output,
  ]);
  const archives = NodeFS.readdirSync(output).filter((name) => name.endsWith(".zip"));
  NodeAssert.equal(archives.length, 1, "Expected exactly one Local ZIP.");
  run("scripts/verify-local-desktop-artifact.mjs", [NodePath.join(output, archives[0]), sha]);
  if (env.GITHUB_ENV)
    NodeFS.appendFileSync(
      env.GITHUB_ENV,
      `T3CODE_DESKTOP_VERSION=${version}\nT3CODE_INTEGRATED_UPSTREAM_SHA=${upstream}\n`,
    );
} finally {
  packages.forEach((file, index) => NodeFS.writeFileSync(file, originals[index]));
  if (createdEnv) NodeFS.unlinkSync(envFile);
}
