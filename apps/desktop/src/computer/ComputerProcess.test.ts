import * as NodeAssert from "node:assert/strict";
import * as NodeEvents from "node:events";
import { afterEach, assert, beforeEach, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

const fork = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ fork }));
import { startComputerProcess } from "./ComputerProcess.ts";
import { ComputerAccessHost } from "./ComputerAccessHost.ts";

function makeWorker() {
  return Object.assign(new NodeEvents.EventEmitter(), { send: vi.fn(), kill: vi.fn() });
}
let worker = makeWorker();
const grant = {
  owner: "session-a",
  processId: 42,
  application: "Test App",
  expiresAt: 100_000,
  readOnly: false,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  worker = makeWorker();
  fork.mockReset().mockReturnValue(worker);
});
afterEach(() => vi.useRealTimers());

async function initialize() {
  const process = startComputerProcess("/owned/ComputerWorker.cjs", grant);
  worker.emit("message", { ready: true });
  await Promise.resolve();
  const init = worker.send.mock.calls[0]?.[0];
  assert.equal(init.kind, "init");
  worker.emit("message", { id: init.id, ok: true });
  return process;
}

it("a worker deadline rejects the operation and kills only its owned child", async () => {
  const process = await initialize();
  const pending = process.inspect();
  const rejected = NodeAssert.rejects(pending, /stopped/);
  await vi.advanceTimersByTimeAsync(8_000);
  await rejected;
  assert.deepEqual(worker.kill.mock.calls, [["SIGKILL"]]);
  process.close();
  assert.equal(worker.kill.mock.calls.length, 1);
});

it("revocation before worker readiness never dispatches a native request", async () => {
  const process = startComputerProcess("/owned/ComputerWorker.cjs", grant);
  process.close();
  worker.emit("message", { ready: true });
  await NodeAssert.rejects(process.inspect(), /stopped/);
  assert.equal(worker.send.mock.calls.length, 0);
  assert.equal(worker.kill.mock.calls.length, 1);
});

it("worker crash rejects pending input without retrying it", async () => {
  const process = await initialize();
  const dispatched = Promise.withResolvers<void>();
  worker.send.mockImplementationOnce(() => dispatched.resolve());
  const pending = process.act("snapshot", { kind: "press", element: 0 });
  const rejected = NodeAssert.rejects(pending, /stopped/);
  await dispatched.promise;
  worker.emit("exit", 1);
  await rejected;
  assert.equal(worker.send.mock.calls.length, 2);
});

it("grant expiry stops an idle worker", async () => {
  const process = await initialize();
  await vi.advanceTimersByTimeAsync(99_000);
  await NodeAssert.rejects(process.inspect(), /stopped/);
  assert.equal(worker.kill.mock.calls.length, 1);
});

it("rejects invalid native results instead of forwarding them", async () => {
  const process = await initialize();
  const dispatched = Promise.withResolvers<void>();
  worker.send.mockImplementationOnce(() => dispatched.resolve());
  const pending = process.inspect();
  const rejected = NodeAssert.rejects(pending, /stopped/);
  await dispatched.promise;
  worker.emit("message", { id: 123, unexpected: "native failure" });
  await rejected;
  assert.equal(worker.kill.mock.calls.length, 1);
});

it("worker environment does not inherit provider credentials or launch options", () => {
  vi.stubEnv("OPENAI_API_KEY", "test-only-placeholder");
  vi.stubEnv("NODE_OPTIONS", "--test-only-placeholder");
  const process = startComputerProcess("/owned/ComputerWorker.cjs", grant);
  try {
    const options = fork.mock.calls[0]?.[2];
    assert.deepEqual(Object.keys(options.env).sort(), ["ELECTRON_RUN_AS_NODE", "HOME", "PATH"]);
    assert.deepEqual(options.execArgv, []);
  } finally {
    process.close();
    vi.unstubAllEnvs();
  }
});

it("identity-only workers cannot inspect or act before local approval", async () => {
  const process = startComputerProcess("/owned/ComputerWorker.cjs");
  try {
    await NodeAssert.rejects(process.inspect(), /needs a grant/);
    await NodeAssert.rejects(
      process.act("snapshot", { kind: "press", element: 0 }),
      /needs a grant/,
    );
    assert.equal(worker.send.mock.calls.length, 0);
  } finally {
    process.close();
  }
});

it("native initialization failure reaches the host and releases its exclusive grant", async () => {
  const started = Promise.withResolvers<void>();
  const revoked = Promise.withResolvers<void>();
  const changed = vi.fn((value) => {
    if (value === undefined) revoked.resolve();
  });
  const host = new ComputerAccessHost({
    resolveApplication: async () => ({ processId: 42, application: "Test App" }),
    approve: async () => true,
    start: (approved) => {
      const child = startComputerProcess("/owned/ComputerWorker.cjs", approved);
      started.resolve();
      return child;
    },
    changed,
    now: () => 1_000,
  });
  const request = {
    id: "request",
    invocation: { owner: "session-a", threadTitle: "Thread", readOnly: false },
    command: { kind: "requestAccess" as const, application: "Test App" },
  };
  try {
    await host.handle(request);
    await started.promise;
    worker.emit("message", { ready: true });
    await Promise.resolve();
    const init = worker.send.mock.calls[0]?.[0];
    worker.emit("message", { id: init.id, ok: false, reason: "worker-failed" });
    await revoked.promise;
    assert.isFalse(changed.mock.calls.some(([value]) => value !== undefined));
    assert.deepEqual((await host.handle({ ...request, command: { kind: "status" } })).result, {
      kind: "unavailable",
      reason: "denied",
    });
    assert.equal(worker.kill.mock.calls.length, 1);
    const next = { ...request, invocation: { ...request.invocation, owner: "session-b" } };
    assert.equal((await host.handle(next)).result.kind, "pending");
  } finally {
    host.close();
  }
});
