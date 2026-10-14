import * as CommandPolicy from "../../orchestration-v2/CommandPolicy.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  OrchestrationV2ConversationMessage,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  ZCodeSettings,
} from "@t3tools/contracts";
import * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  makeZCodeSessionRuntime,
  layer as nativeRuntimeLayer,
  ZCodeSessionRuntime,
  ProviderAdapterProcessError,
  type ZCodeSessionEvent,
  type NativeSessionInput,
} from "./ZCodeSessionRuntime.ts";
import { makeZCodeAdapterV2 } from "./ZCodeAdapterV2.ts";
import { nativeUsageFixture } from "./ZCodeUsage.testkit.ts";
import { readZCodeTurnUsage } from "./ZCodeTurnUsage.ts";

const isV2Event = Schema.is(Adapter.ProviderAdapterV2Event);
const decodeSettings = Schema.decodeEffect(ZCodeSettings);
const decodeWire = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const instanceId = ProviderInstanceId.make("zcode-v2-test");
const threadId = ThreadId.make("app-thread");
const providerSessionId = ProviderSessionId.make("app-session");
const selection = {
  instanceId,
  model: "GLM-5.3",
  options: [{ id: "reasoningLevel", value: "low" }],
};
const policy: Adapter.ProviderAdapterV2RuntimePolicy = {
  runtimeMode: "approval-required",
  interactionMode: "default",
  cwd: "/workspace",
};
const layer = Layer.merge(NodeServices.layer, McpProviderSessions.layer);
type EventInput = ZCodeSessionEvent extends infer E
  ? E extends ZCodeSessionEvent
    ? Omit<E, "createdAt" | "providerInstanceId" | "threadId">
    : never
  : never;

const turnInput = (
  providerThread: Adapter.ProviderAdapterV2TurnInput["providerThread"],
  ordinal = 1,
): Adapter.ProviderAdapterV2TurnInput => {
  const at = DateTime.makeUnsafe("2026-10-13T10:00:00Z");
  return {
    threadId,
    runId: RunId.make(`run-${ordinal}`),
    runOrdinal: ordinal,
    providerTurnOrdinal: ordinal,
    attemptId: RunAttemptId.make(`attempt-${ordinal}`),
    rootNodeId: NodeId.make(`node-${ordinal}`),
    providerThread,
    message: {
      messageId: MessageId.make(`message-${ordinal}`),
      text: "hello",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection: selection,
    runtimePolicy: policy,
    appThread: {
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "ZCode test",
      providerInstanceId: instanceId,
      modelSelection: selection,
      runtimeMode: policy.runtimeMode,
      interactionMode: policy.interactionMode,
      branch: null,
      worktreePath: policy.cwd,
      activeProviderThreadId: providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  };
};

const observe = (runtime: Adapter.ProviderAdapterV2SessionRuntime) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Adapter.ProviderAdapterV2Event>();
    const events: Adapter.ProviderAdapterV2Event[] = [];
    const pull = yield* Stream.toPull(runtime.events);
    yield* Stream.runForEach(Stream.fromPull(Effect.succeed(pull)), (event) =>
      Effect.gen(function* () {
        events.push(event);
        yield* Queue.offer(queue, event);
      }),
    ).pipe(Effect.forkScoped({ startImmediately: true }));
    const next = (
      matches: (event: Adapter.ProviderAdapterV2Event) => boolean,
    ): Effect.Effect<Adapter.ProviderAdapterV2Event> =>
      Effect.gen(function* () {
        while (true) {
          const event = yield* Queue.take(queue);
          expect(isV2Event(event)).toBe(true);
          if (matches(event)) return event;
        }
      });
    return { events, next };
  });

