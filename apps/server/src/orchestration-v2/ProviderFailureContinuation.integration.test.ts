import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRetry,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { isTransientTerminalFailure } from "./ProviderFailureContinuation.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const selection = {
  instanceId,
  model: "fixture-model",
  options: [{ id: "reasoningEffort", value: "high" }],
};
const capacity: OrchestrationV2ProviderFailure = {
  class: "provider_error",
  code: null,
  retryable: null,
  message: "Selected model is at capacity. Please try a different model.",
};

function fixtureAdapter(
  turns: Ref.Ref<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>,
  failure = capacity,
  retry?: OrchestrationV2ProviderRetry,
  failContinuation = false,
  behavior: {
    beforeTerminal?: Effect.Effect<void>;
    nativeThreadStrength?: "strong" | "weak";
    threadDisposition?: "reusable" | "broken";
  } = {},
): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        return {
          instanceId,
          driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession: {
            id: sessionInput.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd: sessionInput.runtimePolicy.cwd ?? "/fixture",
            model: selection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: (input) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${input.threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: sessionInput.providerSessionId,
              appThreadId: input.threadId,
              ownerNodeId: null,
              nativeThreadRef: {
                driver,
                nativeId: `native:${input.threadId}`,
                strength: behavior.nativeThreadStrength ?? "strong",
              },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (input) =>
            Effect.gen(function* () {
              yield* Ref.update(turns, (current) => [...current, input]);
              const providerTurnId = ProviderTurnId.make(`turn:${input.attemptId}`);
              const at = yield* DateTime.now;
              const failed = input.message.text !== "continue" || failContinuation;
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: providerTurnId,
                  providerThreadId: input.providerThread.id,
                  nodeId: input.rootNodeId,
                  runAttemptId: input.attemptId,
                  nativeTurnRef: { driver, nativeId: providerTurnId, strength: "strong" },
                  ordinal: input.providerTurnOrdinal,
                  status:
                    input.message.text === "parent" ? "running" : failed ? "failed" : "completed",
                  startedAt: at,
                  completedAt: at,
                },
              });
              if (input.message.text === "parent") return;
              yield* behavior.beforeTerminal ?? Effect.void;
              const common = {
                type: "turn.terminal" as const,
                driver,
                providerThreadId: input.providerThread.id,
                providerTurnId,
                runOrdinal: input.runOrdinal,
                threadDisposition: behavior.threadDisposition ?? ("reusable" as const),
              };
              const terminal: ProviderAdapter.ProviderAdapterV2Event = failed
                ? {
                    ...common,
                    status: "failed",
                    failure,
                    failureItemOrdinal: 101,
                    ...(retry ? { retry } : {}),
                  }
                : { ...common, status: "completed", failure: null };
              // Duplicate terminal protocol notifications must not spend another budget.
              yield* Queue.offerAll(events, [terminal, terminal]);
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused fixture snapshot"),
          rollbackThread: () => Effect.die("must not replay mutations"),
          forkThread: () => Effect.die("must not fork conversation"),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  };
}

const threadId = ThreadId.make("thread:failure-continuation");
const create = {
  type: "thread.create" as const,
  commandId: CommandId.make("command:create"),
  createdBy: "user" as const,
  creationSource: "web" as const,
  threadId,
  projectId: ProjectId.make("project:fixture"),
  title: "Failure fixture",
  modelSelection: selection,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
};
const send = (key: string) => ({
  type: "message.dispatch" as const,
  commandId: CommandId.make(`command:${key}`),
  threadId,
  messageId: MessageId.make(`message:${key}`),
  text: key,
  attachments: [],
  createdBy: "user" as const,
  creationSource: "web" as const,
  dispatchMode: { type: "start_immediately" as const },
});

function awaitRun(
  status: OrchestrationV2Run["status"],
  ordinal: number,
  targetThreadId = threadId,
) {
  return Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    return yield* sink.stream({ threadId: targetThreadId, afterSequence: 0 }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "run.updated" &&
          stored.event.payload.ordinal === ordinal &&
          stored.event.payload.status === status,
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
  });
}

