import { describe, expect, it } from "vite-plus/test";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { deriveThreadTurnSubagents, resolveSubagentPillSegment } from "./threadSubagents.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

function subagent(
  overrides: Omit<Partial<OrchestrationV2Subagent>, "id"> & { readonly id: string },
): OrchestrationV2Subagent {
  const { id, ...rest } = overrides;
  return {
    id: NodeId.make(id),
    threadId: ThreadId.make("thread-1"),
    runId: RunId.make("run-1"),
    parentNodeId: NodeId.make("node-1"),
    origin: "app_owned",
    createdBy: "agent",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerThreadId: null,
    childThreadId: ThreadId.make("thread-child"),
    nativeTaskRef: null,
    prompt: "Do the thing",
    title: "Worker",
    model: "gpt-5.4",
    status: "running",
    result: null,
    startedAt: at("2026-06-20T00:00:00.000Z"),
    completedAt: null,
    updatedAt: at("2026-06-20T00:00:01.000Z"),
    ...rest,
  };
}

const run = (id: string, status: "running" | "completed") =>
  ({ id: RunId.make(id), status }) as never;
const activeRun = run("run-1", "running");
const finishedRun = run("run-1", "completed");

describe("deriveThreadTurnSubagents", () => {
  it("returns null when the thread has never spawned an agent", () => {
    expect(deriveThreadTurnSubagents({ runs: [activeRun], subagents: [] })).toBeNull();
  });

  it("keeps the active run's roster ordered by start time and adds live children from older runs", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [run("run-0", "completed"), activeRun],
      subagents: [
        subagent({ id: "b", startedAt: at("2026-06-20T00:00:05.000Z") }),
        subagent({ id: "old", runId: RunId.make("run-0") }),
        subagent({
          id: "settled-old",
          runId: RunId.make("run-0"),
          status: "completed",
          startedAt: at("2026-06-20T00:00:01.000Z"),
          completedAt: at("2026-06-20T00:00:04.000Z"),
          updatedAt: at("2026-06-20T00:00:04.000Z"),
        }),
        subagent({ id: "a", startedAt: at("2026-06-20T00:00:02.000Z") }),
      ],
    });

    expect(turn?.runId).toBe("run-1");
    expect(turn?.subagents.map((entry) => entry.id)).toEqual(["old", "a", "b"]);
    expect(turn?.turnActive).toBe(true);
  });

  it("lists async children from earlier parent turns next to the current turn's", () => {
    // Regression: three delegations launched in three different parent runs.
    // The first two parent turns already settled while their children keep
    // running, so a run-scoped roster would have shown only child-r6.
    const turn = deriveThreadTurnSubagents({
      runs: [run("run-1", "completed"), run("run-2", "completed"), run("run-3", "running")],
      subagents: [
        subagent({
          id: "child-r4",
          runId: RunId.make("run-1"),
          origin: "provider_native",
          driver: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: ProviderInstanceId.make("claude"),
          startedAt: at("2026-06-20T00:00:00.000Z"),
          updatedAt: at("2026-06-20T00:02:00.000Z"),
        }),
        subagent({
          id: "child-r5",
          runId: RunId.make("run-2"),
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          startedAt: at("2026-06-20T00:01:00.000Z"),
          updatedAt: at("2026-06-20T00:02:01.000Z"),
        }),
        subagent({
          id: "child-r6",
          runId: RunId.make("run-3"),
          providerInstanceId: ProviderInstanceId.make("zcode"),
          startedAt: at("2026-06-20T00:03:00.000Z"),
          updatedAt: at("2026-06-20T00:03:10.000Z"),
        }),
      ],
    });

    expect(turn?.runId).toBe("run-3");
    expect(turn?.subagents.map((entry) => entry.id)).toEqual(["child-r4", "child-r5", "child-r6"]);
    expect(turn?.liveCount).toBe(3);
    expect(resolveSubagentPillSegment(turn)?.label).toBe("3/3");
  });

  it("keeps older active siblings visible when the newest child settles", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [run("run-1", "completed"), run("run-2", "running")],
      subagents: [
        subagent({ id: "older-live", runId: RunId.make("run-1") }),
        subagent({
          id: "newest-done",
          runId: RunId.make("run-2"),
          status: "completed",
          startedAt: at("2026-06-20T00:02:00.000Z"),
          completedAt: at("2026-06-20T00:03:00.000Z"),
          updatedAt: at("2026-06-20T00:03:00.000Z"),
        }),
      ],
    });

    expect(turn?.subagents.map((entry) => entry.id)).toEqual(["older-live", "newest-done"]);
    expect(turn?.liveCount).toBe(1);
    expect(turn?.settledCount).toBe(1);
    expect(resolveSubagentPillSegment(turn)?.label).toBe("1/2");
  });

  it("shows a live async child while a newer turn runs without agents", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [run("run-1", "completed"), run("run-2", "running")],
      subagents: [subagent({ id: "async-child", runId: RunId.make("run-1") })],
    });

    expect(turn?.runId).toBe("run-2");
    expect(turn?.turnActive).toBe(true);
    expect(turn?.subagents.map((entry) => entry.id)).toEqual(["async-child"]);
    expect(resolveSubagentPillSegment(turn)?.label).toBe("1/1");
  });

  it("falls back to the most recently updated agent's run once the turn settles", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [finishedRun, run("run-2", "completed")],
      subagents: [
        subagent({ id: "old", status: "completed", updatedAt: at("2026-06-20T00:00:01.000Z") }),
        subagent({
          id: "recent",
          runId: RunId.make("run-2"),
          status: "completed",
          updatedAt: at("2026-06-20T00:00:09.000Z"),
        }),
      ],
    });

    expect(turn?.runId).toBe("run-2");
    expect(turn?.turnActive).toBe(false);
    expect(turn?.subagents.map((entry) => entry.id)).toEqual(["recent"]);
  });

  it("keeps the roster readable after the focus run settles while an older child still works", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [run("run-1", "completed"), run("run-2", "completed")],
      subagents: [
        subagent({
          id: "older-live",
          runId: RunId.make("run-1"),
          startedAt: at("2026-06-20T00:00:00.000Z"),
          updatedAt: at("2026-06-20T00:01:00.000Z"),
        }),
        subagent({
          id: "newest-done",
          runId: RunId.make("run-2"),
          status: "completed",
          startedAt: at("2026-06-20T00:02:00.000Z"),
          completedAt: at("2026-06-20T00:03:00.000Z"),
          updatedAt: at("2026-06-20T00:03:00.000Z"),
        }),
      ],
    });

    expect(turn?.turnActive).toBe(false);
    expect(turn?.subagents.map((entry) => entry.id)).toEqual(["older-live", "newest-done"]);
    expect(resolveSubagentPillSegment(turn)?.label).toBe("1/2");
  });

  it("counts idle as neither working nor done", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [activeRun],
      subagents: [
        subagent({ id: "a", status: "running" }),
        subagent({ id: "b", status: "idle" }),
        subagent({ id: "c", status: "failed" }),
      ],
    });

    expect(turn?.liveCount).toBe(1);
    expect(turn?.settledCount).toBe(1);
    expect(turn?.subagents).toHaveLength(3);
  });
});

describe("resolveSubagentPillSegment", () => {
  it("shows how many of the turn's agents are still working", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [activeRun],
      subagents: [
        subagent({ id: "a", status: "running" }),
        subagent({ id: "b", status: "waiting" }),
        subagent({ id: "c", status: "completed" }),
      ],
    });

    expect(resolveSubagentPillSegment(turn)).toEqual({
      label: "2/3",
      accessibilityLabel: "2 of 3 agents working",
    });
  });

  it("reports the finished roster while the turn is still running", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [activeRun],
      subagents: [subagent({ id: "a", status: "completed" })],
    });

    expect(resolveSubagentPillSegment(turn)).toEqual({
      label: "1 done",
      accessibilityLabel: "1 agent done",
    });
  });

  it("hides itself once the turn is over and nothing is working", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [finishedRun],
      subagents: [subagent({ id: "a", status: "completed" })],
    });

    expect(resolveSubagentPillSegment(turn)).toBeNull();
    expect(resolveSubagentPillSegment(null)).toBeNull();
  });

  it("stays visible after the turn ends while an agent is still working", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [finishedRun],
      subagents: [subagent({ id: "a", status: "running" })],
    });

    expect(resolveSubagentPillSegment(turn)?.label).toBe("1/1");
  });
});
