import {
  ApprovalRequestId,
  MessageId,
  type OrchestrationV2ConversationMessage,
  OrchestrationV2ProviderGoal,
  ProviderApprovalDecision,
  ProviderApprovalPolicy,
  ProviderSandboxMode,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  TurnItemId,
  type ModelSelection,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { McpProviderSessions } from "@t3tools/provider-core/server/McpProviderSessions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import { ZCodeSessionRuntime, type ZCodeSessionEvent } from "./ZCodeSessionRuntime.ts";

const isGoal = Schema.is(OrchestrationV2ProviderGoal);
const isDecision = Schema.is(ProviderApprovalDecision);
const isSandbox = Schema.is(ProviderSandboxMode);
const isApprovalPolicy = Schema.is(ProviderApprovalPolicy);
const driver = ProviderDriverKind.make("zcode");
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const readNativeHistoryMessages = (
  values: ReadonlyArray<unknown>,
  threadId: ThreadId,
): OrchestrationV2ConversationMessage[] =>
  values.flatMap((value) => {
    const message = record(value);
    const info = record(message.info);
    const role = info.role;
    const messageId = info.messageId;
    const time = record(info.time);
    if (
      (role !== "user" && role !== "assistant") ||
      typeof messageId !== "string" ||
      !messageId ||
      info.synthetic === true ||
      record(info.visibility).transcriptVisibility === "hidden" ||
      typeof time.created !== "number" ||
      !Number.isFinite(time.created)
    )
      return [];
    const text = Array.isArray(message.parts)
      ? message.parts
          .filter((part) => {
            const item = record(part);
            return item.type === "text" && item.synthetic !== true && item.ignored !== true;
          })
          .map((part) => record(part).text)
          .filter((part): part is string => typeof part === "string")
          .join("\n")
      : "";
    if (!text) return [];
    const createdAt = DateTime.make(time.created);
    const completedAt =
      typeof time.completed === "number" && Number.isFinite(time.completed)
        ? DateTime.make(time.completed)
        : createdAt;
    if (Option.isNone(createdAt) || Option.isNone(completedAt)) return [];
    return [
      {
        id: MessageId.make(
          `zcode:${encodeURIComponent(threadId)}:${encodeURIComponent(messageId)}`,
        ),
        threadId,
        runId: null,
        nodeId: null,
        role,
        text,
        attachments: [],
        streaming: false,
        createdBy: role === "user" ? "user" : "agent",
        creationSource: "provider",
        createdAt: createdAt.value,
        updatedAt: completedAt.value,
      },
    ];
  });
const nativeRef = (nativeId: string) => ({ driver, nativeId, strength: "strong" as const });
const nativeMessageId = (value: unknown): string | undefined => {
  const id = record(record(value).info).messageId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
};
const nativeHistoryHead = (messages: ReadonlyArray<unknown>) => {
  const id = nativeMessageId(messages.findLast((value) => nativeMessageId(value) !== undefined));
  return id === undefined ? null : nativeRef(id);
};
const cursorId = (session: {
  readonly resumeCursor?: { readonly sessionId: string };
}): string | undefined => {
  const id = record(session.resumeCursor).sessionId;
  return typeof id === "string" ? id : undefined;
};

const capabilities = (
  interactive: boolean,
  snapshot: boolean,
  fork: boolean,
): OrchestrationV2ProviderCapabilities => ({
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: interactive,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: interactive,
    canReadThreadSnapshot: interactive && snapshot,
    canRollbackThread: false,
    canForkThread: interactive && fork,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: false,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: interactive,
    supportsFileReadApproval: interactive,
    supportsFileChangeApproval: interactive,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: interactive,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: interactive && snapshot,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "none",
    nativeItemIds: "strong",
    nativeRequestIds: "none",
  },
  runtimePolicy: { enforcement: "native" },
});

interface Turn {
  readonly input: Adapter.ProviderAdapterV2TurnInput;
  providerTurn: OrchestrationV2ProviderTurn;
  inputId?: TurnId;
  readonly items: Map<string, OrchestrationV2TurnItem>;
  readonly requests: Map<
    RuntimeRequestId,
    { request: OrchestrationV2RuntimeRequest; nativeRequestId: ApprovalRequestId; itemKey: string }
  >;
  ordinal: number;
  settled: boolean;
}

