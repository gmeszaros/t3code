const NodeAssert = require("node:assert/strict");
const NodeChildProcess = require("node:child_process");
const NodeFS = require("node:fs");
const NodeOS = require("node:os");
const NodePath = require("node:path");
const { test } = require("node:test");

const script = NodePath.join(__dirname, "mirror-upstream.sh");
const git = (cwd, ...args) =>
  NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Pipeline Test",
      GIT_COMMITTER_NAME: "Pipeline Test",
      GIT_AUTHOR_EMAIL: "pipeline@example.invalid",
      GIT_COMMITTER_EMAIL: "pipeline@example.invalid",
    },
  }).trim();

function fixture(t) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-mirror-test-"));
  t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
  const upstream = NodePath.join(root, "upstream with spaces");
  const destination = NodePath.join(root, "destination");
  NodeFS.mkdirSync(upstream);
  git(upstream, "init", "-b", "main");
  NodeFS.mkdirSync(NodePath.join(upstream, ".github", "workflows"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(upstream, ".github", "workflows", "ci.yml"),
    "name: Preserved workflow\n",
  );
  NodeFS.writeFileSync(NodePath.join(upstream, "source.txt"), "Upstream source\n");
  git(upstream, "add", ".");
  git(upstream, "commit", "-m", "Initial upstream");
  const initial = git(upstream, "rev-parse", "HEAD");
  const older = NodePath.join(root, "older");
  git(root, "clone", "--bare", upstream, older);
  const custom = NodePath.join(root, "custom");
  git(root, "clone", upstream, custom);
  NodeFS.writeFileSync(NodePath.join(custom, "local.txt"), "Local feature\n");
  git(custom, "add", ".");
  git(custom, "commit", "-m", "Local modifications");
  const customSha = git(custom, "rev-parse", "HEAD");
  git(root, "clone", "--bare", custom, destination);
  git(destination, "update-ref", "refs/heads/upstream/main", initial);
  NodeFS.writeFileSync(NodePath.join(upstream, "source.txt"), "New upstream source\n");
  git(upstream, "add", ".");
  git(upstream, "commit", "-m", "Upstream update");
  const output = NodePath.join(root, "step-output");
  const run = (source = upstream, extraEnv = {}) =>
    NodeChildProcess.spawnSync("bash", [script, source, destination], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: output, ...extraEnv },
    });
  return { root, upstream, destination, initial, customSha, older, output, run };
}

test("tracks exact upstream and automatically rebases only Local commits", (t) => {
  const f = fixture(t);
  const result = f.run();
  NodeAssert.equal(result.status, 0, result.stderr);
  const latest = git(f.upstream, "rev-parse", "HEAD");
  const main = git(f.destination, "rev-parse", "main");
  NodeAssert.equal(git(f.destination, "rev-parse", "upstream/main"), latest);
  NodeAssert.equal(git(f.destination, "rev-parse", `${main}^`), latest);
  NodeAssert.equal(git(f.destination, "show", "main:local.txt"), "Local feature");
  NodeAssert.equal(git(f.destination, "show", "main:source.txt"), "New upstream source");
  NodeAssert.equal(
    git(f.destination, "show", "upstream/main:.github/workflows/ci.yml"),
    "name: Preserved workflow",
  );
  NodeAssert.equal(git(f.destination, "diff", "--name-only", "upstream/main...main"), "local.txt");
  NodeAssert.equal(
    git(f.destination, "rev-parse", `refs/tags/local-rebase/${f.customSha}`),
    f.customSha,
  );
  NodeAssert.match(NodeFS.readFileSync(f.output, "utf8"), /changed=true/);
  NodeAssert.equal(f.run().status, 0);
  NodeAssert.match(NodeFS.readFileSync(f.output, "utf8"), /changed=false/);
  NodeAssert.equal(git(f.destination, "rev-parse", "main"), main);

  NodeFS.writeFileSync(
    NodePath.join(f.upstream, ".github", "workflows", "ci.yml"),
    "name: Updated workflow\n",
  );
  git(f.upstream, "add", ".");
  git(f.upstream, "commit", "-m", "Update upstream workflow");
  NodeAssert.equal(f.run().status, 0);
  NodeAssert.equal(
    git(f.destination, "show", "main:.github/workflows/ci.yml"),
    "name: Updated workflow",
  );
  NodeAssert.equal(git(f.destination, "diff", "--name-only", "upstream/main...main"), "local.txt");
});