const makeHarness = (initialPolicy = policy) =>
  Effect.gen(function* () {
    const native = yield* PubSub.unbounded<ZCodeSessionEvent>();
    const starts: NativeSessionInput[] = [];
    const decisions: string[] = [];
    const optionIds: Array<string | undefined> = [];
    let stopped = 0;
    let count = 0;
    const publish = (event: EventInput) =>
      PubSub.publish(native, {
        ...event,
        providerInstanceId: instanceId,
        threadId,
        createdAt: DateTime.makeUnsafe("2026-10-13T10:00:00Z"),
      } as ZCodeSessionEvent).pipe(Effect.asVoid);
    let send: ZCodeSessionRuntime["Service"]["sendTurn"] = () =>
      Effect.succeed({
        threadId,
        turnId: TurnId.make(`native-${++count}`),
        resumeCursor: { sessionId: "sess_native" },
      });
    let snapshotMessages: ReadonlyArray<unknown> = [
      {
        info: {
          messageId: "durable-user-message",
          role: "user",
          time: { created: 1_728_811_200_000 },
        },
        parts: [{ type: "text", text: "original request" }],
      },
      {
        info: {
          messageId: "durable-message",
          role: "assistant",
          time: { created: 1_728_811_201_000, completed: 1_728_811_202_000 },
        },
        parts: [{ type: "text", text: "durable native history" }],
      },
      {
        info: { messageId: "invalid-time", role: "assistant", time: { created: 1e20 } },
        parts: [{ type: "text", text: "unrepresentable timestamp" }],
      },
    ];
    const bridge: ZCodeSessionRuntime["Service"] = {
      startSession: (input) =>
        Effect.sync(() => {
          starts.push(input);
          return {
            threadId,
            providerInstanceId: instanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            createdAt: DateTime.makeUnsafe("2026-10-13T10:00:00Z"),
            updatedAt: "2026-10-13T10:00:00Z",
            resumeCursor: { sessionId: "sess_native" },
          };
        }),
      sendTurn: (input) => send(input),
      interruptTurn: () => Effect.void,
      respondToRequest: (_thread, id, decision, optionId) =>
        Effect.gen(function* () {
          decisions.push(decision);
          optionIds.push(optionId);
          yield* publish({
            type: "request.resolved",
            requestId: RuntimeRequestId.make(id),
            payload: {
              requestType: "permission_approval",
              decision,
              ...(optionId ? { optionId } : {}),
            },
          });
        }),
      respondToUserInput: () => Effect.void,
      readNativeSnapshot: () =>
        Effect.succeed({
          session: { sessionId: "sess_native", status: "idle" },
          messages: snapshotMessages,
        }),
      forkNativeHead: () => Effect.succeed("sess_forked"),
      stopSession: () =>
        Effect.sync(() => {
          stopped++;
        }),
      hasSession: () => Effect.succeed(true),
      listSessions: () => Effect.succeed([]),
      streamEvents: Stream.fromPubSub(native),
    };
    const adapter = yield* makeZCodeAdapterV2(instanceId).pipe(
      Effect.provideService(ZCodeSessionRuntime, bridge),
    );
    const runtimeScope = yield* Scope.fork(yield* Scope.Scope);
    const runtime = yield* adapter
      .openSession({
        threadId,
        providerSessionId,
        modelSelection: selection,
        runtimePolicy: initialPolicy,
      })
      .pipe(Effect.provideService(Scope.Scope, runtimeScope));
    const observed = yield* observe(runtime);
    const thread = yield* runtime.ensureThread({
      threadId,
      modelSelection: selection,
      runtimePolicy: initialPolicy,
    });
    return {
      adapter,
      runtime,
      closeRuntime: Scope.close(runtimeScope, Exit.void),
      thread,
      observed,
      publish,
      starts,
      decisions,
      optionIds,
      setMessages: (messages: ReadonlyArray<unknown>) =>
        Effect.sync(() => {
          snapshotMessages = messages;
        }),
      stopped: () => stopped,
      sendWith: (handler: typeof send) => {
        send = handler;
      },
    };
  });

const harness = makeHarness();

it.live("forks the native checkpoint into a separately owned app thread", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const fork = yield* h.runtime.forkThread({
      sourceProviderThread: h.thread,
      targetThreadId: ThreadId.make("fork-target"),
    });
    expect(fork).toMatchObject({
      appThreadId: "fork-target",
      providerSessionId: null,
      status: "not_loaded",
      nativeThreadRef: { nativeId: "sess_forked" },
      forkedFrom: { providerThreadId: h.thread.id },
    });
    for (const input of [
      { sourceProviderThread: h.thread, targetThreadId: threadId },
      {
        sourceProviderThread: h.thread,
        targetThreadId: ThreadId.make("fork-target"),
        providerTurnId: ProviderTurnId.make("unsupported-turn"),
      },
      {
        sourceProviderThread: { ...h.thread, appThreadId: ThreadId.make("foreign") },
        targetThreadId: ThreadId.make("fork-target"),
      },
    ])
      expect(Exit.isFailure(yield* h.runtime.forkThread(input).pipe(Effect.exit))).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("reads the native snapshot only for the owned provider thread", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    expect((yield* h.adapter.getCapabilities()).threads.canReadThreadSnapshot).toBe(true);
    const snapshot = yield* h.runtime.readThreadSnapshot({ providerThread: h.thread });
    expect(snapshot.providerPayload).toMatchObject({ session: { sessionId: "sess_native" } });
    expect(
      (
        snapshot.providerPayload as { messages: Array<{ info: { messageId: string } }> }
      ).messages.map((message) => message.info.messageId),
    ).toContain("durable-message");
    expect(snapshot.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "original request"],
      ["assistant", "durable native history"],
    ]);
    expect(snapshot.messages.every((message) => message.threadId === threadId)).toBe(true);
    expect(snapshot.messages.every(Schema.is(OrchestrationV2ConversationMessage))).toBe(true);
    const foreign = yield* h.runtime
      .readThreadSnapshot({
        providerThread: { ...h.thread, appThreadId: ThreadId.make("foreign") },
      })
      .pipe(Effect.exit);
    expect(Exit.isFailure(foreign)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live(
  "projects streamed messages, tool failures, native goal and usage with V2 attempt attribution",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const usage = readZCodeTurnUsage(nativeUsageFixture, true);
      h.sendWith(() =>
        Effect.gen(function* () {
          yield* h.publish({
            type: "content.delta",
            turnId: TurnId.make("early"),
            itemId: RuntimeItemId.make("part"),
            payload: { streamKind: "assistant_text", delta: "reply" },
          });
          yield* h.publish({
            type: "content.delta",
            turnId: TurnId.make("early"),
            payload: { streamKind: "reasoning_text", delta: "reason" },
          });
          yield* h.publish({
            type: "item.completed",
            turnId: TurnId.make("early"),
            itemId: RuntimeItemId.make("tool"),
            payload: {
              itemType: "command_execution",
              title: "Bash",
              status: "failed",
              detail: "Permission denied",
            },
          });
          yield* h.publish({
            type: "thread.metadata.updated",
            payload: {
              metadata: {
                goal: {
                  objective: "finish the task",
                  status: "complete",
                  tokensUsed: 37,
                  tokenBudget: null,
                  timeUsedSeconds: 2,
                },
              },
            },
          });
          yield* h.publish({
            type: "turn.completed",
            turnId: TurnId.make("early"),
            payload: { state: "completed", tokenUsage: usage },
          });
          return {
            threadId,
            turnId: TurnId.make("early"),
            resumeCursor: { sessionId: "sess_native" },
          };
        }),
      );
      yield* h.runtime.startTurn(turnInput(h.thread));
      yield* h.observed.next((event) => event.type === "turn.terminal");
      expect(h.observed.events.filter((event) => event.type === "turn.terminal")).toHaveLength(1);
      expect(
        h.observed.events.findLast((event) => event.type === "provider_turn.updated"),
      ).toMatchObject({
        providerTurn: {
          status: "completed",
          turnTokenUsage: usage,
          runAttemptId: "attempt-1",
          nodeId: "node-1",
        },
      });
      expect(h.observed.events.findLast((event) => event.type === "message.updated")).toMatchObject(
        {
          message: { text: "reply", streaming: false, threadId, runId: "run-1", nodeId: "node-1" },
        },
      );
      expect(
        h.observed.events.find(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool",
        ),
      ).toMatchObject({
        turnItem: {
          status: "failed",
          output: "Permission denied",
          nativeItemRef: { nativeId: "tool" },
        },
      });
      expect(
        h.observed.events.find(
          (event) => event.type === "provider_thread.updated" && event.providerThread.goal,
        ),
      ).toMatchObject({ providerThread: { goal: { status: "complete", tokensUsed: 37 } } });
      const reactivated = yield* h.runtime.ensureThread({
        threadId,
        modelSelection: selection,
        runtimePolicy: policy,
        existingProviderThread: h.thread,
      });
      expect(reactivated.goal).toMatchObject({ status: "complete", tokensUsed: 37 });
    }).pipe(Effect.scoped, Effect.timeout("10 seconds"), Effect.provide(layer)),
);

