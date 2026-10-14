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
    "name: Excluded workflow\n",
  );
  NodeFS.writeFileSync(NodePath.join(upstream, "source.txt"), "Upstream source\n");
  git(upstream, "add", ".");
  git(upstream, "commit", "-m", "Initial upstream");
  const initial = git(upstream, "rev-parse", "HEAD");
  const older = NodePath.join(root, "older");
  git(root, "clone", "--bare", upstream, older);
  const custom = NodePath.join(root, "custom");
  git(root, "clone", upstream, custom);
  git(custom, "commit", "--allow-empty", "-m", "Local modifications");
  const customSha = git(custom, "rev-parse", "HEAD");
  git(root, "clone", "--bare", custom, destination);
  git(upstream, "commit", "--allow-empty", "-m", "Upstream update");
  const output = NodePath.join(root, "step-output");
  const run = (source = upstream) =>
    NodeChildProcess.spawnSync("bash", [script, source, destination], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: output },
    });
  return { root, upstream, destination, initial, customSha, older, output, run };
}

test("creates filtered snapshots, advances only their branch, and skips unchanged upstream", (t) => {
  const f = fixture(t);
  const initialRun = f.run();
  NodeAssert.equal(initialRun.status, 0, initialRun.stderr);
  const latest = git(f.upstream, "rev-parse", "HEAD");
  const first = git(f.destination, "rev-parse", "upstream-snapshot");
  NodeAssert.notEqual(first, latest);
  NodeAssert.equal(git(f.destination, "ls-tree", first, ".github"), "");
  NodeAssert.equal(git(f.destination, "show", `${first}:source.txt`), "Upstream source");
  NodeAssert.match(
    git(f.destination, "log", "-1", "--format=%B", first),
    new RegExp(`Upstream-Commit: ${latest}`),
  );
  NodeAssert.equal(git(f.destination, "rev-list", "--count", first), "1");
  NodeAssert.equal(git(f.destination, "rev-parse", "main"), f.customSha);
  NodeAssert.match(NodeFS.readFileSync(f.output, "utf8"), /changed=true/);
  git(f.upstream, "commit", "--allow-empty", "-m", "Another upstream update");
  NodeAssert.equal(f.run().status, 0);
  const second = git(f.destination, "rev-parse", "upstream-snapshot");
  NodeAssert.equal(git(f.destination, "rev-parse", `${second}^`), first);
  NodeAssert.equal(git(f.destination, "ls-tree", second, ".github"), "");
  NodeAssert.match(
    git(f.destination, "log", "-1", "--format=%B", second),
    new RegExp(`Upstream-Commit: ${git(f.upstream, "rev-parse", "HEAD")}`),
  );
  NodeAssert.equal(f.run().status, 0);
  NodeAssert.match(NodeFS.readFileSync(f.output, "utf8"), /changed=false/);
  NodeAssert.equal(git(f.destination, "rev-parse", "upstream-snapshot"), second);
  NodeAssert.equal(git(f.destination, "rev-parse", "main"), f.customSha);
});

test("preserves the mirror when upstream diverges or moves backwards", (t) => {
  const f = fixture(t);
  NodeAssert.equal(f.run().status, 0);
  const mirrored = git(f.destination, "rev-parse", "upstream-snapshot");
  const divergent = NodePath.join(f.root, "divergent");
  NodeFS.mkdirSync(divergent);
  git(divergent, "init", "-b", "main");
  git(divergent, "commit", "--allow-empty", "-m", "Unrelated upstream");
  const failed = f.run(divergent);
  NodeAssert.notEqual(failed.status, 0);
  NodeAssert.match(failed.stderr, /history diverged or moved backwards/);
  NodeAssert.equal(git(f.destination, "rev-parse", "upstream-snapshot"), mirrored);
  NodeAssert.notEqual(f.run(f.older).status, 0);
  NodeAssert.equal(git(f.destination, "rev-parse", "upstream-snapshot"), mirrored);
  NodeAssert.equal(git(f.destination, "rev-parse", "main"), f.customSha);
});