/** T3 V2 projection of the native app-server session runtime. */
export const makeZCodeAdapterV2 = Effect.fn("makeZCodeAdapterV2")(function* (
  instanceId: ProviderInstanceId,
) {
  const native = yield* ZCodeSessionRuntime;
  const mcpSessions = yield* McpProviderSessions;
  const caps = capabilities(true, true, true);
  // One native child per app thread. Refuse simultaneous owners instead of borrowing its handles.
  const owners = new Set<ThreadId>();
  return Adapter.ProviderAdapterV2.of({
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(caps),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (open) =>
      Effect.gen(function* () {
        if (open.modelSelection.instanceId !== instanceId)
          return yield* new Adapter.ProviderAdapterOpenSessionError({
            driver,
            providerSessionId: open.providerSessionId,
            cause: "Model selection belongs to another provider instance",
          });
        if (owners.has(open.threadId))
          return yield* new Adapter.ProviderAdapterOpenSessionError({
            driver,
            providerSessionId: open.providerSessionId,
            cause: "Thread already has a live ZCode owner",
          });
        owners.add(open.threadId);
        let closed = false;
        let revoked = false;
        let runtimeLive = false;
        // MCP credential identity is allocated independently of V2 session identity.
        let mcpCredentialId = (yield* mcpSessions.read(open.threadId))?.providerSessionId;
        const metadataEvents: ZCodeSessionEvent[] = [];
        let providerThread: OrchestrationV2ProviderThread | undefined;
        let current: Turn | undefined;
        let pending: Turn | undefined;
        const buffered: ZCodeSessionEvent[] = [];
        const operations = yield* Semaphore.make(1);
        const translation = yield* Semaphore.make(1);
        // Register the child scope before our close finalizer so native close
        // RPCs run while the transport is still alive, including on failure.
        const nativeScope = yield* Scope.fork(yield* Effect.scope);
        let activePolicy = open.runtimePolicy;
        const now = yield* DateTime.now;
        let providerSession: OrchestrationV2ProviderSession = {
          id: open.providerSessionId,
          driver,
          providerInstanceId: instanceId,
          status: "ready" as Adapter.ProviderAdapterV2SessionStatus,
          cwd: open.runtimePolicy.cwd ?? process.cwd(),
          model: open.modelSelection.model,
          capabilities: caps,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        const events = yield* Queue.unbounded<Adapter.ProviderAdapterV2Event>();
        const emit = (event: Adapter.ProviderAdapterV2Event) =>
          Queue.offer(events, event).pipe(Effect.asVoid);
        const sessionStatus = (
          status: Adapter.ProviderAdapterV2SessionStatus,
          at: DateTime.Utc,
          lastError: string | null = null,
        ) => {
          providerSession = { ...providerSession, status, updatedAt: at, lastError };
          return emit({ type: "provider_session.updated", driver, providerSession });
        };
        const unsupported = (detail: string) =>
          new Adapter.ProviderAdapterProtocolError({ driver, detail });
        const checkThread = (thread: OrchestrationV2ProviderThread) =>
          Effect.gen(function* () {
            if (
              closed ||
              revoked ||
              !runtimeLive ||
              !providerThread ||
              thread.driver !== driver ||
              providerThread?.id !== thread.id ||
              thread.appThreadId !== open.threadId ||
              thread.providerInstanceId !== instanceId ||
              thread.providerSessionId !== open.providerSessionId
            )
              return yield* unsupported("Provider thread is not owned by this live session");
            return providerThread;
          });
        const emitThread = (thread: OrchestrationV2ProviderThread) => {
          providerThread = thread;
          return emit({ type: "provider_thread.updated", driver, providerThread: thread });
        };
        const itemBase = (turn: Turn, key: string, at: DateTime.Utc) => {
          const previous = turn.items.get(key);
          return {
            id:
              previous?.id ??
              TurnItemId.make(
                `zcode:${encodeURIComponent(instanceId)}:${encodeURIComponent(turn.providerTurn.id)}:${encodeURIComponent(key)}`,
              ),
            threadId: open.threadId,
            runId: turn.input.runId,
            nodeId: turn.input.rootNodeId,
            providerThreadId: turn.input.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: previous?.ordinal ?? ++turn.ordinal,
            status: "running" as const,
            title: null,
            startedAt: previous?.startedAt ?? at,
            completedAt: null,
            updatedAt: at,
          };
        };
        const emitItem = (turn: Turn, key: string, item: OrchestrationV2TurnItem) => {
          turn.items.set(key, item);
          return emit({ type: "turn_item.updated", driver, turnItem: item });
        };
        const emitMessage = (turn: Turn, item: OrchestrationV2TurnItem) => {
          if (item.type !== "assistant_message") return Effect.void;
          return emit({
            type: "message.updated",
            driver,
            message: {
              id: item.messageId,
              threadId: open.threadId,
              runId: turn.input.runId,
              nodeId: turn.input.rootNodeId,
              role: "assistant",
              text: item.text,
              attachments: [],
              streaming: item.streaming,
              createdBy: "agent",
              creationSource: "provider",
              createdAt: item.startedAt ?? item.updatedAt,
              updatedAt: item.updatedAt,
            },
          });
        };
        const resolveRequest = (
          turn: Turn,
          id: RuntimeRequestId,
          resolution: Partial<OrchestrationV2RuntimeRequest>,
          at: DateTime.Utc,
        ) =>
          Effect.gen(function* () {
            const entry = turn.requests.get(id);
            if (!entry || entry.request.status !== "pending") return;
            entry.request = {
              ...entry.request,
              ...resolution,
              status: resolution.status ?? "resolved",
              resolvedAt: at,
            };
            yield* emit({
              type: "runtime_request.updated",
              driver,
              threadId: open.threadId,
              runtimeRequest: entry.request,
            });
            const item = turn.items.get(entry.itemKey);
            if (item)
              yield* emitItem(turn, entry.itemKey, {
                ...item,
                status: entry.request.status === "cancelled" ? "cancelled" : "completed",
                completedAt: at,
                updatedAt: at,
              });
          });
        const settle = (
          turn: Turn,
          status: "completed" | "interrupted" | "cancelled" | "failed",
          at: DateTime.Utc,
          usage?: OrchestrationV2ProviderTurn["turnTokenUsage"],
          failureMessage?: string,
          broken = false,
        ) =>
          Effect.gen(function* () {
            if (turn.settled) return;
            turn.settled = true;
            for (const [key, item] of turn.items) {
              if (
                item.status !== "running" &&
                item.status !== "waiting" &&
                item.status !== "pending"
              )
                continue;
              const finished = {
                ...item,
                status: status === "completed" ? ("completed" as const) : ("cancelled" as const),
                completedAt: at,
                updatedAt: at,
                ...(item.type === "assistant_message" || item.type === "reasoning"
                  ? { streaming: false }
                  : {}),
              };
              yield* emitItem(turn, key, finished);
              yield* emitMessage(turn, finished);
            }
            for (const id of turn.requests.keys())
              yield* resolveRequest(turn, id, { status: "cancelled" }, at);
            turn.providerTurn = {
              ...turn.providerTurn,
              status,
              completedAt: at,
              ...(usage === undefined ? {} : { turnTokenUsage: usage }),
            };
            yield* emit({
              type: "provider_turn.updated",
              driver,
              threadId: open.threadId,
              providerTurn: turn.providerTurn,
            });
            if (providerThread)
              yield* emitThread({
                ...providerThread,
                status: broken ? "error" : "idle",
                updatedAt: at,
              });
            yield* sessionStatus(
              broken ? "error" : "ready",
              at,
              broken ? "ZCode native runtime terminated" : null,
            );
            const base = {
              type: "turn.terminal" as const,
              driver,
              providerThreadId: turn.input.providerThread.id,
              providerTurnId: turn.providerTurn.id,
              runOrdinal: turn.input.runOrdinal,
              threadDisposition: broken ? ("broken" as const) : ("reusable" as const),
            };
            yield* emit(
              status === "failed"
                ? {
                    ...base,
                    status,
                    failureItemOrdinal: ++turn.ordinal,
                    failure: makeProviderFailure({
                      class: broken ? "transport_error" : "provider_error",
                      message: failureMessage,
                    }),
                  }
                : { ...base, status, failure: null },
            );
          });
        const translate = (event: ZCodeSessionEvent): Effect.Effect<void> =>
          Effect.gen(function* () {
            if (
              closed ||
              event.threadId !== open.threadId ||
              event.providerInstanceId !== instanceId
            )
              return;
            const at = event.createdAt;
            if (event.type === "thread.metadata.updated") {
              if (!providerThread) {
                metadataEvents.push(event);
                return;
              }
              const target = event.payload.metadata?.goal;
              const goalRecord = record(target);
              const candidate = {
                objective: goalRecord.objective,
                status: goalRecord.status,
                ...(typeof goalRecord.tokensUsed === "number"
                  ? { tokensUsed: goalRecord.tokensUsed }
                  : {}),
                ...(typeof goalRecord.tokenBudget === "number" || goalRecord.tokenBudget === null
                  ? { tokenBudget: goalRecord.tokenBudget }
                  : {}),
                ...(typeof goalRecord.timeUsedSeconds === "number"
                  ? { timeUsedSeconds: goalRecord.timeUsedSeconds }
                  : {}),
              };
              const goal = target === null ? null : isGoal(candidate) ? candidate : undefined;
              yield* emitThread({
                ...providerThread,
                updatedAt: at,
                ...(goal !== undefined ? { goal } : {}),
                ...(event.payload.name
                  ? {
                      nativeMetadata: {
                        ...providerThread.nativeMetadata,
                        title: event.payload.name,
                      },
                    }
                  : {}),
              });
              return;
            }
            if (pending) {
              buffered.push(event);
              return;
            }
            if (event.type === "session.exited") {
              if (!runtimeLive) return;
              runtimeLive = false;
              if (current && !current.settled)
                yield* settle(
                  current,
                  "failed",
                  at,
                  undefined,
                  "ZCode native runtime terminated",
                  true,
                );
              else {
                if (providerThread)
                  yield* emitThread({ ...providerThread, status: "error", updatedAt: at });
                yield* sessionStatus("error", at, "ZCode native runtime terminated");
              }
              if (yield* native.hasSession(open.threadId))
                yield* native.stopSession(open.threadId).pipe(Effect.ignore);
              return;
            }
            const turn = current;
            // Native resolutions can be session-level and lack a turn id. Request
            // identity, scoped to the current attempt, is their correlation key.
            if (
              turn &&
              !turn.settled &&
              event.requestId &&
              (event.type === "request.resolved" || event.type === "user-input.resolved")
            ) {
              if (event.turnId !== undefined && event.turnId !== turn.inputId) return;
              const id = RuntimeRequestId.make(
                `${turn.providerTurn.id}:request:${event.requestId}`,
              );
              yield* resolveRequest(
                turn,
                id,
                event.type === "user-input.resolved"
                  ? { answers: event.payload.answers }
                  : isDecision(event.payload.decision)
                    ? {
                        decision: event.payload.decision,
                        ...(event.payload.optionId === undefined
                          ? {}
                          : { optionId: event.payload.optionId }),
                        ...(event.payload.decision === "cancel"
                          ? { status: "cancelled" as const }
                          : {}),
                      }
                    : {},
                at,
              );
              return;
            }
            if (!turn || turn.settled || event.turnId !== turn.inputId) return;
            switch (event.type) {
              case "content.delta": {
                const reasoning = event.payload.streamKind === "reasoning_text";
                if (!reasoning && event.payload.streamKind !== "assistant_text") return;
                const key = `${reasoning ? "reasoning" : "assistant"}:${event.itemId ?? "default"}`;
                const previous = turn.items.get(key);
                const text =
                  (previous && "text" in previous ? previous.text : "") + event.payload.delta;
                const base = itemBase(turn, key, at);
                const item: OrchestrationV2TurnItem = reasoning
                  ? { ...base, type: "reasoning", text, streaming: true }
                  : {
                      ...base,
                      type: "assistant_message",
                      text,
                      streaming: true,
                      messageId: MessageId.make(`${base.id}:message`),
                    };
                yield* emitItem(turn, key, item);
                yield* emitMessage(turn, item);
                return;
              }
              case "item.started":
              case "item.updated":
              case "item.completed": {
                if (!event.itemId) return;
                const key = `tool:${event.itemId}`;
                const base = itemBase(turn, key, at);
                const status =
                  event.payload.status === "completed"
                    ? "completed"
                    : event.payload.status === "failed"
                      ? "failed"
                      : event.payload.status === "declined"
                        ? "cancelled"
                        : "running";
                const previous = turn.items.get(key);
                if (previous && previous.status !== "running" && previous.status !== "pending")
                  return;
                yield* emitItem(turn, key, {
                  ...base,
                  type: "dynamic_tool",
                  input: previous?.type === "dynamic_tool" ? previous.input : null,
                  toolName: event.payload.title ?? event.payload.itemType,
                  title: event.payload.title ?? null,
                  nativeItemRef: nativeRef(event.itemId),
                  status,
                  ...(event.payload.data !== undefined
                    ? { output: event.payload.data }
                    : event.payload.detail !== undefined
                      ? { output: event.payload.detail }
                      : previous?.type === "dynamic_tool" && previous.output !== undefined
                        ? { output: previous.output }
                        : {}),
                  completedAt: status === "running" ? null : at,
                });
                return;
              }
              case "request.opened":
              case "user-input.requested": {
                if (!event.requestId) return;
                const id = RuntimeRequestId.make(
                  `${turn.providerTurn.id}:request:${event.requestId}`,
                );
                if (turn.requests.has(id)) return;
                const isInput = event.type === "user-input.requested";
                const request: OrchestrationV2RuntimeRequest = {
                  id,
                  nodeId: turn.input.rootNodeId,
                  providerTurnId: turn.providerTurn.id,
                  nativeRequestRef: null,
                  kind: isInput ? "user_input" : "permission",
                  status: "pending",
                  responseCapability: { type: "live", providerSessionId: open.providerSessionId },
                  createdAt: at,
                  resolvedAt: null,
                };
                const key = `request:${id}`;
                turn.requests.set(id, {
                  request,
                  nativeRequestId: ApprovalRequestId.make(event.requestId),
                  itemKey: key,
                });
                yield* emit({
                  type: "runtime_request.updated",
                  driver,
                  threadId: open.threadId,
                  runtimeRequest: request,
                });
                const base = { ...itemBase(turn, key, at), status: "waiting" as const };
                yield* emitItem(
                  turn,
                  key,
                  event.type === "user-input.requested"
                    ? {
                        ...base,
                        type: "user_input_request",
                        requestId: id,
                        questions: event.payload.questions,
                      }
                    : {
                        ...base,
                        type: "approval_request",
                        requestId: id,
                        requestKind: "permission",
                        ...(event.payload.detail ? { prompt: event.payload.detail } : {}),
                        ...(event.payload.options ? { options: event.payload.options } : {}),
                      },
                );
                yield* sessionStatus("waiting", at);
                return;
              }
              case "turn.completed": {
                const broken =
                  event.payload.state === "failed" && !(yield* native.hasSession(open.threadId));
                if (broken) runtimeLive = false;
                yield* settle(
                  turn,
                  event.payload.state,
                  at,
                  event.payload.tokenUsage,
                  event.payload.errorMessage,
                  broken,
                );
                return;
              }
              case "turn.aborted": {
                const broken = !(yield* native.hasSession(open.threadId));
                if (broken) runtimeLive = false;
                yield* settle(turn, "interrupted", at, event.payload.tokenUsage, undefined, broken);
                return;
              }
              default:
                return;
            }
          });
        // Acquire the subscription before any RPC can synchronously emit events.
        const pull = yield* Stream.toPull(native.streamEvents);
        yield* Stream.runForEach(Stream.fromPull(Effect.succeed(pull)), (event) =>
          translation.withPermit(translate(event)),
        ).pipe(Effect.forkScoped({ startImmediately: true }));
        const close = Effect.gen(function* () {
          if (closed) return;
          if (current && !current.settled) {
            const usage = yield* native
              .interruptTurn(open.threadId, current.inputId)
              .pipe(Effect.catch(() => Effect.void));
            yield* settle(current, "interrupted", yield* DateTime.now, usage ?? undefined);
          }
          closed = true;
          runtimeLive = false;
          yield* native
            .stopSession(open.threadId)
            .pipe(Effect.ensuring(Effect.sync(() => owners.delete(open.threadId))));
          yield* sessionStatus("stopped", yield* DateTime.now);
        }).pipe(Effect.ignore);
        yield* Effect.addFinalizer(() => close);
        const revocations = yield* Queue.unbounded<void>();
        const unsubscribe = yield* mcpSessions.subscribeRevocations((config) => {
          if (
            config.threadId !== open.threadId ||
            config.providerSessionId !== mcpCredentialId ||
            config.providerInstanceId !== instanceId
          )
            return;
          revoked = true;
          Queue.offerUnsafe(revocations, undefined);
        });
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
        yield* Stream.runForEach(Stream.fromQueue(revocations), () =>
          operations.withPermit(close),
        ).pipe(Effect.forkScoped);
        const activate = (
          threadId: ThreadId,
          selection: ModelSelection,
          policy: Adapter.ProviderAdapterV2RuntimePolicy,
          existing?: OrchestrationV2ProviderThread,
          nativeId?: string,
          title?: string,
        ) =>
          Effect.gen(function* () {
            if (
              closed ||
              revoked ||
              threadId !== open.threadId ||
              selection.instanceId !== instanceId
            )
              return yield* unsupported(
                "Session cannot activate a different app thread or provider instance",
              );
            if (
              existing &&
              (existing.driver !== driver ||
                existing.appThreadId !== open.threadId ||
                existing.providerInstanceId !== instanceId ||
                (providerThread && existing.id !== providerThread.id))
            )
              return yield* unsupported("Provider thread belongs to another native owner");
            if (current && !current.settled)
              return yield* unsupported("Cannot reactivate a thread during a live turn");
            const mcp = yield* mcpSessions.read(threadId);
            if (
              mcp &&
              ((mcpCredentialId !== undefined && mcp.providerSessionId !== mcpCredentialId) ||
                mcp.providerInstanceId !== instanceId)
            )
              return yield* unsupported("MCP credential belongs to another provider session");
            if (mcp) mcpCredentialId ??= mcp.providerSessionId;
            const sandbox = policy.sandboxPolicy;
            if (sandbox !== undefined && !isSandbox(sandbox))
              return yield* unsupported("Unsupported native sandbox policy");
            if (policy.approvalPolicy !== undefined && !isApprovalPolicy(policy.approvalPolicy))
              return yield* unsupported("Unsupported native approval policy");
            const resumedId = nativeId ?? existing?.nativeThreadRef?.nativeId ?? undefined;
            const started = yield* native.startSession(
              {
                threadId,
                providerInstanceId: instanceId,
                cwd: policy.cwd ?? process.cwd(),
                modelSelection: selection,
                runtimeMode: policy.runtimeMode,
                interactionMode: policy.interactionMode,
                ...(title ? { title } : {}),
                ...(resumedId ? { resumeCursor: { sessionId: resumedId } } : {}),
                ...(isSandbox(sandbox) ? { sandboxMode: sandbox } : {}),
                ...(isApprovalPolicy(policy.approvalPolicy)
                  ? { approvalPolicy: policy.approvalPolicy }
                  : {}),
              },
              nativeScope,
            );
            activePolicy = policy;
            runtimeLive = true;
            const id = cursorId(started);
            const at = yield* DateTime.now;
            const baseThread = providerThread ?? existing;
            const history =
              started.messages ??
              (resumedId === undefined
                ? undefined
                : (yield* native.readNativeSnapshot(open.threadId)).messages);
            let imported: ReadonlyArray<unknown> = [];
            if (history !== undefined) {
              const head = baseThread?.nativeConversationHeadRef;
              if (!baseThread || (baseThread.forkedFrom !== null && head === null))
                imported = history;
              else if (head?.strength === "strong") {
                const index = history.findIndex(
                  (message) => nativeMessageId(message) === head.nativeId,
                );
                if (index < 0)
                  return yield* unsupported(
                    "Native history no longer contains the recorded conversation head",
                  );
                imported = history.slice(index + 1);
              }
              // Older or interrupted T3 transcripts have no exact native head.
              // Establish a baseline instead of guessing which messages overlap.
            }
            const thread: OrchestrationV2ProviderThread = baseThread
              ? {
                  ...baseThread,
                  providerSessionId: open.providerSessionId,
                  nativeThreadRef: id ? nativeRef(id) : baseThread.nativeThreadRef,
                  status: "idle",
                  updatedAt: at,
                  ...(history === undefined
                    ? {}
                    : { nativeConversationHeadRef: nativeHistoryHead(history) }),
                }
              : {
                  id: ProviderThreadId.make(
                    `zcode:${encodeURIComponent(instanceId)}:${encodeURIComponent(threadId)}`,
                  ),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: open.providerSessionId,
                  appThreadId: threadId,
                  ownerNodeId: null,
                  nativeThreadRef: id ? nativeRef(id) : null,
                  nativeConversationHeadRef:
                    history === undefined ? null : nativeHistoryHead(history),
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: at,
                  updatedAt: at,
                };
            yield* emitThread(thread);
            for (const message of readNativeHistoryMessages(imported, threadId))
              yield* emit({ type: "message.updated", driver, message });
            providerSession = {
              ...providerSession,
              model: selection.model,
              cwd: policy.cwd ?? process.cwd(),
            };
            yield* sessionStatus("ready", at);
            for (const event of metadataEvents.splice(0)) yield* translate(event);
            return providerThread ?? thread;
          });
        return {
          instanceId,
          driver,
          providerSessionId: open.providerSessionId,
          providerSession,
          events: Stream.fromQueue(events),
          ensureThread: (input) =>
            activate(
              input.threadId,
              input.modelSelection,
              input.runtimePolicy,
              input.existingProviderThread,
              open.initialNativeThreadId,
              input.title,
            ).pipe(
              operations.withPermit,
              Effect.mapError(
                (cause) =>
                  new Adapter.ProviderAdapterEnsureThreadError({
                    driver,
                    threadId: input.threadId,
                    cause,
                  }),
              ),
            ),
          resumeThread: (input) =>
            activate(
              input.threadId ?? open.threadId,
              input.modelSelection ?? open.modelSelection,
              input.runtimePolicy ?? open.runtimePolicy,
              input.providerThread,
            ).pipe(
              operations.withPermit,
              Effect.mapError(
                (cause) =>
                  new Adapter.ProviderAdapterResumeThreadError({
                    driver,
                    providerSessionId: open.providerSessionId,
                    providerThreadId: input.providerThread.id,
                    cause,
                  }),
              ),
            ),
          startTurn: (input) =>
            Effect.gen(function* () {
              const ownedThread = yield* checkThread(input.providerThread);
              if (
                input.threadId !== open.threadId ||
                input.modelSelection.instanceId !== instanceId
              )
                return yield* unsupported(
                  "Turn belongs to a different app thread or provider instance",
                );
              if (current && !current.settled)
                return yield* unsupported("A ZCode turn is already active");
              if (
                input.runtimePolicy.runtimeMode !== activePolicy.runtimeMode ||
                input.runtimePolicy.cwd !== activePolicy.cwd ||
                input.runtimePolicy.approvalPolicy !== activePolicy.approvalPolicy ||
                input.runtimePolicy.sandboxPolicy !== activePolicy.sandboxPolicy
              )
                return yield* unsupported("Runtime policy changes require a new ZCode session");
              const at = yield* DateTime.now;
              const turn: Turn = {
                input,
                items: new Map(),
                requests: new Map(),
                ordinal: 0,
                settled: false,
                providerTurn: {
                  id: ProviderTurnId.make(
                    `zcode:${encodeURIComponent(instanceId)}:${encodeURIComponent(input.attemptId)}`,
                  ),
                  providerThreadId: input.providerThread.id,
                  nodeId: input.rootNodeId,
                  runAttemptId: input.attemptId,
                  nativeTurnRef: null,
                  ordinal: input.providerTurnOrdinal,
                  status: "running",
                  startedAt: at,
                  completedAt: null,
                },
              };
              current = turn;
              pending = turn;
              yield* emit({
                type: "provider_turn.updated",
                driver,
                threadId: open.threadId,
                providerTurn: turn.providerTurn,
              });
              yield* emitThread({
                ...ownedThread,
                status: "active",
                firstRunOrdinal: ownedThread.firstRunOrdinal ?? input.runOrdinal,
                lastRunOrdinal: input.runOrdinal,
                updatedAt: at,
                ...(ownedThread.nativeConversationHeadRef === null
                  ? {}
                  : {
                      nativeConversationHeadRef: {
                        ...ownedThread.nativeConversationHeadRef,
                        strength: "weak" as const,
                      },
                    }),
              });
              providerSession = { ...providerSession, model: input.modelSelection.model };
              yield* sessionStatus("running", at);
              const result = yield* native
                .sendTurn({
                  threadId: open.threadId,
                  input: input.message.text,
                  attachments: input.message.attachments,
                  modelSelection: input.modelSelection,
                  interactionMode: input.runtimePolicy.interactionMode,
                })
                .pipe(
                  Effect.onError(() =>
                    Effect.gen(function* () {
                      pending = undefined;
                      buffered.length = 0;
                      const broken = !(yield* native.hasSession(open.threadId));
                      if (broken) runtimeLive = false;
                      yield* settle(
                        turn,
                        "failed",
                        yield* DateTime.now,
                        undefined,
                        "ZCode could not start the native turn",
                        broken,
                      );
                    }),
                  ),
                );
              yield* translation.withPermit(
                Effect.gen(function* () {
                  turn.inputId = result.turnId;
                  pending = undefined;
                  const id = cursorId(result);
                  if (id && providerThread)
                    yield* emitThread({
                      ...providerThread,
                      nativeThreadRef: nativeRef(id),
                      updatedAt: yield* DateTime.now,
                    });
                  for (const event of buffered.splice(0)) yield* translate(event);
                }),
              );
            }).pipe(
              operations.withPermit,
              Effect.mapError(
                (cause) =>
                  new Adapter.ProviderAdapterTurnStartError({
                    driver,
                    threadId: input.threadId,
                    providerThreadId: input.providerThread.id,
                    runId: input.runId,
                    cause,
                  }),
              ),
            ),
          steerTurn: (input) =>
            Effect.fail(
              new Adapter.ProviderAdapterSteerRunUnsupportedError({
                driver,
                providerThreadId: input.providerThread.id,
              }),
            ),
          interruptTurn: (input) =>
            Effect.gen(function* () {
              yield* checkThread(input.providerThread);
              if (!current || current.settled || current.providerTurn.id !== input.providerTurnId)
                return yield* unsupported("No matching live turn to interrupt");
              const usage = yield* native.interruptTurn(open.threadId, current.inputId);
              const broken = !(yield* native.hasSession(open.threadId));
              if (broken) runtimeLive = false;
              yield* settle(
                current,
                "interrupted",
                yield* DateTime.now,
                usage ?? undefined,
                undefined,
                broken,
              );
            }).pipe(
              operations.withPermit,
              Effect.mapError(
                (cause) =>
                  new Adapter.ProviderAdapterInterruptError({
                    driver,
                    providerThreadId: input.providerThread.id,
                    providerTurnId: input.providerTurnId,
                    cause,
                  }),
              ),
            ),
          respondToRuntimeRequest: (input) =>
            Effect.gen(function* () {
              const turn = current;
              const entry = turn?.requests.get(input.requestId);
              if (
                closed ||
                revoked ||
                !turn ||
                turn.settled ||
                !entry ||
                entry.request.status !== "pending"
              )
                return yield* unsupported("Runtime request is no longer live");
              if (entry.request.kind === "user_input") {
                if (!input.answers) return yield* unsupported("User input answers are required");
                yield* native.respondToUserInput(
                  open.threadId,
                  entry.nativeRequestId,
                  input.answers,
                );
              } else {
                const item = turn.items.get(entry.itemKey);
                const offered = item?.type === "approval_request" ? item.options : undefined;
                const matches = offered?.filter(
                  (option) =>
                    option.decision === input.decision &&
                    (input.optionId === undefined || option.optionId === input.optionId),
                );
                if (
                  !input.decision ||
                  ((input.decision !== "cancel" || input.optionId !== undefined) &&
                    matches?.length !== 1)
                )
                  return yield* unsupported(
                    "Approval decision was not offered by the native request",
                  );
                yield* native.respondToRequest(
                  open.threadId,
                  entry.nativeRequestId,
                  input.decision,
                  input.optionId,
                );
              }
              const at = yield* DateTime.now;
              yield* resolveRequest(
                turn,
                input.requestId,
                {
                  ...(input.decision
                    ? {
                        decision: input.decision,
                        ...(input.optionId === undefined ? {} : { optionId: input.optionId }),
                        ...(input.decision === "cancel" ? { status: "cancelled" as const } : {}),
                      }
                    : {}),
                  ...(input.answers ? { answers: input.answers } : {}),
                },
                at,
              );
              if (!turn.settled) yield* sessionStatus("running", at);
            }).pipe(
              operations.withPermit,
              Effect.mapError(
                (cause) =>
                  new Adapter.ProviderAdapterRuntimeRequestResponseError({
                    driver,
                    requestId: input.requestId,
                    cause,
                  }),
              ),
            ),
          readThreadSnapshot: (input) =>
            Effect.gen(function* () {
              const thread = yield* checkThread(input.providerThread);
              const snapshot = yield* native.readNativeSnapshot(open.threadId);
              if (snapshot.session?.sessionId !== thread.nativeThreadRef?.nativeId)
                return yield* unsupported(
                  "Native snapshot identity does not match the provider thread",
                );
              return {
                providerThread: thread,
                providerTurns: [],
                messages: readNativeHistoryMessages(
                  snapshot.messages ?? [],
                  thread.appThreadId ?? open.threadId,
                ),
                runtimeRequests: [],
                providerPayload: snapshot,
              };
            }).pipe(
              operations.withPermit,
              Effect.mapError(
                (cause) =>
                  new Adapter.ProviderAdapterReadThreadSnapshotError({
                    driver,
                    providerThreadId: input.providerThread.id,
                    cause,
                  }),
              ),
            ),
          rollbackThread: (input) =>
            Effect.fail(
              new Adapter.ProviderAdapterRollbackThreadError({
                driver,
                providerThreadId: input.providerThread.id,
                cause: "Native conversation rollback is unavailable",
              }),
            ),
          forkThread: (input) =>
            Effect.gen(function* () {
              const source = yield* checkThread(input.sourceProviderThread);
              if (input.providerTurnId !== undefined)
                return yield* unsupported("Only native latest-checkpoint forks are supported");
              if (input.targetThreadId === open.threadId || (current && !current.settled))
                return yield* unsupported("Fork requires a new app thread and an idle source");
              const nativeId = yield* native.forkNativeHead(open.threadId);
              const at = yield* DateTime.now;
              return {
                id: ProviderThreadId.make(
                  `zcode:${encodeURIComponent(instanceId)}:${encodeURIComponent(input.targetThreadId)}`,
                ),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: null,
                appThreadId: input.targetThreadId,
                ownerNodeId: input.ownerNodeId ?? null,
                nativeThreadRef: nativeRef(nativeId),
                nativeConversationHeadRef: null,
                status: "not_loaded" as const,
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: { providerThreadId: source.id },
                createdAt: at,
                updatedAt: at,
              };
            }).pipe(
              operations.withPermit,
              Effect.mapError(
                (cause) =>
                  new Adapter.ProviderAdapterForkThreadError({
                    driver,
                    providerThreadId: input.sourceProviderThread.id,
                    cause,
                  }),
              ),
            ),
        } satisfies Adapter.ProviderAdapterV2SessionRuntime;
      }),
  });
});