it.live.each(["import", "resume", "legacy", "weak", "fork", "missing-head"] as const)(
  "reconciles %s native history into stable UI message events without duplicating the transcript",
  (mode) =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.closeRuntime;
      const runtime = yield* h.adapter.openSession({
        threadId,
        providerSessionId,
        modelSelection: selection,
        runtimePolicy: policy,
        initialNativeThreadId: "sess_native",
      });
      const observed = yield* observe(runtime);
      const existing = {
        ...h.thread,
        ...(mode === "fork" ? { forkedFrom: { providerThreadId: h.thread.id } } : {}),
        ...(["resume", "weak", "missing-head"].includes(mode)
          ? {
              nativeConversationHeadRef: {
                driver: h.thread.driver,
                nativeId: mode === "missing-head" ? "unknown" : "durable-user-message",
                strength: mode === "weak" ? ("weak" as const) : ("strong" as const),
              },
            }
          : {}),
      };
      const result = yield* runtime
        .ensureThread({
          threadId,
          modelSelection: selection,
          runtimePolicy: policy,
          ...(mode === "import" ? {} : { existingProviderThread: existing }),
        })
        .pipe(Effect.exit);
      if (mode === "missing-head") {
        expect(Exit.isFailure(result)).toBe(true);
        expect(observed.events.filter((event) => event.type === "message.updated")).toEqual([]);
        return;
      }
      if (Exit.isFailure(result)) return yield* Effect.die("History activation failed");
      yield* observed.next(
        (event) =>
          event.type === "provider_session.updated" && event.providerSession.status === "ready",
      );
      const messages = observed.events.flatMap((event) =>
        event.type === "message.updated" ? [event.message] : [],
      );
      expect(messages.map((message) => message.text)).toEqual(
        mode === "import" || mode === "fork"
          ? ["original request", "durable native history"]
          : mode === "resume"
            ? ["durable native history"]
            : [],
      );
      expect(messages.every(Schema.is(OrchestrationV2ConversationMessage))).toBe(true);
      expect(messages.every((message) => message.id.startsWith(`zcode:${threadId}:`))).toBe(true);
      yield* runtime.resumeThread({
        providerThread: result.value,
        modelSelection: selection,
        runtimePolicy: policy,
      });
      yield* observed.next(
        (event) =>
          event.type === "provider_session.updated" && event.providerSession.status === "ready",
      );
      expect(observed.events.filter((event) => event.type === "message.updated")).toHaveLength(
        messages.length,
      );
      const snapshot = yield* runtime.readThreadSnapshot({ providerThread: result.value });
      const raw = snapshot.providerPayload as { messages: ReadonlyArray<unknown> };
      yield* h.setMessages([
        ...raw.messages,
        {
          info: {
            messageId: "new-native-message",
            role: "assistant",
            time: { created: 1_728_811_203_000 },
          },
          parts: [{ type: "text", text: "durable native history" }],
        },
      ]);
      yield* runtime.resumeThread({
        providerThread: result.value,
        modelSelection: selection,
        runtimePolicy: policy,
      });
      yield* observed.next(
        (event) =>
          event.type === "provider_session.updated" && event.providerSession.status === "ready",
      );
      const imported = observed.events.filter((event) => event.type === "message.updated");
      expect(imported).toHaveLength(messages.length + 1);
      expect(imported.at(-1)).toMatchObject({
        message: {
          id: `zcode:${threadId}:new-native-message`,
          text: "durable native history",
        },
      });
    }).pipe(Effect.scoped, Effect.timeout("5 seconds"), Effect.provide(layer)),
);

