import * as NodeAssert from "node:assert/strict";
import type { App, Element } from "@crowecawcaw/xa11y";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { ComputerSession } from "./ComputerSession.ts";
import { makeComputerNativeDriver } from "./ComputerNativeDriver.ts";

function element(overrides: Partial<Element> = {}): Element {
  return {
    role: "button",
    name: "Save",
    value: null,
    raw: {},
    actions: ["press"],
    enabled: true,
    visible: true,
    editable: false,
    active: false,
    bounds: null,
    children: vi.fn(async () => []),
    press: vi.fn(async () => undefined),
    setValue: vi.fn(async () => undefined),
    scrollIntoView: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as Element;
}

function setup(children: Element[]) {
  const window = element({
    role: "window",
    active: true,
    actions: [],
    bounds: { x: 20, y: 30, width: 600, height: 400 },
    stableId: "window-1",
    children: vi.fn(async () => children),
  });
  const app = {
    pid: 42,
    name: "Test App",
    children: vi.fn(async () => [window]),
  } as unknown as App;
  const foreground = vi.fn(async () => app);
  const screenshot = vi.fn(async () => ({ toPng: () => Buffer.from("test-image") }));
  const api = {
    App: { foreground, byPid: vi.fn(async () => app) },
    screenshot,
  } as unknown as Parameters<typeof makeComputerNativeDriver>[0];
  return { driver: makeComputerNativeDriver(api), app, window, foreground, screenshot };
}

it("masks secure fields and their descendants, and captures only the approved window", async () => {
  const secure = element({
    role: "text_field",
    name: "Secret",
    value: "not-for-model",
    editable: true,
    raw: { ax_subrole: "AXSecureTextField" },
    children: vi.fn(async () => [element()]),
  });
  const { driver, screenshot } = setup([secure]);
  const snapshot = await driver.capture(42);
  assert.deepEqual(snapshot.elements[1], { role: "text_field", actions: [] });
  assert.equal(snapshot.elements.length, 2);
  assert.equal(vi.mocked(secure.children).mock.calls.length, 0);
  assert.deepEqual(screenshot.mock.calls[0], [
    { region: { x: 20, y: 30, width: 600, height: 400 } },
  ]);
});

it("bounds traversal and text without producing handles beyond the returned snapshot", async () => {
  const { driver } = setup(Array.from({ length: 600 }, () => element({ name: "x" })));
  const snapshot = await driver.capture(42);
  assert.equal(snapshot.elements.length, 400);
  assert.isTrue(snapshot.truncated);
  await NodeAssert.rejects(driver.act({ kind: "press", element: 400 }), /Unknown/);
});

it("uses the captured semantic target and never global keyboard input", async () => {
  const field = element({ role: "text_field", editable: true, actions: [] });
  const { driver } = setup([field]);
  await driver.capture(42);
  await driver.act({ kind: "fill", element: 1, text: "test" });
  assert.deepEqual(vi.mocked(field.setValue).mock.calls, [["test"]]);
  await NodeAssert.rejects(driver.act({ kind: "fill", element: 1, text: "duplicate" }), /Unknown/);
});

it("rechecks foreground at the native boundary and drops pending handles on failure", async () => {
  const button = element();
  const { driver, app, foreground } = setup([button]);
  await driver.capture(42);
  foreground.mockResolvedValue({ ...app, pid: 99 } as App);
  await NodeAssert.rejects(driver.act({ kind: "press", element: 1 }), /foreground/);
  assert.equal(vi.mocked(button.press).mock.calls.length, 0);
  foreground.mockResolvedValue(app);
  await NodeAssert.rejects(driver.act({ kind: "press", element: 1 }), /Unknown/);
});

it("close revokes captured handles", async () => {
  const { driver } = setup([element()]);
  await driver.capture(42);
  driver.close();
  await NodeAssert.rejects(driver.act({ kind: "press", element: 1 }), /closed/);
});

it("a different active window in the same app invalidates the old semantic target", async () => {
  const button = element();
  const { driver, app } = setup([button]);
  await driver.capture(42);
  vi.mocked(app.children).mockResolvedValue([
    element({ role: "window", active: true, name: "Other document" }),
  ]);
  await NodeAssert.rejects(driver.act({ kind: "press", element: 1 }), /active window changed/);
  assert.equal(vi.mocked(button.press).mock.calls.length, 0);
});

it("offscreen controls can be revealed without permitting offscreen input", async () => {
  const hidden = element({
    visible: false,
    editable: true,
    actions: ["press", "scroll_into_view"],
  });
  const { driver } = setup([hidden]);
  const snapshot = await driver.capture(42);
  assert.deepEqual(snapshot.elements[1]?.actions, ["scrollIntoView"]);
});

// xa11y 0.13.0 Element getters are snapshot data; children() queries fresh
// nodes, and press/setValue operate the captured native handle without resolving
// it again. Fresh objects below model those semantics instead of live getters.
it.each([
  "replacement",
  "repurposed",
  "secure",
  "disabled",
  "topology",
  "removed",
  "truncated-name",
] as const)(
  "rejects %s within the same window before an action and allows recapture",
  async (change) => {
    let time = 1_000;
    let nextId = 0;
    const original = element({
      stableId: "control-1",
      name: change === "truncated-name" ? "x".repeat(500) + "Save" : "Save",
      editable: true,
    });
    const { driver, app, window, screenshot } = setup([original]);
    const session = new ComputerSession(
      {
        owner: "session-a",
        processId: 42,
        application: "Test App",
        expiresAt: 100_000,
        readOnly: false,
      },
      driver,
      () => time,
      () => `snapshot-${nextId++}`,
    );
    const first = await session.inspect("session-a");
    const replacement = element({
      stableId: change === "replacement" ? "control-2" : "control-1",
      name:
        change === "truncated-name"
          ? "x".repeat(500) + "Delete"
          : change === "repurposed"
            ? "Delete"
            : "Save",
      editable: true,
      ...(change === "secure" ? { raw: { ax_subrole: "AXSecureTextField" }, value: "secret" } : {}),
      ...(change === "disabled" ? { enabled: false } : {}),
    });
    const relisted = element({
      ...window,
      children: vi.fn(async () =>
        change === "removed"
          ? []
          : change === "topology"
            ? [element({ name: "Inserted" }), replacement]
            : [replacement],
      ),
    });
    vi.mocked(app.children).mockResolvedValue([relisted]);
    time += 500;
    assert.equal(screenshot.mock.calls.length, 1);
    assert.equal(vi.mocked(relisted.children).mock.calls.length, 0);
    await NodeAssert.rejects(
      session.act("session-a", first.snapshotId, { kind: "fill", element: 1, text: "input" }),
      /Window contents changed/,
    );
    assert.equal(vi.mocked(original.setValue).mock.calls.length, 0);
    assert.equal(vi.mocked(replacement.setValue).mock.calls.length, 0);
    assert.equal(screenshot.mock.calls.length, 1);
    await NodeAssert.rejects(
      session.act("session-a", first.snapshotId, { kind: "fill", element: 1, text: "retry" }),
      /fresh computer snapshot/,
    );
    const fresh = await session.inspect("session-a");
    assert.notEqual(fresh.snapshotId, first.snapshotId);
    assert.equal(screenshot.mock.calls.length, 2);
    if (change === "secure") {
      assert.deepEqual(fresh.elements[1], { role: "button", actions: [] });
    } else if (change === "disabled") {
      assert.deepEqual(fresh.elements[1]?.actions, []);
    } else if (change !== "removed") {
      await session.act("session-a", fresh.snapshotId, {
        kind: "fill",
        element: change === "topology" ? 2 : 1,
        text: "confirmed",
      });
      assert.deepEqual(vi.mocked(replacement.setValue).mock.calls, [["confirmed"]]);
    }
    session.stop();
  },
);

it("acts on a freshly queried equivalent handle without taking another screenshot", async () => {
  const original = element({ stableId: "button-1" });
  const { driver, app, window, screenshot } = setup([original]);
  await driver.capture(42);
  const current = element({ stableId: "button-1" });
  vi.mocked(app.children).mockResolvedValue([
    element({ ...window, children: vi.fn(async () => [current]) }),
  ]);
  await driver.act({ kind: "press", element: 1 });
  assert.equal(vi.mocked(original.press).mock.calls.length, 0);
  assert.equal(vi.mocked(current.press).mock.calls.length, 1);
  assert.equal(screenshot.mock.calls.length, 1);
});

it.each(["focus", "window", "revoke"] as const)(
  "refuses %s during action-time AX validation",
  async (interruption) => {
    const button = element();
    const { driver, app, window, foreground } = setup([button]);
    await driver.capture(42);
    vi.mocked(window.children).mockImplementation(async () => {
      if (interruption === "focus") foreground.mockResolvedValue({ ...app, pid: 99 } as App);
      if (interruption === "window") vi.mocked(app.children).mockResolvedValue([]);
      if (interruption === "revoke") driver.close();
      return [element()];
    });
    await NodeAssert.rejects(
      driver.act({ kind: "press", element: 1 }),
      interruption === "focus"
        ? /foreground/
        : interruption === "window"
          ? /active window/
          : /closed/,
    );
    assert.equal(vi.mocked(button.press).mock.calls.length, 0);
    await NodeAssert.rejects(
      driver.act({ kind: "press", element: 1 }),
      interruption === "revoke" ? /closed/ : /Unknown/,
    );
  },
);
