#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

// Operates only on a disposable, clean checkout. Published branches are never rewritten.
export function mergeLocalUpdate({ cwd, localSha, baseSha, upstreamSha }) {
  const git = (...args) =>
    NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  for (const sha of [localSha, baseSha, upstreamSha]) {
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Expected a full commit SHA");
    git("cat-file", "-e", `${sha}^{commit}`);
  }
  if (git("status", "--porcelain")) throw new Error("Checkout must be clean");
  if (git("rev-parse", "HEAD") !== localSha) throw new Error("Checkout must match Local source");
  git("merge-base", "--is-ancestor", baseSha, localSha);
  git("merge-base", "--is-ancestor", baseSha, upstreamSha);
  if (baseSha === upstreamSha) throw new Error("No newer upstream release to integrate");
  git("switch", "--detach", localSha);
  try {
    git(
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "rerere.enabled=false",
      "merge",
      "--no-ff",
      "--no-edit",
      upstreamSha,
    );
  } catch (error) {
    git("merge", "--abort");
    throw error;
  }
  git("merge-base", "--is-ancestor", upstreamSha, "HEAD");
  git("merge-base", "--is-ancestor", localSha, "HEAD");
  return git("rev-parse", "HEAD");
}

if (import.meta.main) {
  const { values } = NodeUtil.parseArgs({
    options: {
      local: { type: "string" },
      base: { type: "string" },
      upstream: { type: "string" },
    },
  });
  console.log(
    mergeLocalUpdate({
      cwd: process.cwd(),
      localSha: values.local,
      baseSha: values.base,
      upstreamSha: values.upstream,
    }),
  );
}