it.live(
  "deduplicates native and UI resolutions, preserves offered scopes and structured questions",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.runtime.startTurn(turnInput(h.thread));
      const open: EventInput = {
        type: "request.opened",
        turnId: TurnId.make("native-1"),
        requestId: RuntimeRequestId.make("permission"),
        payload: {
          requestType: "permission_approval",
          options: [
            {
              optionId: "session-tool",
              label: "Allow this tool for session",
              decision: "acceptForSession",
            },
            {
              optionId: "session-rule",
              label: "Allow this rule for session",
              decision: "acceptForSession",
            },
            { label: "Deny", decision: "decline" },
          ],
        },
      };
      yield* h.publish(open);
      yield* h.publish(open);
      const opened = yield* h.observed.next((event) => event.type === "runtime_request.updated");
      if (opened.type !== "runtime_request.updated") return yield* Effect.die("missing request");
      expect(
        Exit.isFailure(
          yield* h.runtime
            .respondToRuntimeRequest({
              requestId: opened.runtimeRequest.id,
              decision: "acceptAlways",
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true);
      for (const optionId of [undefined, "unknown", "session-tool"]) {
        expect(
          Exit.isFailure(
            yield* h.runtime
              .respondToRuntimeRequest({
                requestId: opened.runtimeRequest.id,
                decision: optionId === "session-tool" ? "accept" : "acceptForSession",
                ...(optionId === undefined ? {} : { optionId }),
              })
              .pipe(Effect.exit),
          ),
        ).toBe(true);
      }
      yield* h.runtime.respondToRuntimeRequest({
        requestId: opened.runtimeRequest.id,
        decision: "acceptForSession",
        optionId: "session-rule",
      });
      yield* h.observed.next(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "resolved",
      );
      yield* h.publish({
        type: "user-input.requested",
        turnId: TurnId.make("native-1"),
        requestId: RuntimeRequestId.make("question"),
        payload: {
          questions: [
            {
              id: "q",
              header: "Choose",
              question: "Which?",
              multiSelect: true,
              options: [{ label: "one", description: "first" }],
            },
          ],
        },
      });
      const question = yield* h.observed.next(
        (event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "user_input_request",
      );
      expect(question).toMatchObject({ turnItem: { questions: [{ multiSelect: true }] } });
      yield* h.publish({
        type: "user-input.resolved",
        requestId: RuntimeRequestId.make("question"),
        payload: { answers: { q: ["one"] } },
      });
      yield* h.observed.next(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.answers !== undefined,
      );
      expect(h.decisions).toEqual(["acceptForSession"]);
      expect(h.optionIds).toEqual(["session-rule"]);
      expect(
        h.observed.events.filter(
          (event) =>
            event.type === "runtime_request.updated" &&
            event.runtimeRequest.id === opened.runtimeRequest.id,
        ),
      ).toHaveLength(2);
      expect(
        Exit.isFailure(
          yield* h.runtime
            .respondToRuntimeRequest({
              requestId: opened.runtimeRequest.id,
              decision: "acceptForSession",
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.timeout("10 seconds"), Effect.provide(layer)),
);

it.live("isolates interrupted attempts from late events and settles pending interactions", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.runtime.startTurn(turnInput(h.thread));
    yield* h.publish({
      type: "request.opened",
      turnId: TurnId.make("native-1"),
      requestId: RuntimeRequestId.make("old"),
      payload: { requestType: "permission_approval" },
    });
    const request = yield* h.observed.next((event) => event.type === "runtime_request.updated");
    const started = yield* h.observed.next((event) => event.type === "turn_item.updated");
    if (started.type !== "turn_item.updated") return yield* Effect.die("missing item");
    if (!started.turnItem.providerTurnId) return yield* Effect.die("missing turn identity");
    yield* h.runtime.interruptTurn({
      providerThread: h.thread,
      providerTurnId: started.turnItem.providerTurnId,
    });
    yield* h.observed.next((event) => event.type === "turn.terminal");
    yield* h.runtime.startTurn(turnInput(h.thread, 2));
    yield* h.publish({
      type: "content.delta",
      turnId: TurnId.make("native-1"),
      payload: { streamKind: "assistant_text", delta: "old" },
    });
    yield* h.publish({
      type: "turn.completed",
      turnId: TurnId.make("native-1"),
      payload: { state: "completed" },
    });
    yield* h.publish({
      type: "content.delta",
      turnId: TurnId.make("native-2"),
      payload: { streamKind: "assistant_text", delta: "new" },
    });
    yield* h.publish({
      type: "turn.completed",
      turnId: TurnId.make("native-2"),
      payload: { state: "completed" },
    });
    yield* h.observed.next((event) => event.type === "turn.terminal" && event.runOrdinal === 2);
    expect(h.observed.events.filter((event) => event.type === "turn.terminal")).toHaveLength(2);
    expect(
      h.observed.events
        .filter((event) => event.type === "message.updated")
        .every((event) => event.message.text === "new" && event.message.runId === "run-2"),
    ).toBe(true);
    if (request.type === "runtime_request.updated")
      expect(
        h.observed.events.find(
          (event) =>
            event.type === "runtime_request.updated" &&
            event.runtimeRequest.id === request.runtimeRequest.id &&
            event.runtimeRequest.status === "cancelled",
        ),
      ).toBeDefined();
  }).pipe(Effect.scoped, Effect.timeout("10 seconds"), Effect.provide(layer)),
);

it.live("fails a rejected startup once and preserves unknown usage", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    h.sendWith(() =>
      Effect.fail(
        new ProviderAdapterProcessError({
          provider: "zcode",
          threadId,
          detail: "Synthetic failure",
        }),
      ),
    );
    expect(Exit.isFailure(yield* h.runtime.startTurn(turnInput(h.thread)).pipe(Effect.exit))).toBe(
      true,
    );
    const terminal = yield* h.observed.next((event) => event.type === "turn.terminal");
    expect(terminal).toMatchObject({ status: "failed", failure: { class: "provider_error" } });
    expect(
      h.observed.events.findLast((event) => event.type === "provider_turn.updated"),
    ).toMatchObject({ providerTurn: { status: "failed" } });
    expect(
      h.observed.events.findLast((event) => event.type === "provider_turn.updated"),
    ).not.toHaveProperty("providerTurn.turnTokenUsage");
  }).pipe(Effect.scoped, Effect.timeout("10 seconds"), Effect.provide(layer)),
);

it.live("rejects foreign ownership and policy escalation before reaching the native bridge", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const input = turnInput(h.thread);
    for (const invalid of [
      { ...input, threadId: ThreadId.make("foreign") },
      {
        ...input,
        modelSelection: { ...selection, instanceId: ProviderInstanceId.make("foreign") },
      },
      { ...input, runtimePolicy: { ...policy, sandboxPolicy: "danger-full-access" } },
    ]) {
      expect(Exit.isFailure(yield* h.runtime.startTurn(invalid).pipe(Effect.exit))).toBe(true);
    }
    expect(
      Exit.isFailure(
        yield* h.adapter
          .openSession({
            threadId,
            providerSessionId,
            modelSelection: selection,
            runtimePolicy: policy,
          })
          .pipe(Effect.exit),
      ),
    ).toBe(true);
    expect(
      h.observed.events.filter((event) => event.type === "provider_turn.updated"),
    ).toHaveLength(0);
    expect(
      Exit.isFailure(
        yield* h.runtime
          .resumeThread({
            providerThread: { ...h.thread, providerInstanceId: ProviderInstanceId.make("foreign") },
          })
          .pipe(Effect.exit),
      ),
    ).toBe(true);
  }).pipe(Effect.scoped, Effect.timeout("10 seconds"), Effect.provide(layer)),
);

it.live("revocation interrupts once, closes the native owner and blocks stale handles", () =>
  Effect.gen(function* () {
    const sessions = yield* McpProviderSessions.McpProviderSessions;
    // The fake credential is deliberately never supplied to a provider process.
    yield* sessions.set({
      threadId,
      providerSessionId: "independent-mcp-credential-id",
      providerInstanceId: instanceId,
      environmentId: "test" as never,
      endpoint: "http://127.0.0.1/test",
      authorizationHeader: "synthetic",
      browserToolsAvailable: false,
    });
    const h = yield* harness;
    yield* h.runtime.startTurn(turnInput(h.thread));
    yield* sessions.clear(threadId);
    yield* h.observed.next(
      (event) =>
        event.type === "provider_session.updated" && event.providerSession.status === "stopped",
    );
    expect(h.stopped()).toBe(1);
    expect(h.observed.events.filter((event) => event.type === "turn.terminal")).toHaveLength(1);
    expect(
      Exit.isFailure(yield* h.runtime.startTurn(turnInput(h.thread, 2)).pipe(Effect.exit)),
    ).toBe(true);
  }).pipe(Effect.scoped, Effect.timeout("10 seconds"), Effect.provide(layer)),
);

// Synthetic app-server transport following the pinned vendor session/goal
// contract. This fixture is a Node process, never a vendor runtime or LLM.
const appServerFixture = `#!/usr/bin/env node
const fs = require('node:fs');
const sessionId = 'sess_v2_fixture';
const statePath = process.env.HOME + '/goal.json';
let goal = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
let inputId; let nativeTurnId; let turnSequence=0;
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const event = (type, payload) => {if(type==='turn.started')nativeTurnId='native-goal-'+(++turnSequence);send({method:'session/event', params:{sessionId, type, payload, turnId:nativeTurnId}});};
const snapshot = () => ({session:{sessionId, status:'idle', target:goal},messages:[]});
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const message = JSON.parse(line);
 fs.appendFileSync(process.env.HOME + '/wire.jsonl', line + '\\n');
 const {id, method, params={}} = message;
 if (!method) {
  if (id === 'permission') {
   const allowed = message.result?.decision === 'allow';
   goal = {...goal, status:allowed?'complete':'paused', tokensUsed:37};
   fs.writeFileSync(statePath, JSON.stringify(goal));
   event('session.updated', {target:goal});
   event('tool.updated', {kind:allowed?'result':'error', toolCallId:'native-tool', toolName:'Bash', result:{output:'native result'}, error:{message:'Permission denied'}});
   event('turn.completed', {inputId, ...${JSON.stringify(nativeUsageFixture)}, resultType:allowed?'success':'cancelled'});
   send({method:'state.updated', params:{type:'state.updated',scope:'session',sessionId,revision:1,reason:'goal_continuation_completed',patch:{}}});
  }
  return;
 }
 if (method === 'session/create' || method === 'session/resume' || method === 'session/read') send({id,result:snapshot()});
 else if (method === 'session/subscribe') send({id,result:{sessionId,eventSeq:0,events:[]}});
 else if (method === 'session/goal') {
  inputId=params.inputId;
  goal={objective:params.objective,status:'active',tokensUsed:0,tokenBudget:null,timeUsedSeconds:0};
  fs.writeFileSync(statePath,JSON.stringify(goal));
  event('session.updated',{target:goal});
  send({id,result:{snapshot:snapshot(),response:'Goal active',startedTurn:true}});
  event('turn.started',{inputId});
  event('model.streaming',{kind:'text_delta',delta:'first iteration'});
  event('turn.completed',{inputId,...${JSON.stringify(nativeUsageFixture)},resultType:'success'});
  event('turn.completed',{inputId,...${JSON.stringify(nativeUsageFixture)},resultType:'success'});
  event('turn.started',{inputId});
  send({id:'permission',method:'interaction/requestPermission',params:{requestId:'native-request',toolName:'Bash',reason:'Goal approval',options:[{optionId:'allow',kind:'allow_once',name:'Allow',response:{decision:'allow'}},{optionId:'deny',kind:'deny',name:'Deny',response:{decision:'deny'}}]}});
 } else send({id,result:{}});
});
`;

it.live.each(["accept", "decline", "cancel", "interrupt"] as const)(
  "bridges the real app-server transport, native goal %s and cold resume into V2",
  (decision) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "zcode-v2-fixture-" });
      const binary = `${directory}/runtime.cjs`;
      yield* fs.writeFileString(binary, appServerFixture);
      yield* fs.chmod(binary, 0o700);
      const settings = yield* decodeSettings({
        enabled: true,
        binaryPath: binary,
        ...(decision === "cancel" ? { sessionEngine: "turn" } : {}),
      });
      const adapter = yield* makeZCodeAdapterV2(instanceId).pipe(
        Effect.provide(
          nativeRuntimeLayer(settings, {
            instanceId,
            environment: { PATH: process.env.PATH, HOME: directory },
            attachmentsDir: directory,
          }),
        ),
      );
      const nativePolicy = { ...policy, cwd: directory };
      const scope = yield* Scope.fork(yield* Effect.scope);
      const runtime = yield* adapter
        .openSession({
          threadId,
          providerSessionId,
          modelSelection: selection,
          runtimePolicy: nativePolicy,
        })
        .pipe(Effect.provideService(Scope.Scope, scope));
      const observed = yield* observe(runtime);
      const thread = yield* runtime.ensureThread({
        threadId,
        modelSelection: selection,
        runtimePolicy: nativePolicy,
      });
      const input = turnInput(thread);
      yield* runtime.startTurn({
        ...input,
        runtimePolicy: nativePolicy,
        message: { ...input.message, text: "/goal complete fixture" },
      });
      const request = yield* observed.next(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      );
      expect(observed.events.filter((event) => event.type === "turn.terminal")).toHaveLength(0);
      if (request.type !== "runtime_request.updated") return yield* Effect.die("missing approval");
      if (decision === "interrupt") {
        const turn = observed.events.findLast((event) => event.type === "provider_turn.updated");
        if (turn?.type !== "provider_turn.updated") return yield* Effect.die("missing turn");
        yield* runtime.interruptTurn({
          providerThread: thread,
          providerTurnId: turn.providerTurn.id,
        });
      } else
        yield* runtime.respondToRuntimeRequest({ requestId: request.runtimeRequest.id, decision });
      const terminal = yield* observed.next((event) => event.type === "turn.terminal");
      expect(terminal).toMatchObject({
        status: decision === "accept" ? "completed" : "interrupted",
        threadDisposition: "reusable",
      });
      expect(
        observed.events.findLast((event) => event.type === "provider_turn.updated"),
      ).toMatchObject({
        providerTurn: {
          turnTokenUsage: {
            usageStatus:
              decision === "interrupt" ? "partial" : decision === "accept" ? "complete" : "partial",
            totalTokens: 74,
            inputTokens: 60,
            outputTokens: 14,
          },
        },
      });
      const latest = observed.events.findLast((event) => event.type === "provider_thread.updated");
      if (latest?.type !== "provider_thread.updated") return yield* Effect.die("missing thread");
      expect(latest.providerThread).toMatchObject({
        nativeThreadRef: { nativeId: "sess_v2_fixture" },
        goal: { status: decision === "accept" ? "complete" : "paused" },
      });
      yield* Scope.close(scope, Exit.void);
      const resumed = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("cold-session"),
        modelSelection: selection,
        runtimePolicy: nativePolicy,
      });
      const resumedEvents = yield* observe(resumed);
      const restored = yield* resumed.resumeThread({ providerThread: latest.providerThread });
      expect(restored.id).toBe(thread.id);
      expect(restored.nativeThreadRef?.nativeId).toBe("sess_v2_fixture");
      yield* resumedEvents.next(
        (event) =>
          event.type === "provider_thread.updated" && event.providerThread.goal !== undefined,
      );
      const wire = yield* Effect.forEach(
        (yield* fs.readFileString(`${directory}/wire.jsonl`)).trim().split("\n"),
        (line) => decodeWire(line),
      );
      expect(wire.filter((message) => message.method === "session/goal")).toHaveLength(1);
      expect(wire.some((message) => message.method === "session/send")).toBe(false);
      expect(wire.find((message) => message.method === "session/resume")).toMatchObject({
        params: { sessionId: "sess_v2_fixture" },
      });
    }).pipe(Effect.scoped, Effect.timeout("10 seconds"), Effect.provide(layer)),
);