test("preserves both branches when upstream diverges or moves backwards", (t) => {
  const f = fixture(t);
  NodeAssert.equal(f.run().status, 0);
  const mirrored = git(f.destination, "rev-parse", "upstream/main");
  const main = git(f.destination, "rev-parse", "main");
  const divergent = NodePath.join(f.root, "divergent");
  NodeFS.mkdirSync(divergent);
  git(divergent, "init", "-b", "main");
  git(divergent, "commit", "--allow-empty", "-m", "Unrelated upstream");
  const failed = f.run(divergent);
  NodeAssert.notEqual(failed.status, 0);
  NodeAssert.match(failed.stderr, /history diverged or moved backwards/);
  NodeAssert.notEqual(f.run(f.older).status, 0);
  NodeAssert.equal(git(f.destination, "rev-parse", "upstream/main"), mirrored);
  NodeAssert.equal(git(f.destination, "rev-parse", "main"), main);
});

test("preserves both branches on a Local rebase conflict", (t) => {
  const f = fixture(t);
  NodeFS.writeFileSync(NodePath.join(f.upstream, "local.txt"), "Conflicting upstream feature\n");
  git(f.upstream, "add", ".");
  git(f.upstream, "commit", "-m", "Add conflicting upstream feature");
  const result = f.run();
  NodeAssert.notEqual(result.status, 0);
  NodeAssert.match(result.stderr, /Local rebase conflicted/);
  NodeAssert.equal(git(f.destination, "rev-parse", "main"), f.customSha);
  NodeAssert.equal(git(f.destination, "rev-parse", "upstream/main"), f.initial);
});

test("updates neither branch if the server rejects the atomic push", (t) => {
  const f = fixture(t);
  const hook = NodePath.join(f.destination, "hooks", "pre-receive");
  NodeFS.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const result = f.run();
  NodeAssert.notEqual(result.status, 0);
  NodeAssert.equal(git(f.destination, "rev-parse", "main"), f.customSha);
  NodeAssert.equal(git(f.destination, "rev-parse", "upstream/main"), f.initial);
  NodeAssert.equal(git(f.destination, "tag", "--list", "local-rebase/*"), "");
});

test("rejects merge commits in the Local patch series", (t) => {
  const f = fixture(t);
  const custom = NodePath.join(f.root, "custom");
  git(custom, "checkout", "-b", "feature", f.initial);
  NodeFS.writeFileSync(NodePath.join(custom, "feature.txt"), "Feature\n");
  git(custom, "add", ".");
  git(custom, "commit", "-m", "Feature");
  git(custom, "checkout", "main");
  git(custom, "merge", "--no-ff", "feature", "-m", "Merge feature");
  git(custom, "push", f.destination, "main");
  const main = git(f.destination, "rev-parse", "main");
  const result = f.run();
  NodeAssert.notEqual(result.status, 0);
  NodeAssert.match(result.stderr, /Local main contains merge commits/);
  NodeAssert.equal(git(f.destination, "rev-parse", "main"), main);
  NodeAssert.equal(git(f.destination, "rev-parse", "upstream/main"), f.initial);
});

test("preserves the historical snapshot branch during migration", (t) => {
  const f = fixture(t);
  git(f.destination, "update-ref", "refs/heads/upstream-snapshot", f.customSha);
  NodeAssert.equal(f.run().status, 0);
  NodeAssert.equal(git(f.destination, "rev-parse", "upstream-snapshot"), f.customSha);
});

test("rejects a stale main lease without advancing upstream", (t) => {
  const f = fixture(t);
  const custom = NodePath.join(f.root, "custom");
  git(custom, "commit", "--allow-empty", "-m", "Concurrent Local update");
  const concurrent = git(custom, "rev-parse", "HEAD");
  git(custom, "push", f.destination, "HEAD:refs/heads/concurrent-fixture");
  const bin = NodePath.join(f.root, "bin");
  NodeFS.mkdirSync(bin);
  const realGit = NodeChildProcess.execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  NodeFS.writeFileSync(
    NodePath.join(bin, "git"),
    `#!/bin/bash
for arg in "$@"; do
  if [ "$arg" = push ]; then
    "$REAL_GIT" -C "$RACE_DESTINATION" update-ref refs/heads/main "$RACE_MAIN_SHA"
    break
  fi
done
exec "$REAL_GIT" "$@"
`,
    { mode: 0o755 },
  );
  const result = f.run(f.upstream, {
    PATH: `${bin}:${process.env.PATH}`,
    REAL_GIT: realGit,
    RACE_DESTINATION: f.destination,
    RACE_MAIN_SHA: concurrent,
  });
  NodeAssert.notEqual(result.status, 0);
  NodeAssert.match(result.stderr, /stale info/);
  NodeAssert.equal(git(f.destination, "rev-parse", "main"), concurrent);
  NodeAssert.equal(git(f.destination, "rev-parse", "upstream/main"), f.initial);
  NodeAssert.equal(git(f.destination, "tag", "--list", "local-rebase/*"), "");
});