function scenario<E>(
  test: Effect.Effect<
    void,
    E,
    | Orchestrator.OrchestratorV2
    | EffectWorker.OrchestrationEffectWorkerV2
    | EventSink.EventSinkV2
    | ServerSettings.ServerSettingsService
    | EffectOutbox.EffectOutboxV2
    | Scope.Scope
  >,
  options: {
    enabled?: boolean;
    failure?: OrchestrationV2ProviderFailure;
    retry?: OrchestrationV2ProviderRetry;
    failContinuation?: boolean;
    runEffectWorker?: boolean;
    expectedStartedTurns?: number;
    unsafeConversation?: "weak" | "broken";
  } = {},
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const turns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>([]);
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* orchestrator.dispatch(create);
        const failed = yield* awaitRun("failed", 1);
        yield* orchestrator.dispatch(send("original"));
        yield* worker.drain();
        yield* Fiber.join(failed);
        yield* test;
        const started = yield* Ref.get(turns);
        if (options.expectedStartedTurns !== undefined)
          assert.lengthOf(started, options.expectedStartedTurns);
        for (const turn of started) {
          assert.deepEqual(turn.modelSelection, selection);
          assert.equal(turn.runtimePolicy.runtimeMode, "full-access");
          assert.equal(turn.providerThread.nativeThreadRef?.nativeId, `native:${threadId}`);
        }
        if (started.length > 1 && started[1]?.message.createdBy === "agent")
          assert.equal(started[1].message.text, "continue");
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "provider-failure-continuation" },
            ProviderAdapterRegistry.layerSingle(
              fixtureAdapter(turns, options.failure, options.retry, options.failContinuation, {
                ...(options.unsafeConversation === "weak" ? { nativeThreadStrength: "weak" } : {}),
                ...(options.unsafeConversation === "broken" ? { threadDisposition: "broken" } : {}),
              }),
            ),
            {
              continueAfterProviderFailure: options.enabled ?? true,
              ...(options.runEffectWorker === undefined
                ? {}
                : { runEffectWorker: options.runEffectWorker }),
            },
          ),
        ),
      );
    }),
  );
}

it.effect("waits 30s then starts one new turn on the same saved conversation", () =>
  scenario(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      let projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projection.runs[0]?.automaticContinuation?.status, "scheduled");
      assert.equal(
        (yield* orchestrator.getThreadShell(threadId))?.automaticContinuation?.status,
        "scheduled",
      );
      yield* TestClock.adjust("29 seconds");
      yield* worker.drain();
      assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
      const done = yield* awaitRun("completed", 2);
      yield* TestClock.adjust("1 second");
      yield* worker.drain();
      yield* Fiber.join(done);
      yield* worker.drain();
      projection = yield* orchestrator.getThreadProjection(threadId);
      assert.lengthOf(projection.runs, 2);
      const [source, continuation] = projection.runs;
      assert.equal(continuation?.failureContinuationOfRunId, source?.id);
      assert.equal(continuation?.automaticContinuation, undefined);
      // Durable receipt suppresses a duplicated offer after success.
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`command:failure-continuation:${source!.id}`),
        messageId: MessageId.make(`message:failure-continuation:${source!.id}`),
        threadId,
        text: "continue",
        attachments: [],
        createdBy: "agent",
        creationSource: "server",
        dispatchMode: { type: "start_immediately" },
        failureContinuationOfRunId: source!.id,
      });
      assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 2);
    }),
  ),
);

it.effect("stops after the failed continuation, including duplicate terminal events", () =>
  scenario(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const failed = yield* awaitRun("failed", 2);
      yield* TestClock.adjust("30 seconds");
      yield* worker.drain();
      yield* Fiber.join(failed);
      yield* TestClock.adjust("1 hour");
      yield* worker.drain();
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.lengthOf(projection.runs, 2);
      assert.equal(projection.runs[1]?.automaticContinuation?.status, "exhausted");
    }),
    { failContinuation: true },
  ),
);

it.effect("manual work cancels the offer and does not wait behind its delay", () =>
  scenario(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const manual = yield* awaitRun("failed", 2);
      yield* orchestrator.dispatch(send("manual"));
      yield* worker.drain();
      yield* Fiber.join(manual);
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.automaticContinuation?.status,
        "cancelled",
      );
      // The new human turn may have its own offer, but the stale one never starts.
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("command:stop"),
        threadId,
      });
      yield* TestClock.adjust("1 hour");
      yield* worker.drain();
      assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 2);
    }),
  ),
);

it.effect.each(["stop", "archive", "model"] as const)("invalidates pending work on %s", (action) =>
  scenario(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* orchestrator.dispatch(
        action === "stop"
          ? { type: "thread.stop", commandId: CommandId.make("command:invalidate"), threadId }
          : action === "archive"
            ? { type: "thread.archive", commandId: CommandId.make("command:invalidate"), threadId }
            : {
                type: "thread.model-selection.set",
                commandId: CommandId.make("command:invalidate"),
                threadId,
                modelSelection: { ...selection, model: "another-model" },
              },
      );
      yield* TestClock.adjust("1 hour");
      yield* worker.drain();
      assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
    }),
  ),
);