it.live("settles runtime death once and resumes the retained native cursor", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.runtime.startTurn(turnInput(h.thread));
    yield* h.publish({
      type: "session.exited",
      payload: { reason: "Synthetic termination" },
    });
    yield* h.observed.next((event) => event.type === "turn.terminal");
    yield* h.publish({ type: "session.exited", payload: { reason: "Duplicate termination" } });
    yield* h.publish({
      type: "thread.metadata.updated",
      payload: { name: "termination processed" },
    });
    yield* h.observed.next(
      (event) =>
        event.type === "provider_thread.updated" &&
        event.providerThread.nativeMetadata?.title === "termination processed",
    );
    expect(h.observed.events.filter((event) => event.type === "turn.terminal")).toHaveLength(1);
    expect(h.observed.events.find((event) => event.type === "turn.terminal")).toMatchObject({
      status: "failed",
      threadDisposition: "broken",
      failure: { class: "transport_error" },
    });
    yield* h.runtime.resumeThread({ providerThread: h.thread });
    expect(h.starts[1]?.resumeCursor).toEqual({ sessionId: "sess_native" });
    yield* h.runtime.startTurn(turnInput(h.thread, 2));
  }).pipe(Effect.scoped, Effect.timeout("10 seconds"), Effect.provide(layer)),
);

