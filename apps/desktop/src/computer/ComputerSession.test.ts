import * as NodeAssert from "node:assert/strict";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { computerFailureReason } from "./ComputerError.ts";
import { ComputerSession, type ComputerCapture } from "./ComputerSession.ts";

const capture: ComputerCapture = {
  elements: [
    { role: "text_field", actions: ["fill"] },
    { role: "button", actions: ["press"] },
  ],
  truncated: false,
};

function setup(readOnly = false) {
  let time = 1_000;
  let nextId = 0;
  const driver = {
    foreground: vi.fn(async () => ({ processId: 42, application: "Test App" })),
    capture: vi.fn(async () => capture),
    act: vi.fn(async () => undefined),
    close: vi.fn(),
  };
  const session = new ComputerSession(
    { owner: "session-a", processId: 42, application: "Test App", expiresAt: 100_000, readOnly },
    driver,
    () => time,
    () => `snapshot-${nextId++}`,
  );
  return { driver, session, advance: (milliseconds: number) => (time += milliseconds) };
}

it("rejects another session before reading the desktop", async () => {
  const { session, driver } = setup();
  await NodeAssert.rejects(session.inspect("session-b"), /another session/);
  assert.equal(driver.foreground.mock.calls.length, 0);
});

it("requires a fresh snapshot and consumes it after one action", async () => {
  const { session, driver } = setup();
  const first = await session.inspect("session-a");
  await session.act("session-a", first.snapshotId, { kind: "fill", element: 0, text: "hello" });
  await NodeAssert.rejects(
    session.act("session-a", first.snapshotId, { kind: "press", element: 1 }),
    /fresh computer snapshot/,
  );
  assert.equal(driver.act.mock.calls.length, 1);
});

it("refuses stale snapshots and expires the app grant", async () => {
  const { session, driver, advance } = setup();
  const first = await session.inspect("session-a");
  advance(30_000);
  await NodeAssert.rejects(
    session.act("session-a", first.snapshotId, { kind: "press", element: 1 }),
    /fresh computer snapshot/,
  );
  advance(70_000);
  await NodeAssert.rejects(session.inspect("session-a"), /grant expired/);
  assert.equal(driver.close.mock.calls.length, 1);
});

it("read-only grants inspect but cannot mutate", async () => {
  const { session, driver } = setup(true);
  const first = await session.inspect("session-a");
  await NodeAssert.rejects(
    session.act("session-a", first.snapshotId, { kind: "press", element: 1 }),
    /read-only/,
  );
  assert.equal(driver.act.mock.calls.length, 0);
});

it("a foreground change invalidates the snapshot without stealing focus", async () => {
  const { session, driver } = setup();
  const first = await session.inspect("session-a");
  driver.foreground.mockResolvedValue({ processId: 17, application: "User App" });
  await NodeAssert.rejects(
    session.act("session-a", first.snapshotId, { kind: "press", element: 1 }),
    /changed applications/,
  );
  assert.equal(driver.act.mock.calls.length, 0);
  driver.foreground.mockResolvedValue({ processId: 42, application: "Test App" });
  await NodeAssert.rejects(
    session.act("session-a", first.snapshotId, { kind: "press", element: 1 }),
    /fresh computer snapshot/,
  );
});

it("revocation during capture cannot mint a usable snapshot", async () => {
  const { session, driver } = setup();
  const pending = Promise.withResolvers<ComputerCapture>();
  const started = Promise.withResolvers<void>();
  driver.capture.mockImplementation(() => {
    started.resolve();
    return pending.promise;
  });
  const result = session.inspect("session-a");
  await started.promise;
  session.stop();
  pending.resolve(capture);
  await NodeAssert.rejects(result, /stopped/);
  session.stop();
  assert.equal(driver.close.mock.calls.length, 1);
});

it("concurrent actions cannot reuse a snapshot while native input is pending", async () => {
  const { session, driver } = setup();
  const pending = Promise.withResolvers<undefined>();
  const started = Promise.withResolvers<void>();
  driver.act.mockImplementation(() => {
    started.resolve();
    return pending.promise;
  });
  const first = await session.inspect("session-a");
  const action = session.act("session-a", first.snapshotId, { kind: "press", element: 1 });
  await started.promise;
  await NodeAssert.rejects(session.inspect("session-a"), /in progress/);
  await NodeAssert.rejects(
    session.act("session-a", first.snapshotId, { kind: "press", element: 1 }),
    /in progress/,
  );
  pending.resolve(undefined);
  await action;
  assert.equal(driver.act.mock.calls.length, 1);
});

it("rejects unknown elements, unsupported actions and excessive text", async () => {
  const { session, driver } = setup();
  const first = await session.inspect("session-a");
  for (const element of [-1, 0.5, 100]) {
    await NodeAssert.rejects(
      session.act("session-a", first.snapshotId, { kind: "press", element }),
    );
  }
  await NodeAssert.rejects(
    session.act("session-a", first.snapshotId, { kind: "press", element: 0 }),
  );
  await NodeAssert.rejects(
    session.act("session-a", first.snapshotId, {
      kind: "fill",
      element: 0,
      text: "x".repeat(16_001),
    }),
    /input limit/,
  );
  assert.equal(driver.act.mock.calls.length, 0);
});

for (const phase of ["before-capture", "after-capture", "before-action"] as const) {
  for (const mismatch of ["process", "name"] as const) {
    it(`identifies ${mismatch} mismatch ${phase} without exposing app identity`, async () => {
      const { session, driver } = setup();
      const changed =
        mismatch === "process"
          ? { processId: 17, application: "Test App" }
          : { processId: 42, application: "private-app-name" };
      let snapshotId = "";
      if (phase === "before-action") {
        snapshotId = (await session.inspect("session-a")).snapshotId;
      }
      if (phase === "after-capture") {
        driver.capture.mockImplementation(async () => {
          driver.foreground.mockResolvedValue(changed);
          return capture;
        });
      } else {
        driver.foreground.mockResolvedValue(changed);
      }
      await NodeAssert.rejects(
        phase === "before-action"
          ? session.act("session-a", snapshotId, { kind: "press", element: 1 })
          : session.inspect("session-a"),
        (error: unknown) => {
          assert.equal(computerFailureReason(error), `focus-${phase}-${mismatch}`);
          assert.ok(error instanceof Error);
          assert.ok(!error.message.includes("private-app-name"));
          return true;
        },
      );
      assert.equal(driver.act.mock.calls.length, 0);
      if (phase === "before-capture") assert.equal(driver.capture.mock.calls.length, 0);
    });
  }
}