const exclusions: OrchestrationV2ProviderFailure[] = [
  { ...capacity, class: "permission_error" },
  { ...capacity, class: "usage_limit" },
  { ...capacity, retryable: false },
  ...[
    "Quota exhausted",
    "Billing required",
    "Invalid model",
    "Approval denied",
    "User cancelled",
    "User interrupted",
    "Unknown error",
  ].map((message) => ({ ...capacity, message })),
];

it.each(exclusions)("fails closed for $class: $message", (failure) => {
  assert.isFalse(isTransientTerminalFailure(failure));
});

it.effect.each(exclusions)("does not schedule excluded terminal failure $message", (failure) =>
  scenario(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      assert.isUndefined(
        (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.automaticContinuation,
      );
      yield* TestClock.adjust("1 hour");
      yield* worker.drain();
      assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
    }),
    { failure },
  ),
);

it.effect("is opt-in and leaves native retry alone", () =>
  scenario(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      assert.isUndefined(
        (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.automaticContinuation,
      );
    }),
    { enabled: false },
  ),
);

it.effect("suppresses app continuation while a native retry is active", () =>
  scenario(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      assert.isUndefined(
        (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.automaticContinuation,
      );
    }),
    { retry: { attempt: 1, maxAttempts: 3, retryDelayMs: 60_000 } },
  ),
);

it.effect("honors exhausted native retry delay and later provider reset", () =>
  scenario(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const source = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
      assert.equal(
        DateTime.toEpochMillis(source.automaticContinuation!.dueAt) -
          DateTime.toEpochMillis(source.completedAt!),
        90_000,
      );
      yield* TestClock.adjust("89 seconds");
      yield* worker.drain();
      assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
      yield* TestClock.adjust("1 second");
      yield* worker.drain();
      yield* Fiber.join(yield* awaitRun("completed", 2));
    }),
    {
      failure: { ...capacity, resetAt: "1970-01-01T00:01:30.000Z" },
      retry: { attempt: 3, maxAttempts: 3, retryDelayMs: 60_000 },
    },
  ),
);

it.effect.each(["opt-out", "configuration"] as const)(
  "revalidates %s changed after scheduling",
  (change) =>
    scenario(
      Effect.gen(function* () {
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings(
          change === "opt-out"
            ? { continueAfterProviderFailure: false }
            : { responseStreamingMode: "paragraph" },
        );
        yield* TestClock.adjust("30 seconds");
        yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
        const projection = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
          threadId,
        );
        assert.lengthOf(projection.runs, 1);
        assert.equal(projection.runs[0]?.automaticContinuation?.status, "cancelled");
      }),
    ),
);

it.effect("Stop wins after the delayed effect is claimed, including lease recovery", () =>
  scenario(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      yield* TestClock.adjust("30 seconds");
      const claimed = yield* outbox.claimNext({
        workerId: "crashed-worker",
        leaseDurationMs: 60_000,
      });
      assert.equal(Option.getOrThrow(claimed).request.type, "provider-failure.continue");
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("command:claimed-stop"),
        threadId,
      });
      yield* outbox.reconcileAfterProcessLoss;
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
      assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
    }),
    { runEffectWorker: false },
  ),
);

it.effect("preserves the delay and one-attempt budget through fresh SQLite runtimes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* Effect.acquireRelease(
        fs.makeTempDirectory({ prefix: "t3-failure-continuation-" }),
        (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
      );
      const databaseLayer = SqlitePersistence.layerFromPath(
        path.join(directory, "state.sqlite"),
      ).pipe(Layer.provide(NodeServices.layer));
      const turns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>([]);
      const runtime = (recoverOnStartup = false) =>
        ProviderReplayHarness.layerWithRegistry(
          { name: "failure-continuation-restart" },
          ProviderAdapterRegistry.layerSingle(fixtureAdapter(turns, capacity, undefined, true)),
          { databaseLayer, continueAfterProviderFailure: true, recoverOnStartup },
        );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.dispatch(create);
          yield* orchestrator.dispatch(send("original"));
          yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
          yield* Fiber.join(yield* awaitRun("failed", 1));
        }).pipe(Effect.provide(runtime())),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          yield* TestClock.adjust("29 seconds");
          yield* worker.drain();
          assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
          yield* TestClock.adjust("1 second");
          yield* worker.drain();
          yield* Fiber.join(yield* awaitRun("failed", 2));
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runs[1]?.automaticContinuation
              ?.status,
            "exhausted",
          );
        }).pipe(Effect.provide(runtime(true))),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.adjust("1 hour");
          yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
          assert.lengthOf(
            (yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(threadId)).runs,
            2,
          );
        }).pipe(Effect.provide(runtime(true))),
      );
      assert.lengthOf(yield* Ref.get(turns), 2);
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

