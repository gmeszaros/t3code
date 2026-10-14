import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import type { ComputerDesktopRequest } from "@t3tools/contracts";

import { ComputerAccessHost, type ComputerAccessHostOptions } from "./ComputerAccessHost.ts";

function setup() {
  const worker = {
    ready: Promise.resolve(),
    closed: new Promise<void>(() => undefined),
    inspect: vi.fn(async () => ({
      snapshotId: "snapshot",
      application: "Verified App",
      elements: [],
      truncated: false,
    })),
    act: vi.fn(async () => undefined),
    close: vi.fn(),
  };
  const options = {
    resolveApplication: vi.fn(async () => ({ processId: 42, application: "Verified App" })),
    approve: vi.fn<ComputerAccessHostOptions["approve"]>(async () => true),
    start: vi.fn(() => worker),
    changed: vi.fn<ComputerAccessHostOptions["changed"]>(),
    now: () => 1_000,
  };
  return { host: new ComputerAccessHost(options), options, worker };
}
const access: ComputerDesktopRequest = {
  id: "request",
  invocation: { owner: "session", threadTitle: "Thread", readOnly: false },
  command: { kind: "requestAccess", application: "requested name" },
};
const act: ComputerDesktopRequest = {
  ...access,
  command: { kind: "act", snapshotId: "snapshot", action: { kind: "press", element: 0 } },
};

it("requires local approval and displays the verified identity", async () => {
  const { host, options } = setup();
  options.approve.mockResolvedValue(false);
  assert.equal((await host.handle(access)).result.kind, "pending");
  assert.equal(
    (await host.handle({ ...access, command: { kind: "status" } })).result.kind,
    "unavailable",
  );
  assert.equal(options.start.mock.calls.length, 0);
  assert.equal(options.approve.mock.calls[0]?.[0]?.application, "Verified App");
});

it("Stop during a pending consent cannot be undone by a late Allow", async () => {
  const { host, options } = setup();
  const consent = Promise.withResolvers<boolean>();
  const opened = Promise.withResolvers<void>();
  options.approve.mockImplementation(() => {
    opened.resolve();
    return consent.promise;
  });
  const pending = host.handle(access);
  await opened.promise;
  host.stop();
  consent.resolve(true);
  assert.equal((await pending).result.kind, "pending");
  assert.equal(
    (await host.handle({ ...access, command: { kind: "status" } })).result.kind,
    "unavailable",
  );
  assert.equal(options.start.mock.calls.length, 0);
});

it("another session cannot control, stop, or replace an active grant", async () => {
  const { host, worker } = setup();
  await host.handle(access);
  const other = { ...access, invocation: { ...access.invocation, owner: "other" } };
  assert.equal((await host.handle(other)).result.kind, "unavailable");
  assert.equal((await host.handle({ ...other, command: act.command })).result.kind, "unavailable");
  await host.handle({ ...other, command: { kind: "stop" } });
  assert.equal(worker.close.mock.calls.length, 0);
  assert.equal((await host.handle(act)).result.kind, "completed");
  host.close();
});

it("Plan/read-only changes revoke an existing write grant", async () => {
  const { host, worker } = setup();
  await host.handle(access);
  const result = await host.handle({ ...act, invocation: { ...act.invocation, readOnly: true } });
  assert.deepEqual(result.result, { kind: "unavailable", reason: "read-only" });
  assert.equal(worker.close.mock.calls.length, 1);
  assert.equal(worker.act.mock.calls.length, 0);
  assert.equal((await host.handle(act)).result.kind, "unavailable");
});

it("an initial read-only grant cannot silently upgrade to write access", async () => {
  const { host, worker } = setup();
  await host.handle({ ...access, invocation: { ...access.invocation, readOnly: true } });
  assert.deepEqual((await host.handle(act)).result, { kind: "unavailable", reason: "read-only" });
  assert.equal(worker.act.mock.calls.length, 0);
  host.close();
});

it("backend disconnect closes the worker and rejects future grants", async () => {
  const { host, worker } = setup();
  await host.handle(access);
  host.close();
  host.close();
  assert.equal(worker.close.mock.calls.length, 1);
  assert.deepEqual((await host.handle(access)).result, { kind: "unavailable", reason: "stopped" });
});

it("revocation during application discovery prevents the consent dialog", async () => {
  const { host, options } = setup();
  const identity = Promise.withResolvers<{ processId: number; application: string }>();
  options.resolveApplication.mockImplementation(() => identity.promise);
  const pending = host.handle(access);
  host.stop();
  identity.resolve({ processId: 42, application: "Verified App" });
  assert.deepEqual((await pending).result, { kind: "unavailable", reason: "stopped" });
  assert.equal(options.approve.mock.calls.length, 0);
});