it.live("closes the real transport before its scope on failure and releases thread ownership", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "zcode-v2-cleanup-" });
    const binary = `${directory}/runtime.cjs`;
    yield* fs.writeFileString(binary, appServerFixture);
    yield* fs.chmod(binary, 0o700);
    const settings = yield* decodeSettings({
      enabled: true,
      binaryPath: binary,
    });
    const bridge = yield* makeZCodeSessionRuntime(settings, {
      instanceId,
      environment: { PATH: process.env.PATH, HOME: directory },
    });
    const adapter = yield* makeZCodeAdapterV2(instanceId).pipe(
      Effect.provideService(ZCodeSessionRuntime, bridge),
    );
    const nativePolicy = { ...policy, cwd: directory };
    const failed = yield* Effect.gen(function* () {
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId,
        modelSelection: selection,
        runtimePolicy: nativePolicy,
      });
      yield* runtime.ensureThread({
        threadId,
        modelSelection: selection,
        runtimePolicy: nativePolicy,
      });
      return yield* Effect.fail("Synthetic caller failure");
    }).pipe(Effect.scoped, Effect.exit);
    expect(Exit.isFailure(failed)).toBe(true);
    expect(yield* bridge.hasSession(threadId)).toBe(false);
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId,
      modelSelection: selection,
      runtimePolicy: nativePolicy,
    });
    expect(
      (yield* runtime.ensureThread({
        threadId,
        modelSelection: selection,
        runtimePolicy: nativePolicy,
      })).nativeThreadRef?.nativeId,
    ).toBe("sess_v2_fixture");
  }).pipe(Effect.scoped, Effect.timeout("10 seconds"), Effect.provide(layer)),
);