it.effect.each(["success", "failure", "parent-stop"] as const)(
  "holds delegated failure and delivers final outcome exactly once (%s)",
  (outcome) =>
    Effect.scoped(
      Effect.gen(function* () {
        const turns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>(
          [],
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const parentId = ThreadId.make("thread:parent");
          yield* orchestrator.dispatch({ ...create, threadId: parentId });
          yield* orchestrator.dispatch({ ...send("parent"), threadId: parentId });
          yield* worker.drain();
          yield* Fiber.join(yield* awaitRun("running", 1, parentId));
          const parent = yield* orchestrator.getThreadProjection(parentId);
          yield* orchestrator.dispatch({
            type: "delegated_task.request",
            commandId: CommandId.make("command:delegate"),
            createdBy: "agent",
            creationSource: "mcp",
            parentThreadId: parentId,
            parentRunId: parent.runs[0]!.id,
            parentNodeId: parent.runs[0]!.rootNodeId!,
            task: "original",
            modelSelection: selection,
            runtimeMode: "full-access",
            interactionMode: "default",
            completionWake: "settled_only",
          });
          const task = (yield* orchestrator.getThreadProjection(parentId)).subagents[0]!;
          const childId = task.childThreadId!;
          yield* worker.drain();
          yield* Fiber.join(yield* awaitRun("failed", 1, childId));
          assert.isTrue(yield* orchestrator.delegatedTaskResultPending(childId, task.id));
          yield* orchestrator.recoverDelegatedTasks;
          assert.equal(
            (yield* orchestrator.getThreadProjection(parentId)).subagents[0]?.status,
            "running",
          );
          if (outcome === "parent-stop") {
            yield* orchestrator.dispatch({
              type: "thread.stop",
              commandId: CommandId.make("command:parent-stop"),
              threadId: parentId,
            });
            const source = (yield* orchestrator.getThreadProjection(childId)).runs[0]!;
            yield* TestClock.adjust("30 seconds");
            // Dispatch before the child-stop effect runs: the parent barrier alone must reject it.
            yield* orchestrator.dispatch(continuationCommand(source));
            yield* worker.drain();
            assert.lengthOf((yield* orchestrator.getThreadProjection(childId)).runs, 1);
            return;
          }
          yield* TestClock.adjust("30 seconds");
          yield* worker.drain();
          yield* Fiber.join(
            yield* awaitRun(outcome === "failure" ? "failed" : "completed", 2, childId),
          );
          yield* orchestrator.recoverDelegatedTasks;
          const finalParent = yield* orchestrator.getThreadProjection(parentId);
          const finalTask = finalParent.subagents[0]!;
          assert.lengthOf(finalParent.subagents, 1);
          assert.equal(finalTask.id, task.id);
          assert.equal(finalTask.status, outcome === "failure" ? "failed" : "completed");
          const child = yield* orchestrator.getThreadProjection(childId);
          assert.equal(child.runs[1]?.delegatedTaskId, task.id);
          assert.isFalse(yield* orchestrator.delegatedTaskResultPending(childId, task.id));
          const sink = yield* EventSink.EventSinkV2;
          const latestSequence = yield* sink.latestSequence({ threadId: parentId });
          const terminalEvents = yield* sink.stream({ threadId: parentId, afterSequence: 0 }).pipe(
            Stream.takeUntil((stored) => stored.sequence >= latestSequence),
            Stream.runCollect,
          );
          assert.lengthOf(
            terminalEvents.filter(
              (stored) =>
                stored.event.type === "subagent.updated" &&
                stored.event.payload.id === task.id &&
                stored.event.payload.status === finalTask.status,
            ),
            1,
          );
          yield* orchestrator.recoverDelegatedTasks;
          assert.deepEqual(
            (yield* orchestrator.getThreadProjection(parentId)).subagents[0],
            finalTask,
          );
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              { name: "failure-continuation-delegated" },
              ProviderAdapterRegistry.layerSingle(
                fixtureAdapter(turns, capacity, undefined, outcome === "failure"),
              ),
              { continueAfterProviderFailure: true },
            ),
          ),
        );
      }),
    ),
);