it("native failures revoke access without exposing exception content", async () => {
  const { host, worker } = setup();
  await host.handle(access);
  await worker.ready;
  worker.act.mockRejectedValue(new Error("private window content"));
  assert.deepEqual((await host.handle(act)).result, {
    kind: "unavailable",
    reason: "worker-failed",
  });
  assert.equal(worker.close.mock.calls.length, 1);
});

it("a canceled old discovery cannot revoke a newer grant for the same session", async () => {
  const { host, options, worker } = setup();
  const oldDiscovery = Promise.withResolvers<{ processId: number; application: string }>();
  options.resolveApplication.mockImplementationOnce(() => oldDiscovery.promise);
  const oldRequest = host.handle(access);
  host.stop();
  assert.equal((await host.handle({ ...access, id: "new-request" })).result.kind, "pending");
  oldDiscovery.reject(new Error("late native failure"));
  assert.equal((await oldRequest).result.kind, "unavailable");
  assert.equal(worker.close.mock.calls.length, 0);
  assert.equal((await host.handle(act)).result.kind, "completed");
  host.close();
});

it("returns pending before consent and exposes the grant only after approval", async () => {
  const { host, options } = setup();
  const consent = Promise.withResolvers<boolean>();
  const granted = Promise.withResolvers<void>();
  options.approve.mockImplementation(() => consent.promise);
  options.changed.mockImplementation((grant) => {
    if (grant) granted.resolve();
  });
  const response = await host.handle(access);
  assert.deepEqual(response.result, { kind: "pending", application: "Verified App" });
  assert.equal(
    (await host.handle({ ...access, command: { kind: "status" } })).result.kind,
    "pending",
  );
  assert.equal(options.start.mock.calls.length, 0);
  consent.resolve(true);
  await granted.promise;
  assert.equal(
    (await host.handle({ ...access, command: { kind: "status" } })).result.kind,
    "granted",
  );
  host.close();
});

it("publishes a grant only after the native worker initializes", async () => {
  const { host, options, worker } = setup();
  const readiness = Promise.withResolvers<void>();
  const granted = Promise.withResolvers<void>();
  worker.ready = readiness.promise;
  options.changed.mockImplementation((grant) => {
    if (grant) granted.resolve();
  });
  await host.handle(access);
  assert.equal(
    (await host.handle({ ...access, command: { kind: "status" } })).result.kind,
    "pending",
  );
  assert.equal((await host.handle(act)).result.kind, "pending");
  assert.equal(worker.act.mock.calls.length, 0);
  assert.equal(options.changed.mock.calls.length, 0);
  readiness.resolve();
  await granted.promise;
  assert.equal(
    (await host.handle({ ...access, command: { kind: "status" } })).result.kind,
    "granted",
  );
  host.close();
});

it("an idle native crash revokes the grant and frees the desktop for another owner", async () => {
  const { host, options, worker } = setup();
  const stopped = Promise.withResolvers<void>();
  const revoked = Promise.withResolvers<void>();
  worker.closed = stopped.promise;
  options.changed.mockImplementation((grant) => {
    if (!grant) revoked.resolve();
  });
  await host.handle(access);
  stopped.resolve();
  await revoked.promise;
  assert.equal(
    (await host.handle({ ...access, command: { kind: "status" } })).result.kind,
    "unavailable",
  );
  const replacement = { ...worker, closed: new Promise<void>(() => undefined), close: vi.fn() };
  options.start.mockReturnValue(replacement);
  const other = { ...access, invocation: { ...access.invocation, owner: "other" } };
  assert.equal((await host.handle(other)).result.kind, "pending");
  await Promise.resolve();
  assert.equal(
    (await host.handle({ ...other, command: { kind: "status" } })).result.kind,
    "granted",
  );
  host.close();
});

it("a failed old initialization cannot revoke a replacement grant", async () => {
  const { host, options, worker } = setup();
  const readiness = Promise.withResolvers<void>();
  worker.ready = readiness.promise;
  await host.handle(access);
  host.stop();
  const granted = Promise.withResolvers<void>();
  const replacement = { ...worker, ready: Promise.resolve(), close: vi.fn() };
  options.start.mockReturnValue(replacement);
  options.changed.mockImplementation((grant) => {
    if (grant) granted.resolve();
  });
  await host.handle(access);
  await granted.promise;
  readiness.reject(new Error("old native worker failed"));
  await Promise.resolve();
  assert.equal(
    (await host.handle({ ...access, command: { kind: "status" } })).result.kind,
    "granted",
  );
  assert.equal(replacement.close.mock.calls.length, 0);
  host.close();
});