const deathFixture = `#!/usr/bin/env node
const fs=require('node:fs');
const sessionId='sess_death_fixture'; let nativeTurnId;
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const event=(type,payload)=>send({method:'session/event',params:{sessionId,turnId:nativeTurnId,type,payload}});
fs.watch(process.env.HOME,(_,name)=>{if(name==='die')process.exit(7);});
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const {id,method,params={}}=JSON.parse(line);
 fs.appendFileSync(process.env.HOME+'/wire.jsonl',line+'\\n');
 if(method==='session/create'||method==='session/resume'||method==='session/read')send({id,result:{session:{sessionId,status:'idle'},messages:[]}});
 else if(method==='session/subscribe')send({id,result:{sessionId,eventSeq:0,events:[]}});
 else if(method==='session/send'){
  nativeTurnId='native-'+params.inputId;event('turn.started',{inputId:params.inputId});
  if(params.content==='before-ack'){process.exit(7);return;}
  send({id,result:{sessionId,accepted:true,stateRevision:1}});
  if(params.content==='active')send({id:'permission',method:'interaction/requestPermission',params:{sessionId,turnId:nativeTurnId,requestId:'permission',options:[]}});
  else {event('model.streaming',{kind:'text_delta',delta:'recovered'});event('turn.completed',{resultType:'success'});}
 }else if(method)send({id,result:{}});
});
`;