const continuationCommand = (source: OrchestrationV2Run) => ({
  type: "message.dispatch" as const,
  commandId: CommandId.make(`command:failure-continuation:${source.id}`),
  messageId: MessageId.make(`message:failure-continuation:${source.id}`),
  threadId: source.threadId,
  text: "continue",
  attachments: [],
  createdBy: "agent" as const,
  creationSource: "server" as const,
  dispatchMode: { type: "start_immediately" as const },
  failureContinuationOfRunId: source.id,
});

it.effect("replayed running outbox effect cannot spend the budget after dispatch committed", () =>
  scenario(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const source = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
      yield* TestClock.adjust("30 seconds");
      assert.isTrue(
        Option.isSome(
          yield* outbox.claimNext({ workerId: "crashed-worker", leaseDurationMs: 60_000 }),
        ),
      );
      yield* orchestrator.dispatch(continuationCommand(source));
      yield* worker.drain();
      yield* Fiber.join(yield* awaitRun("failed", 2));
      yield* outbox.reconcileAfterProcessLoss;
      yield* worker.drain();
      assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 2);
    }),
    { runEffectWorker: false, failContinuation: true, expectedStartedTurns: 2 },
  ),
);

it.effect(
  "configuration change between committed dispatch and provider start withholds the turn",
  () =>
    scenario(
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const source = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        yield* TestClock.adjust("30 seconds");
        yield* orchestrator.dispatch(continuationCommand(source));
        yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
          responseStreamingMode: "paragraph",
        });
        yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
        yield* Fiber.join(yield* awaitRun("failed", 2));
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).runs[1]?.automaticContinuation
            ?.status,
          "exhausted",
        );
      }),
      { runEffectWorker: false, expectedStartedTurns: 1 },
    ),
);

it.effect("does not schedule when configuration changed during the failed source turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const terminal = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const turns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>([]);
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch(create);
        yield* orchestrator.dispatch(send("original"));
        yield* Deferred.await(started);
        yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
          responseStreamingMode: "paragraph",
        });
        yield* Deferred.succeed(terminal, undefined);
        yield* Fiber.join(yield* awaitRun("failed", 1));
        assert.isUndefined(
          (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.automaticContinuation,
        );
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "failure-continuation-source-config" },
            ProviderAdapterRegistry.layerSingle(
              fixtureAdapter(turns, capacity, undefined, false, {
                beforeTerminal: Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(terminal)),
                ),
              }),
            ),
            { continueAfterProviderFailure: true },
          ),
        ),
      );
    }),
  ),
);

it.effect.each(["weak", "broken"] as const)(
  "excludes %s saved conversations",
  (unsafeConversation) =>
    scenario(
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        assert.isUndefined(
          (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.automaticContinuation,
        );
        yield* TestClock.adjust("1 hour");
        yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
      }),
      { unsafeConversation, expectedStartedTurns: 1 },
    ),
);

it.effect("an autonomous server wake retains the failure-chain budget", () =>
  scenario(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* orchestrator.dispatch({
        ...send("server-wake"),
        createdBy: "agent",
        creationSource: "server",
        text: "continue",
      });
      yield* worker.drain();
      yield* Fiber.join(yield* awaitRun("failed", 2));
      yield* TestClock.adjust("1 hour");
      yield* worker.drain();
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.lengthOf(projection.runs, 2);
      assert.equal(projection.runs[1]?.failureContinuationOfRunId, projection.runs[0]?.id);
      assert.equal(projection.runs[1]?.automaticContinuation?.status, "exhausted");
    }),
    { runEffectWorker: false, failContinuation: true, expectedStartedTurns: 2 },
  ),
);

it.effect.each([
  {
    class: "provider_error" as const,
    code: "503",
    retryable: true,
    message: "Service unavailable",
  },
  {
    class: "transport_error" as const,
    code: "ECONNRESET",
    retryable: true,
    message: "Connection reset",
  },
])("continues classified $class terminal failures", (failure) =>
  scenario(
    Effect.gen(function* () {
      yield* TestClock.adjust("30 seconds");
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
      yield* Fiber.join(yield* awaitRun("completed", 2));
      assert.lengthOf(
        (yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(threadId)).runs,
        2,
      );
    }),
    { failure, expectedStartedTurns: 2 },
  ),
);
