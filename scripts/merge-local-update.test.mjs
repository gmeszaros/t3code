import { it } from "vite-plus/test";
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { mergeLocalUpdate } from "./merge-local-update.mjs";

function fixture(run) {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "local-update-test-"));
  const git = (...args) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const commit = (file, content) => {
    NodeFS.writeFileSync(NodePath.join(cwd, file), content);
    git("add", file);
    git("commit", "-m", content);
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    const baseSha = commit("shared", "base\n");
    git("switch", "-c", "local");
    const localSha = commit("feature", "local feature\n");
    git("switch", "main");
    const upstreamSha = commit("upstream", "upstream change\n");
    git("switch", "local");
    run({ cwd, git, commit, baseSha, localSha, upstreamSha });
  } finally {
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
}

it("merges upstream while retaining Local commit identities without changing either published branch", () =>
  fixture((f) => {
    const result = mergeLocalUpdate(f);
    NodeAssert.equal(f.git("rev-parse", "local"), f.localSha);
    NodeAssert.equal(f.git("rev-parse", "main"), f.upstreamSha);
    NodeAssert.equal(f.git("show", `${result}:feature`), "local feature");
    NodeAssert.equal(f.git("show", `${result}:upstream`), "upstream change");
    NodeAssert.equal(f.git("rev-parse", `${result}^`), f.localSha);
    NodeAssert.equal(f.git("rev-parse", `${result}^2`), f.upstreamSha);
  }));

it("conflicts abort and restore the original detached source", () =>
  fixture((f) => {
    const localSha = f.commit("shared", "local conflict\n");
    f.git("switch", "main");
    const upstreamSha = f.commit("shared", "upstream conflict\n");
    f.git("switch", "local");
    NodeAssert.throws(() => mergeLocalUpdate({ ...f, localSha, upstreamSha }));
    NodeAssert.equal(f.git("rev-parse", "HEAD"), localSha);
    NodeAssert.equal(f.git("status", "--porcelain"), "");
  }));

it("rejects downgrades and unchanged upstream", () =>
  fixture((f) => {
    NodeAssert.throws(() =>
      mergeLocalUpdate({ ...f, baseSha: f.upstreamSha, upstreamSha: f.baseSha }),
    );
    NodeAssert.throws(() => mergeLocalUpdate({ ...f, upstreamSha: f.baseSha }), /No newer/);
    NodeAssert.equal(f.git("rev-parse", "HEAD"), f.localSha);
  }));

it("preserves dirty work", () =>
  fixture((f) => {
    NodeFS.writeFileSync(NodePath.join(f.cwd, "untracked"), "keep");
    NodeAssert.throws(() => mergeLocalUpdate(f), /clean/);
    NodeAssert.equal(f.git("status", "--porcelain"), "?? untracked");
  }));

it("candidate bundle transports the exact source without executing it", () =>
  fixture((f) => {
    const result = mergeLocalUpdate(f);
    f.git("update-ref", "refs/heads/update-candidate", result);
    f.git("bundle", "create", "source.bundle", "refs/heads/update-candidate");
    f.git("init", "verification");
    f.git("-C", "verification", "fetch", "../source.bundle", "refs/heads/update-candidate");
    NodeAssert.equal(f.git("-C", "verification", "rev-parse", "FETCH_HEAD"), result);
    f.git("-C", "verification", "merge-base", "--is-ancestor", f.upstreamSha, result);
  }));

it("previous Local merges remain intact during the next update", () =>
  fixture((f) => {
    f.git("switch", "-c", "side", f.localSha);
    f.commit("side", "side change\n");
    f.git("switch", "local");
    f.commit("mainline", "mainline change\n");
    f.git("merge", "--no-ff", "side", "-m", "merge fixture");
    const localSha = f.git("rev-parse", "HEAD");
    const result = mergeLocalUpdate({ ...f, localSha });
    f.git("merge-base", "--is-ancestor", localSha, result);
    NodeAssert.equal(f.git("show", `${result}:side`), "side change");
    NodeAssert.equal(f.git("show", `${result}:mainline`), "mainline change");
  }));