it.live.each(["idle", "active", "before-ack"] as const)(
  "invalidates actual stdio %s death once and resumes the retained native cursor",
  (mode) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "zcode-v2-death-" });
      const binary = `${directory}/runtime.cjs`;
      yield* fs.writeFileString(binary, deathFixture);
      yield* fs.chmod(binary, 0o700);
      const settings = yield* decodeSettings({
        enabled: true,
        binaryPath: binary,
      });
      const bridge = yield* makeZCodeSessionRuntime(settings, {
        instanceId,
        environment: { PATH: process.env.PATH, HOME: directory },
      });
      const adapter = yield* makeZCodeAdapterV2(instanceId).pipe(
        Effect.provideService(ZCodeSessionRuntime, bridge),
      );
      const nativePolicy = { ...policy, cwd: directory };
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId,
        modelSelection: selection,
        runtimePolicy: nativePolicy,
      });
      const observed = yield* observe(runtime);
      const thread = yield* runtime.ensureThread({
        threadId,
        modelSelection: selection,
        runtimePolicy: nativePolicy,
      });
      if (mode !== "idle") {
        const input = turnInput(thread);
        const started = yield* Effect.exit(
          runtime.startTurn({
            ...input,
            runtimePolicy: nativePolicy,
            message: { ...input.message, text: mode },
          }),
        );
        expect(Exit.isFailure(started)).toBe(mode === "before-ack");
        if (mode === "active")
          yield* observed.next(
            (event) =>
              event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
          );
      }
      if (mode !== "before-ack") yield* fs.writeFileString(`${directory}/die`, "exit");
      yield* observed.next(
        (event) =>
          event.type === "provider_session.updated" && event.providerSession.status === "error",
      );
      expect(yield* bridge.hasSession(threadId)).toBe(false);
      expect(
        observed.events.filter(
          (event) =>
            event.type === "provider_session.updated" && event.providerSession.status === "error",
        ),
      ).toHaveLength(1);
      expect(observed.events.filter((event) => event.type === "turn.terminal")).toHaveLength(
        mode === "idle" ? 0 : 1,
      );
      if (mode !== "idle")
        expect(observed.events.find((event) => event.type === "turn.terminal")).toMatchObject({
          status: "failed",
          threadDisposition: "broken",
        });
      const deadThread = observed.events.findLast(
        (event) => event.type === "provider_thread.updated",
      );
      if (deadThread?.type !== "provider_thread.updated")
        return yield* Effect.die("missing dead thread");
      expect(deadThread.providerThread.nativeThreadRef).toEqual(thread.nativeThreadRef);
      const restored = yield* runtime.resumeThread({ providerThread: deadThread.providerThread });
      const input = turnInput(restored, 2);
      yield* runtime.startTurn({
        ...input,
        runtimePolicy: nativePolicy,
        message: { ...input.message, text: "recover" },
      });
      yield* observed.next(
        (event) => event.type === "turn.terminal" && event.status === "completed",
      );
      expect(observed.events.filter((event) => event.type === "turn.terminal")).toHaveLength(
        mode === "idle" ? 1 : 2,
      );
      const wire = yield* Effect.forEach(
        (yield* fs.readFileString(`${directory}/wire.jsonl`)).trim().split("\n"),
        (line) => decodeWire(line),
      );
      expect(wire.filter((message) => message.method === "session/create")).toHaveLength(1);
      expect(wire.filter((message) => message.method === "session/resume")).toMatchObject([
        { params: { sessionId: "sess_death_fixture" } },
      ]);
      expect(
        observed.events.filter(
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status !== "pending",
        ),
      ).toHaveLength(mode === "active" ? 1 : 0);
    }).pipe(Effect.scoped, Effect.timeout("10 seconds"), Effect.provide(layer)),
);

it.live.each(["delta_context", "full_thread_summary"] as const)(
  "delivers %s to an existing native ZCode session after a provider switch",
  (strategy) =>
    Effect.gen(function* () {
      const h = yield* harness;
      const commandPolicy = yield* CommandPolicy.CommandPolicyV2;
      yield* commandPolicy.ensureContextHandoff({
        commandId: CommandId.make("handoff-test"),
        threadId,
        providerInstanceId: instanceId,
        capabilities: yield* h.adapter.getCapabilities(),
        strategy,
      });
      const input = turnInput(h.thread);
      const handoffText =
        "Context handoff: Codex was limited after completing the requested review.\nContinue from the reviewed state.";
      let received: string | undefined;
      h.sendWith((nativeInput) =>
        Effect.sync(() => {
          received = nativeInput.input;
          return {
            threadId,
            turnId: TurnId.make("native-handoff"),
            resumeCursor: { sessionId: "sess_native" },
          };
        }),
      );
      yield* h.runtime.startTurn({ ...input, message: { ...input.message, text: handoffText } });
      expect(received).toBe(handoffText);
      expect(h.starts).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(layer, CommandPolicy.layer))),
);

it.live("keeps initial Plan interaction separate from the session sandbox", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ ...policy, interactionMode: "plan" });
    expect(h.starts[0]).toMatchObject({ interactionMode: "plan" });
    expect(h.starts[0]?.sandboxMode).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
