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

test("mirrors exact upstream commits and workflows without changing Local history", (t) => {
  const f = fixture(t);
  const initialRun = f.run();
  NodeAssert.equal(initialRun.status, 0, initialRun.stderr);
  const latest = git(f.upstream, "rev-parse", "HEAD");
  const first = git(f.destination, "rev-parse", "upstream/main");
  NodeAssert.equal(first, latest);
  NodeAssert.equal(
    git(f.destination, "show", `${first}:.github/workflows/ci.yml`),
    "name: Preserved workflow",
  );
  NodeAssert.equal(git(f.destination, "show", `${first}:source.txt`), "Upstream source");
  NodeAssert.equal(git(f.destination, "rev-list", "--count", first), "2");
  NodeAssert.equal(git(f.destination, "rev-parse", "main"), f.customSha);
  NodeAssert.match(NodeFS.readFileSync(f.output, "utf8"), /changed=true/);
  git(f.upstream, "commit", "--allow-empty", "-m", "Another upstream update");
  NodeAssert.equal(f.run().status, 0);
  const second = git(f.destination, "rev-parse", "upstream/main");
  NodeAssert.equal(git(f.destination, "rev-parse", `${second}^`), first);
  NodeAssert.equal(second, git(f.upstream, "rev-parse", "HEAD"));
  NodeAssert.equal(
    git(f.destination, "show", `${second}:.github/workflows/ci.yml`),
    "name: Preserved workflow",
  );
  NodeAssert.equal(f.run().status, 0);
  NodeAssert.match(NodeFS.readFileSync(f.output, "utf8"), /changed=false/);
  NodeAssert.equal(git(f.destination, "rev-parse", "upstream/main"), second);
  NodeAssert.equal(git(f.destination, "rev-parse", "main"), f.customSha);
});

test("preserves the mirror when upstream diverges or moves backwards", (t) => {
  const f = fixture(t);
  NodeAssert.equal(f.run().status, 0);
  const mirrored = git(f.destination, "rev-parse", "upstream/main");
  const divergent = NodePath.join(f.root, "divergent");
  NodeFS.mkdirSync(divergent);
  git(divergent, "init", "-b", "main");
  git(divergent, "commit", "--allow-empty", "-m", "Unrelated upstream");
  const failed = f.run(divergent);
  NodeAssert.notEqual(failed.status, 0);
  NodeAssert.match(failed.stderr, /history diverged or moved backwards/);
  NodeAssert.equal(git(f.destination, "rev-parse", "upstream/main"), mirrored);
  NodeAssert.notEqual(f.run(f.older).status, 0);
  NodeAssert.equal(git(f.destination, "rev-parse", "upstream/main"), mirrored);
  NodeAssert.equal(git(f.destination, "rev-parse", "main"), f.customSha);
});

test("preserves the historical snapshot branch during migration", (t) => {
  const f = fixture(t);
  git(f.destination, "update-ref", "refs/heads/upstream-snapshot", f.customSha);
  NodeAssert.equal(f.run().status, 0);
  NodeAssert.equal(git(f.destination, "rev-parse", "upstream-snapshot"), f.customSha);
  NodeAssert.equal(
    git(f.destination, "rev-parse", "upstream/main"),
    git(f.upstream, "rev-parse", "HEAD"),
  );
});
