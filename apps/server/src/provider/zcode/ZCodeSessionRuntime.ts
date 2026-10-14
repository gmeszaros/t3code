import * as ZCodeBrowserBridge from "./ZCodeBrowserBridge.ts";
import { makeZCodeNativeAccountReader } from "./ZCodeNativeAccount.ts";
import type {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ProviderApprovalPolicy,
  ProviderSandboxMode,
  RuntimeMode,
  ModelSelection,
  ChatAttachment,
  UserInputQuestion,
  ProviderUserInputAnswers,
  ThreadId,
  TurnTokenUsage,
} from "@t3tools/contracts";
import {
  ApprovalRequestId,
  RuntimeRequestId,
  ProviderInstanceId,
  RuntimeItemId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { ZCodeSettings } from "@t3tools/contracts";
import { McpProviderSessions } from "@t3tools/provider-core/server/McpProviderSessions";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as NodeOS from "node:os";
import * as ZCodeRuntime from "./ZCodeRuntime.ts";
import { aggregateZCodeTurnUsage, readZCodeTurnUsage } from "./ZCodeTurnUsage.ts";
import type * as ZCodeWire from "./ZCodeWireSchema.ts";
import { SessionSnapshot } from "./ZCodeWireSchema.ts";

export class ProviderAdapterProcessError extends Schema.TaggedError<ProviderAdapterProcessError>()(
  "ProviderAdapterProcessError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider adapter process error (${this.provider}) for thread ${this.threadId}: ${this.detail}`;
  }
}

const adapterError = (
  threadId: ThreadId,
  detail: string,
  cause?: unknown,
): ProviderAdapterProcessError =>
  new ProviderAdapterProcessError({
    provider: "zcode",
    threadId,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });

const ResumeCursor = Schema.Struct({
  sessionId: Schema.String.check(Schema.isPattern(/^sess_.+/)),
});
const decodeResumeCursor = Schema.decodeUnknownEffect(ResumeCursor);
const decodeNativeSnapshot = Schema.decodeUnknownEffect(SessionSnapshot);
const decodeNativeFork = Schema.decodeUnknownEffect(
  Schema.Struct({
    forkedSessionId: Schema.String.check(Schema.isPattern(/^sess_.+/)),
    parentSessionId: Schema.optional(Schema.String),
    snapshot: SessionSnapshot,
  }),
);
const resumeIdFor = (input: NativeSessionInput) =>
  input.resumeCursor === undefined
    ? Effect.succeed<string | undefined>(undefined)
    : decodeResumeCursor(input.resumeCursor).pipe(
        Effect.map((cursor) => cursor.sessionId),
        Effect.mapError((cause) =>
          adapterError(input.threadId, "Invalid native ZCode resume cursor", cause),
        ),
      );

type Spawned = ZCodeRuntime.ZCodeSpawnedSession;

const itemTypeForToolName = (
  toolName: string | undefined,
): "command_execution" | "file_change" | "dynamic_tool_call" => {
  if (toolName === "Bash" || toolName === "Terminal" || toolName === "bash")
    return "command_execution";
  if (
    toolName === "Edit" ||
    toolName === "Write" ||
    toolName === "MultiEdit" ||
    toolName === "NotebookEdit"
  ) {
    return "file_change";
  }
  return "dynamic_tool_call";
};

const permissionDecisionFor = (
  option: ZCodeWire.PermissionOption,
): ProviderApprovalDecision | undefined => {
  const response = option.response;
  if (!response || response.modifiedInput !== undefined) return;
  if (option.kind === "deny" && response.decision === "deny" && !response.permissionUpdates?.length)
    return "decline";
  if (response.decision !== "allow") return;
  if (option.kind === "allow_once" && !response.permissionUpdates?.length) return "accept";
  if (option.kind === "allow_always" && response.permissionUpdates?.length) return "acceptAlways";
};

const permissionOptionFor = (
  options: ReadonlyArray<ZCodeWire.PermissionOption>,
  decision: ProviderApprovalDecision,
  optionId?: string,
) => {
  const matches = options.filter(
    (option) =>
      (optionId === undefined || option.optionId === optionId) &&
      permissionDecisionFor(option) === (decision === "cancel" ? "decline" : decision),
  );
  return matches.length === 1 ? matches[0] : undefined;
};

interface PendingApproval {
  readonly turnId: TurnId | undefined;
  readonly nativeTurnId: string | undefined;
  readonly background: boolean;
  readonly serverRequestId: string | number;
  readonly nativeRequestId: string;
  readonly toolCallId: string | undefined;
  readonly options: ReadonlyArray<ZCodeWire.PermissionOption>;
  readonly response: Deferred.Deferred<unknown, never>;
}

interface PendingUserInput {
  readonly turnId: TurnId | undefined;
  readonly nativeTurnId: string | undefined;
  readonly background: boolean;
  readonly serverRequestId: string | number;
  readonly nativeRequestId: string;
  readonly questionIds?: ReadonlyArray<string> | undefined;
  readonly response: Deferred.Deferred<unknown, never>;
}

interface ZCodeSession {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly runtimeMode: NativeSessionInput["runtimeMode"];
  modelSelection: NativeSessionInput["modelSelection"];
  readonly mode: ZCodeWire.SessionMode;
  live: boolean;
  interrupting: boolean;
  stopBoundary?: Deferred.Deferred<void> | undefined;
  readonly nativeTurns: Map<string, TurnId>;
  readonly backgroundTurns: Set<string>;
  readonly toolNames: Map<string, string>;
  readonly startInput: NativeSessionInput;
  readonly spawned: Spawned;
  readonly scope: Scope.Closeable;
  readonly zcodeSessionId: Ref.Ref<string | undefined>;
  readonly activeTurnId: Ref.Ref<TurnId | undefined>;
  readonly pendingApprovals: Ref.Ref<Map<string, PendingApproval>>;
  readonly pendingUserInputs: Ref.Ref<Map<string, PendingUserInput>>;
  hasNativeGoal?: boolean;
  goalStateVersion?: number;
  waitsForGoalBoundary?: boolean;
  goalIterationUsage?: Map<string, TurnTokenUsage> | undefined;
  goalTurnStarted?: boolean;
  goalTerminal?: { readonly type: string; readonly payload?: unknown } | undefined;
}

const nativeGoalCommand = (
  input: NativeTurnInput,
): Omit<ZCodeWire.SessionGoalParams, "sessionId" | "inputId"> | undefined => {
  if ((input.attachments?.length ?? 0) > 0 || input.input === undefined) return;
  const match = /^\/goal(?:\s+([\s\S]*))?$/u.exec(input.input.trim());
  if (!match) return;
  const args = match[1]?.trim() ?? "";
  if (args === "" || args === "show") return { action: "show" };
  if (args === "pause" || args === "resume" || args === "clear") return { action: args };
  if (/^replace(?:\s|$)/u.test(args))
    return { action: "replace", objective: args.slice("replace".length).trim() };
  return { action: "set", objective: args };
};

export interface ZCodeSessionRuntimeOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly instanceId: ProviderInstanceId;
  /** Store root for turn attachments; the driver passes the server's dir. */
  readonly attachmentsDir?: string;
}

export interface NativeSessionInput {
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly cwd?: string;
  readonly title?: string;
  readonly modelSelection?: ModelSelection | undefined;
  readonly resumeCursor?: unknown;
  readonly approvalPolicy?: ProviderApprovalPolicy;
  readonly sandboxMode?: ProviderSandboxMode;
  readonly interactionMode?: "default" | "plan";
  readonly runtimeMode: RuntimeMode;
}
interface NativeTurnInput {
  readonly threadId: ThreadId;
  readonly input?: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
  readonly modelSelection?: ModelSelection | undefined;
  readonly interactionMode?: "default" | "plan";
}
interface NativeSessionRef {
  readonly resumeCursor?: { readonly sessionId: string };
  readonly messages?: ReadonlyArray<unknown>;
}
interface NativeToolUpdate {
  readonly itemType: "command_execution" | "file_change" | "dynamic_tool_call";
  readonly status: "inProgress" | "completed" | "failed" | "declined";
  readonly title?: string;
  readonly data?: unknown;
  readonly detail?: string;
}
type NativeEventPayloads = {
  "thread.metadata.updated": {
    readonly name?: string;
    readonly metadata?: { readonly goal?: unknown };
  };
  "turn.started": Record<string, never>;
  "content.delta": {
    readonly streamKind: "assistant_text" | "reasoning_text";
    readonly delta: string;
  };
  "item.started": NativeToolUpdate;
  "item.updated": NativeToolUpdate;
  "item.completed": NativeToolUpdate;
  "request.opened": {
    readonly requestType: "permission_approval";
    readonly detail?: string;
    readonly appName?: string;
    readonly options?: ReadonlyArray<ProviderApprovalOption>;
    readonly args?: unknown;
  };
  "request.resolved": {
    readonly requestType: "permission_approval";
    readonly decision: ProviderApprovalDecision;
    readonly optionId?: string;
  };
  "user-input.requested": { readonly questions: ReadonlyArray<UserInputQuestion> };
  "user-input.resolved": { readonly answers: ProviderUserInputAnswers };
  "turn.completed": {
    readonly state: "completed" | "interrupted" | "failed";
    readonly errorMessage?: string;
    readonly tokenUsage?: TurnTokenUsage;
  };
  "turn.aborted": { readonly reason: string; readonly tokenUsage?: TurnTokenUsage };
  "session.exited": { readonly reason: string };
};
type NativeEventInput = {
  [K in keyof NativeEventPayloads]: {
    readonly type: K;
    readonly payload: NativeEventPayloads[K];
    readonly turnId?: TurnId;
    readonly itemId?: RuntimeItemId;
    readonly requestId?: RuntimeRequestId;
  };
}[keyof NativeEventPayloads];
/** Process-local notifications, independent of T3's retired V1 event protocol. */
export type ZCodeSessionEvent = NativeEventInput & {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly createdAt: DateTime.Utc;
};
export class ZCodeSessionRuntime extends Context.Service<
  ZCodeSessionRuntime,
  {
    readonly startSession: (
      input: NativeSessionInput,
      ownerScope?: Scope.Scope,
    ) => Effect.Effect<NativeSessionRef, ProviderAdapterProcessError>;
    readonly sendTurn: (
      input: NativeTurnInput,
    ) => Effect.Effect<NativeSessionRef & { readonly turnId: TurnId }, ProviderAdapterProcessError>;
    readonly interruptTurn: (
      threadId: ThreadId,
      turnId?: TurnId,
    ) => Effect.Effect<TurnTokenUsage | void, ProviderAdapterProcessError>;
    readonly respondToRequest: (
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      decision: ProviderApprovalDecision,
      optionId?: string,
    ) => Effect.Effect<void, ProviderAdapterProcessError>;
    readonly respondToUserInput: (
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      answers: ProviderUserInputAnswers,
    ) => Effect.Effect<void, ProviderAdapterProcessError>;
    readonly readNativeSnapshot: (
      threadId: ThreadId,
    ) => Effect.Effect<ZCodeWire.SessionSnapshot, ProviderAdapterProcessError>;
    readonly forkNativeHead: (
      threadId: ThreadId,
    ) => Effect.Effect<string, ProviderAdapterProcessError>;
    readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, ProviderAdapterProcessError>;
    readonly listSessions: () => Effect.Effect<
      ReadonlyArray<
        NativeSessionRef & {
          readonly threadId: ThreadId;
          readonly status: "running" | "ready";
          readonly activeTurnId?: TurnId;
        }
      >
    >;
    readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean>;
    readonly streamEvents: Stream.Stream<ZCodeSessionEvent>;
  }
>()("t3/provider/zcode/ZCodeSessionRuntime") {}

/**
 * Single source of truth for the session-start execution mode. Restrictive
 * sandbox policies always win over permissive ones, and contradictory combinations fail
 * closed instead of being guessed.
 */
const zcodeModeOrReject = (
  input: NativeSessionInput,
): Effect.Effect<ZCodeWire.SessionMode, ProviderAdapterProcessError> => {
  if (input.sandboxMode === "read-only") {
    return Effect.succeed("plan");
  }
  if (
    input.runtimeMode === "approval-required" &&
    (input.sandboxMode === "danger-full-access" || input.approvalPolicy === "never")
  ) {
    return Effect.fail(
      adapterError(
        input.threadId,
        "Unsupported combination: approval-required runtime mode conflicts with a full-access sandbox or approvalPolicy 'never'. Pick a restrictive sandbox or drop approval-required.",
      ),
    );
  }
  if (input.sandboxMode === "danger-full-access" || input.runtimeMode === "full-access") {
    return Effect.succeed("yolo");
  }
  return Effect.succeed("build");
};

/**
 * Per-turn mode: an explicit Plan interaction on a send always downgrades
 * the executed mode to plan, even inside a Full access session.
 */
const zcodeTurnModeFor = (
  input: Pick<NativeTurnInput, "interactionMode">,
  sessionMode: ZCodeWire.SessionMode,
): ZCodeWire.SessionMode => (input.interactionMode === "plan" ? "plan" : sessionMode);

interface ParsedModelRef {
  readonly providerId: string;
  readonly modelId: string;
}

const parseModelSelection = (
  selection: NativeTurnInput["modelSelection"],
): ParsedModelRef | undefined => {
  if (selection === undefined) return undefined;
  const slash = selection.model.indexOf("/");
  return slash > 0
    ? { providerId: selection.model.slice(0, slash), modelId: selection.model.slice(slash + 1) }
    : { providerId: "account:zai-individual-coding-plan", modelId: selection.model };
};

const modelRefFor = (
  selection: NativeTurnInput["modelSelection"],
): ZCodeWire.ModelSelectionRef | undefined => {
  const parsed = parseModelSelection(selection);
  if (parsed === undefined) return undefined;
  const reasoningLevel = selection?.options?.find(
    (option) => option.id === "reasoningLevel",
  )?.value;
  return {
    ...parsed,
    ...(typeof reasoningLevel === "string"
      ? { options: { reasoningLevel } }
      : /^GLM-5\.3(?:-Flash)?$/i.test(parsed.modelId)
        ? { options: { reasoningLevel: "max" } }
        : {}),
  };
};

export const makeZCodeSessionRuntime = (
  settings: ZCodeSettings,
  options?: ZCodeSessionRuntimeOptions,
) =>
  Effect.gen(function* () {
    const browserBridge = yield* Effect.serviceOption(ZCodeBrowserBridge.ZCodeBrowserBridge);
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const mcpSessions = yield* McpProviderSessions;
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("zcode");
    const environment = options?.environment ?? process.env;
    const readNativeAccount = yield* makeZCodeNativeAccountReader(environment);
    const attachmentsDir =
      options?.attachmentsDir ??
      (NodeOS.homedir() ? `${NodeOS.homedir()}/.t3-attachments` : "/tmp/t3-attachments");

    const sessions = new Map<ThreadId, ZCodeSession>();
    const recoveryInputs = new Map<ThreadId, NativeSessionInput>();
    const runtimeEventPubSub = yield* PubSub.unbounded<ZCodeSessionEvent>();
    // The ambient scope is the registry's provider-instance scope (or the
    // test scope): when it closes, every running child is killed.
    const parentScope = yield* Scope.Scope;

    const emitFor = (session: Pick<ZCodeSession, "threadId">, event: NativeEventInput) =>
      Effect.gen(function* () {
        const createdAt = yield* DateTime.now;
        yield* PubSub.publish(runtimeEventPubSub, {
          ...event,
          providerInstanceId: boundInstanceId,
          threadId: session.threadId,
          createdAt,
        });
      });

    const workspaceRef = (cwd: string): ZCodeWire.WorkspaceRef => ({
      workspacePath: cwd,
      workspaceKey: cwd,
    });

    const settleInteractions = Effect.fn("t3-provider-zcode/settleInteractions")(function* (
      session: ZCodeSession,
      turnId?: TurnId,
    ) {
      for (const [id, pending] of yield* Ref.get(session.pendingApprovals)) {
        if (turnId !== undefined && (pending.background || pending.turnId !== turnId)) continue;
        if (yield* Deferred.succeed(pending.response, { decision: "deny" }))
          yield* emitFor(session, {
            type: "request.resolved",
            requestId: RuntimeRequestId.make(id),
            payload: { requestType: "permission_approval", decision: "decline" },
          });
      }
      for (const [id, pending] of yield* Ref.get(session.pendingUserInputs)) {
        if (turnId !== undefined && (pending.background || pending.turnId !== turnId)) continue;
        if (
          yield* Deferred.succeed(
            pending.response,
            pending.questionIds
              ? { action: "cancel" }
              : { requestId: pending.nativeRequestId, cancelled: true },
          )
        )
          yield* emitFor(session, {
            type: "user-input.resolved",
            requestId: RuntimeRequestId.make(id),
            payload: { answers: {} },
          });
      }
    });

    const interactionTurn = (
      session: ZCodeSession,
      nativeTurnId: string | undefined,
      background = false,
    ) =>
      background
        ? Effect.succeed(undefined)
        : nativeTurnId !== undefined
          ? Effect.succeed(session.nativeTurns.get(nativeTurnId))
          : Ref.get(session.activeTurnId);

    // Keep a bounded retry cache without discarding outstanding callbacks.
    const pruneInteractions = Effect.fn("t3-provider-zcode/pruneInteractions")(function* (
      session: ZCodeSession,
    ) {
      const prune = <T extends PendingApproval | PendingUserInput>(ref: Ref.Ref<Map<string, T>>) =>
        Effect.gen(function* () {
          for (const [id, pending] of yield* Ref.get(ref)) {
            if ((yield* Ref.get(ref)).size < 256) break;
            if (yield* Deferred.isDone(pending.response))
              yield* Ref.update(ref, (current) => {
                const next = new Map(current);
                if (next.get(id) === pending) next.delete(id);
                return next;
              });
          }
        });
      yield* prune(session.pendingApprovals);
      yield* prune(session.pendingUserInputs);
    });

    const interruptedUsage = (session: ZCodeSession): TurnTokenUsage | undefined => {
      if (!session.goalIterationUsage?.size) return;
      const usage = aggregateZCodeTurnUsage([...session.goalIterationUsage.values()]);
      return {
        ...usage,
        usageStatus: usage.usageStatus === "unavailable" ? "unavailable" : "partial",
      };
    };

    const invalidateSession = Effect.fn("t3-provider-zcode/invalidateSession")(function* (
      session: ZCodeSession,
    ) {
      if (!session.live) return;
      session.live = false;
      const cursor = yield* Ref.get(session.zcodeSessionId);
      if (cursor !== undefined)
        recoveryInputs.set(session.threadId, {
          ...session.startInput,
          modelSelection: session.modelSelection,
          resumeCursor: { sessionId: cursor },
        });
      const turnId = yield* Ref.getAndSet(session.activeTurnId, undefined);
      if (sessions.get(session.threadId) === session) sessions.delete(session.threadId);
      yield* settleInteractions(session);
      session.nativeTurns.clear();
      session.backgroundTurns.clear();
      if (turnId !== undefined) {
        const tokenUsage = interruptedUsage(session);
        yield* emitFor(
          session,
          session.interrupting
            ? {
                type: "turn.aborted",
                turnId,
                payload: { reason: "Interrupted from T3", ...(tokenUsage ? { tokenUsage } : {}) },
              }
            : {
                type: "turn.completed",
                turnId,
                payload: {
                  state: "failed",
                  errorMessage: "ZCode app-server terminated",
                  ...(tokenUsage ? { tokenUsage } : {}),
                },
              },
        );
      }
      yield* emitFor(session, {
        type: "session.exited",
        payload: { reason: "ZCode app-server terminated" },
      });
      if (session.stopBoundary) yield* Deferred.succeed(session.stopBoundary, undefined);
      yield* Scope.close(session.scope, Exit.void).pipe(Effect.ignore, Effect.forkIn(parentScope));
    });

    const translateSessionEvent = Effect.fn("t3-provider-zcode/translateEvent")(function* (
      session: ZCodeSession,
      envelope: ZCodeWire.SessionEventEnvelope,
    ) {
      // The session object is the child generation. Old pumps and callbacks cannot affect its replacement.
      if (!session.live || sessions.get(session.threadId) !== session) return;
      let payload = (envelope.payload ?? {}) as Record<string, unknown>;
      let terminalUsage: TurnTokenUsage | undefined;
      const activeTurnId = yield* Ref.get(session.activeTurnId);
      // Native background/control work has no T3 turn surface; it is tracked
      // only to keep it out of the foreground projection.
      const markedBackground =
        payload.background === true ||
        payload.backgroundSource !== undefined ||
        payload.executionKind === "controlOnly";
      if (envelope.type === "turn.started" && envelope.turnId !== undefined) {
        if (markedBackground) {
          session.backgroundTurns.add(envelope.turnId);
          if (session.backgroundTurns.size > 256) {
            const oldest = session.backgroundTurns.values().next().value;
            if (oldest !== undefined) session.backgroundTurns.delete(oldest);
          }
        } else if (activeTurnId !== undefined && payload.inputId === activeTurnId) {
          if (session.nativeTurns.has(envelope.turnId)) return;
          session.nativeTurns.set(envelope.turnId, activeTurnId);
        }
      }
      let turnId =
        envelope.turnId !== undefined ? session.nativeTurns.get(envelope.turnId) : undefined;
      const interaction =
        envelope.type === "permission.resolved" || envelope.type === "userInput.resolved";
      const turnEvent =
        envelope.type.startsWith("turn.") ||
        envelope.type === "model.streaming" ||
        envelope.type === "part.delta" ||
        envelope.type === "tool.updated";
      // Turn-scoped app-server events must resolve to the live foreground turn:
      // an explicit but unbindable turn id is a late, settled, or background
      // event that must never be relabeled onto the current turn, and
      // marked-background work is not representable in T3's turn model.
      if (turnEvent && (markedBackground || turnId === undefined || turnId !== activeTurnId)) {
        if (
          envelope.turnId !== undefined &&
          (envelope.type === "turn.completed" || envelope.type === "turn.failed")
        )
          session.backgroundTurns.delete(envelope.turnId);
        return;
      }
      if (interaction) {
        const nativeId = payload.requestId;
        if (envelope.type === "permission.resolved") {
          for (const [id, pending] of yield* Ref.get(session.pendingApprovals)) {
            if (
              envelope.turnId !== undefined &&
              pending.nativeTurnId !== undefined &&
              envelope.turnId !== pending.nativeTurnId
            )
              continue;
            if (
              typeof nativeId === "string"
                ? pending.nativeRequestId !== nativeId
                : pending.toolCallId === undefined || pending.toolCallId !== payload.toolCallId
            )
              continue;
            const response = {
              decision: typeof payload.decision === "string" ? payload.decision : "deny",
              ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
              ...(payload.modifiedInput !== undefined
                ? { modifiedInput: payload.modifiedInput }
                : {}),
            };
            if (yield* Deferred.succeed(pending.response, response))
              yield* emitFor(session, {
                type: "request.resolved",
                requestId: RuntimeRequestId.make(id),
                payload: {
                  requestType: "permission_approval",
                  decision:
                    response.decision === "allow" || response.decision === "modify"
                      ? "accept"
                      : "decline",
                },
              });
          }
        } else {
          if (typeof nativeId !== "string") return;
          for (const [id, pending] of yield* Ref.get(session.pendingUserInputs)) {
            if (
              envelope.turnId !== undefined &&
              pending.nativeTurnId !== undefined &&
              envelope.turnId !== pending.nativeTurnId
            )
              continue;
            if (pending.nativeRequestId !== nativeId) continue;
            const cancelled = payload.cancelled === true;
            const response = pending.questionIds
              ? cancelled
                ? { action: "cancel" }
                : { action: "accept", content: payload.value }
              : {
                  requestId: nativeId,
                  ...(cancelled ? { cancelled: true } : { value: payload.value }),
                };
            const answers = cancelled
              ? {}
              : pending.questionIds
                ? Object.fromEntries(
                    pending.questionIds.map((id, index) => [
                      id,
                      typeof payload.value === "object" && payload.value !== null
                        ? (payload.value as Record<string, unknown>)[`answer_${index}`]
                        : undefined,
                    ]),
                  )
                : { [nativeId]: payload.value };
            if (yield* Deferred.succeed(pending.response, response))
              yield* emitFor(session, {
                type: "user-input.resolved",
                requestId: RuntimeRequestId.make(id),
                payload: { answers },
              });
          }
        }
        return;
      }
      if (session.interrupting) {
        if (envelope.type === "turn.completed" || envelope.type === "turn.failed") {
          const nativeTurnId = envelope.turnId ?? activeTurnId;
          if (nativeTurnId !== undefined) {
            const iterations = (session.goalIterationUsage ??= new Map());
            if (!iterations.has(nativeTurnId))
              iterations.set(nativeTurnId, readZCodeTurnUsage(payload, false));
          }
          return;
        }
        if (envelope.type === "state.updated" && session.stopBoundary) {
          const reason = payload.reason;
          if (
            reason === "prompt_completed" ||
            reason === "prompt_failed" ||
            reason === "goal_continuation_completed" ||
            reason === "goal_continuation_failed"
          )
            yield* Deferred.succeed(session.stopBoundary, undefined);
          return;
        }
      }
      // A native goal emits TurnComplete for every iteration. The host's
      // state.updated boundary follows the entire vendor continuation loop,
      // including its verifier; keep the same T3 turn and Stop handle until then.
      if (session.waitsForGoalBoundary) {
        if (envelope.type === "turn.completed" || envelope.type === "turn.failed") {
          if (envelope.turnId !== undefined) {
            const iterations = (session.goalIterationUsage ??= new Map());
            if (iterations.has(envelope.turnId)) return;
            iterations.set(
              envelope.turnId,
              readZCodeTurnUsage(payload, payload.resultType === "success"),
            );
          }
          session.goalTerminal = envelope;
          return;
        }
        if (envelope.type === "state.updated") {
          const reason = (envelope.payload as { reason?: unknown } | undefined)?.reason;
          if (
            reason !== "goal_continuation_completed" &&
            reason !== "goal_continuation_failed" &&
            reason !== "prompt_completed" &&
            reason !== "prompt_failed"
          )
            return;
          session.waitsForGoalBoundary = false;
          envelope =
            reason === "goal_continuation_failed" || reason === "prompt_failed"
              ? { type: "turn.failed" }
              : (session.goalTerminal ?? {
                  type: "turn.completed",
                  payload: { resultType: "success" },
                });
          session.goalTerminal = undefined;
          payload = (envelope.payload ?? {}) as Record<string, unknown>;
          turnId = activeTurnId;
          terminalUsage = aggregateZCodeTurnUsage([
            ...(session.goalIterationUsage?.values() ?? []),
          ]);
          session.goalIterationUsage = undefined;
        }
      }
      const turnFields = turnId !== undefined ? { turnId } : {};
      switch (envelope.type) {
        case "session.updated": {
          // TargetChanged maps to session.updated in the vendor protocol.
          // Carry the native state without creating a T3 goal store or loop.
          if ("target" in payload) {
            session.goalStateVersion = (session.goalStateVersion ?? 0) + 1;
            session.hasNativeGoal = payload.target !== null;
            yield* emitFor(session, {
              type: "thread.metadata.updated",
              ...turnFields,
              payload: { metadata: { goal: payload.target } },
            });
          }
          return;
        }
        case "turn.started": {
          if (session.waitsForGoalBoundary) {
            if (session.goalTurnStarted) return;
            session.goalTurnStarted = true;
          }
          yield* emitFor(session, { type: "turn.started", ...turnFields, payload: {} });
          return;
        }
        case "model.streaming":
        case "part.delta": {
          const delta = typeof payload.delta === "string" ? payload.delta : "";
          const field =
            envelope.type === "model.streaming"
              ? payload.kind === "text_delta"
                ? "text"
                : payload.kind === "reasoning_delta"
                  ? "reasoning"
                  : undefined
              : typeof payload.field === "string"
                ? payload.field
                : "text";
          // Only the assistant text and reasoning channels reach content
          // streaming; tool input/output deltas belong to tool items.
          if (delta.length === 0 || (field !== "text" && field !== "reasoning")) return;
          const partId = typeof payload.partId === "string" ? payload.partId : undefined;
          yield* emitFor(session, {
            type: "content.delta",
            ...turnFields,
            ...(partId !== undefined ? { itemId: RuntimeItemId.make(partId) } : {}),
            payload: {
              streamKind: field === "reasoning" ? "reasoning_text" : "assistant_text",
              delta,
            },
          });
          return;
        }
        case "tool.updated": {
          const kind = payload.kind;
          const toolCallId =
            typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
          if (toolCallId === undefined) return;
          const itemId = RuntimeItemId.make(toolCallId);
          const toolName =
            typeof payload.toolName === "string"
              ? payload.toolName
              : session.toolNames.get(toolCallId);
          if (toolName !== undefined) session.toolNames.set(toolCallId, toolName);
          const itemType = itemTypeForToolName(toolName);
          const title = toolName ?? itemType;
          if (kind === "scheduled" || kind === "started") {
            yield* emitFor(session, {
              type: "item.started",
              ...turnFields,
              itemId,
              payload: { itemType, status: "inProgress", title },
            });
            return;
          }
          if (kind === "progress") {
            yield* emitFor(session, {
              type: "item.updated",
              ...turnFields,
              itemId,
              payload: { itemType, status: "inProgress", title },
            });
            return;
          }
          // The native union terminates tool calls with result / error /
          // completed / failed / denied. All of them must settle the item and
          // carry its output or error content.
          if (kind === "completed" || kind === "result") {
            session.toolNames.delete(toolCallId);
            yield* emitFor(session, {
              type: "item.completed",
              ...turnFields,
              itemId,
              payload: {
                itemType,
                title,
                status: "completed",
                ...(payload.result !== undefined
                  ? { data: payload.result }
                  : payload.output !== undefined
                    ? { data: payload.output }
                    : {}),
              },
            });
            return;
          }
          if (kind === "failed" || kind === "error" || kind === "denied") {
            session.toolNames.delete(toolCallId);
            const rawError: unknown = payload.error;
            const errorText =
              typeof rawError === "string"
                ? rawError
                : typeof (rawError as { message?: unknown } | undefined)?.message === "string"
                  ? (rawError as { message: string }).message
                  : undefined;
            yield* emitFor(session, {
              type: "item.completed",
              ...turnFields,
              itemId,
              payload: {
                itemType,
                title,
                status: kind === "denied" ? "declined" : "failed",
                ...(errorText !== undefined ? { detail: errorText } : {}),
                ...(payload.error !== undefined && typeof payload.error !== "string"
                  ? { data: payload.error }
                  : {}),
              },
            });
          }
          return;
        }
        case "turn.completed": {
          if (
            turnId === undefined ||
            !(yield* Ref.modify(session.activeTurnId, (current) =>
              current === turnId ? [true, undefined] : [false, current],
            ))
          )
            return;
          const resultType = payload.resultType;
          const state =
            resultType === "success"
              ? "completed"
              : resultType === "cancelled"
                ? "interrupted"
                : "failed";
          if (turnId !== undefined) {
            for (const [nativeId, owner] of session.nativeTurns) {
              if (owner === turnId) session.nativeTurns.delete(nativeId);
            }
            yield* settleInteractions(session, turnId);
            if ((yield* Ref.get(session.activeTurnId)) === turnId)
              yield* Ref.set(session.activeTurnId, undefined);
          }
          yield* emitFor(session, {
            type: "turn.completed",
            ...turnFields,
            payload: {
              state,
              ...(state === "failed" && typeof payload.response === "string"
                ? { errorMessage: payload.response }
                : {}),
              tokenUsage: terminalUsage ?? readZCodeTurnUsage(payload, state === "completed"),
            },
          });
          return;
        }
        case "turn.failed": {
          if (
            turnId === undefined ||
            !(yield* Ref.modify(session.activeTurnId, (current) =>
              current === turnId ? [true, undefined] : [false, current],
            ))
          )
            return;
          const error = payload.error as Record<string, unknown> | undefined;
          const message = typeof error?.message === "string" ? error.message : "ZCode turn failed";
          if (turnId !== undefined) {
            for (const [nativeId, owner] of session.nativeTurns) {
              if (owner === turnId) session.nativeTurns.delete(nativeId);
            }
            yield* settleInteractions(session, turnId);
            if ((yield* Ref.get(session.activeTurnId)) === turnId)
              yield* Ref.set(session.activeTurnId, undefined);
          }
          yield* emitFor(session, {
            type: "turn.completed",
            ...turnFields,
            payload: {
              state: "failed",
              errorMessage: message,
              tokenUsage: terminalUsage ?? readZCodeTurnUsage(payload, false),
            },
          });
          return;
        }
        case "session.titleUpdated": {
          const title = payload.title;
          if (typeof title === "string" && title.length > 0) {
            yield* emitFor(session, { type: "thread.metadata.updated", payload: { name: title } });
          }
          return;
        }
        default:
          return;
      }
    });

    const resolveRuntime = Effect.fn("t3-provider-zcode/resolveRuntime")(function* (
      threadId: ThreadId,
    ): Effect.fn.Return<ZCodeRuntime.ZCodeResolvedRuntime, ProviderAdapterProcessError> {
      return yield* ZCodeRuntime.resolveZCodeRuntime({
        binaryPath: settings.binaryPath,
        launchArgs: settings.launchArgs,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError((cause) =>
          adapterError(threadId, "Failed to resolve the ZCode runtime", cause),
        ),
      );
    });

    const stopAll = Effect.fn("t3-provider-zcode/stopAll")(function* () {
      for (const session of sessions.values()) {
        session.live = false;
        const turnId = yield* Ref.getAndSet(session.activeTurnId, undefined);
        yield* settleInteractions(session);
        if (turnId !== undefined)
          yield* emitFor(session, {
            type: "turn.aborted",
            turnId,
            payload: { reason: "ZCode session closed" },
          });
        yield* session.spawned.terminate;
        yield* Scope.close(session.scope, Exit.void).pipe(Effect.ignore);
      }
      sessions.clear();
      recoveryInputs.clear();
    });

    // Provider removal/disable/reconfiguration closes the registry scope that
    // owns this adapter; the finalizer then kills every running child and
    // settles the session bookkeeping.
    yield* Effect.addFinalizer(() => stopAll().pipe(Effect.ignore));

    const subscribeAndPump = (session: ZCodeSession, zcodeSessionId: string) =>
      Effect.gen(function* () {
        yield* session.spawned.client
          .sessionSubscribe({ sessionId: zcodeSessionId, deliveryKind: "desktop-continuous" })
          .pipe(
            Effect.mapError((cause) =>
              adapterError(session.threadId, "session/subscribe failed", cause),
            ),
          );
      });

    const makeAppServerSession = Effect.fn("t3-provider-zcode/makeAppServerSession")(function* (
      input: NativeSessionInput,
      mode: ZCodeWire.SessionMode,
      ownerScope?: Scope.Scope,
    ): Effect.fn.Return<ZCodeSession, ProviderAdapterProcessError> {
      const cwd = input.cwd ?? process.cwd();
      const pendingApprovals = yield* Ref.make(new Map<string, PendingApproval>());
      const pendingUserInputs = yield* Ref.make(new Map<string, PendingUserInput>());
      const sessionRef: { current: ZCodeSession | undefined } = { current: undefined };
      let terminated = false;

      const runtime = yield* resolveRuntime(input.threadId);
      const nativeAccount =
        runtime.kind === "app-bundle" && runtime.builtinProviderConfigFile
          ? yield* readNativeAccount(runtime.builtinProviderConfigFile)
          : undefined;
      const sessionScope = yield* Scope.fork(ownerScope ?? parentScope);
      const browserOptions = Option.isSome(browserBridge)
        ? yield* browserBridge.value
            .bind({
              threadId: input.threadId,
              workspacePath: cwd,
              nativeSessionId: Effect.suspend(() => {
                const current = sessions.get(input.threadId);
                return current?.scope === sessionScope
                  ? Ref.get(current.zcodeSessionId)
                  : Effect.succeed(undefined);
              }),
            })
            .pipe(Effect.provideService(Scope.Scope, sessionScope))
        : {};
      // A failed spawn must not leak the freshly made scope.
      const spawned = yield* Effect.mapError(
        ZCodeRuntime.spawnZCodeAppServer({
          runtime,
          cwd,
          environment,
          launchArgs: settings.launchArgs,
          spawner,
          scope: sessionScope,
          nativeAccount,
          clientOptions: {
            ...browserOptions,
            // Translate in wire order before the next reverse request or exit.
            // A separate queue consumer can race turn.started and lose ownership.
            onSessionEvent: (event) =>
              Effect.gen(function* () {
                const session = sessionRef.current;
                if (
                  session !== undefined &&
                  event.sessionId === (yield* Ref.get(session.zcodeSessionId))
                )
                  yield* translateSessionEvent(session, event);
              }).pipe(Effect.ignore),
            onTermination: () =>
              Effect.gen(function* () {
                terminated = true;
                const session = sessionRef.current;
                if (session) yield* invalidateSession(session);
              }).pipe(Effect.ignore),
            ...(runtime.kind === "app-bundle"
              ? {
                  onOfficialMcpAuthHeaders: (params) =>
                    readNativeAccount.officialMcpAuthHeaders(params),
                }
              : {}),
            onPermissionRequest: (params, serverRequestId) =>
              Effect.gen(function* () {
                const session = sessionRef.current;
                if (session === undefined || !session.live) return { decision: "deny" };
                if (
                  params.sessionId !== undefined &&
                  params.sessionId !== (yield* Ref.get(session.zcodeSessionId))
                )
                  return { decision: "deny" };
                const backgroundTurn =
                  params.background === true ||
                  (params.turnId !== undefined && session.backgroundTurns.has(params.turnId));
                const activeTurnId = yield* interactionTurn(session, params.turnId, backgroundTurn);
                if (backgroundTurn || activeTurnId === undefined || session.interrupting)
                  return { decision: "deny" };
                yield* pruneInteractions(session);
                const approvalId = RuntimeRequestId.make(
                  yield* Effect.orDie(crypto.randomUUIDv4()),
                );
                const deferred = yield* Deferred.make<unknown, never>();
                const zoptions = params.options ?? [];
                const nativeRequestId = params.requestId ?? String(serverRequestId);
                const existing = yield* Ref.modify(pendingApprovals, (map) => {
                  const previous = [...map.values()].find(
                    (entry) => entry.nativeRequestId === nativeRequestId,
                  );
                  if (previous) return [previous, map] as const;
                  const next = new Map(map);
                  next.set(approvalId, {
                    turnId: activeTurnId,
                    nativeTurnId: params.turnId,
                    serverRequestId,
                    nativeRequestId,
                    toolCallId: params.toolCallId,
                    options: zoptions,
                    background: backgroundTurn,
                    response: deferred,
                  });
                  return [undefined, next] as const;
                });
                if (existing) return yield* Deferred.await(existing.response);
                yield* emitFor(session, {
                  type: "request.opened",
                  requestId: approvalId,
                  ...(activeTurnId !== undefined ? { turnId: activeTurnId } : {}),
                  payload: {
                    requestType: "permission_approval",
                    ...(params.reason !== undefined ? { detail: params.reason } : {}),
                    ...(params.toolName !== undefined ? { appName: params.toolName } : {}),
                    // Session grants require the native V4 optionId path.
                    options: zoptions.flatMap((option) => {
                      const decision = permissionDecisionFor(option);
                      return decision && permissionOptionFor(zoptions, decision, option.optionId)
                        ? [{ optionId: option.optionId, decision, label: option.name }]
                        : [];
                    }),
                    ...(params.input !== undefined ? { args: params.input } : {}),
                  },
                });
                if (
                  !session.live ||
                  (!backgroundTurn && activeTurnId !== (yield* Ref.get(session.activeTurnId)))
                )
                  yield* settleInteractions(session, session.live ? activeTurnId : undefined);
                return yield* Deferred.await(deferred);
              }).pipe(Effect.catch(() => Effect.succeed({ decision: "deny" }))),
            onUserInputRequest: (params, serverRequestId) =>
              Effect.gen(function* () {
                const session = sessionRef.current;
                if (session === undefined || !session.live)
                  return params.questions
                    ? { action: "cancel" }
                    : { requestId: params.requestId, cancelled: true };
                const cancelled = params.questions
                  ? { action: "cancel" }
                  : { requestId: params.requestId, cancelled: true };
                if (
                  params.sessionId !== undefined &&
                  params.sessionId !== (yield* Ref.get(session.zcodeSessionId))
                )
                  return cancelled;
                const backgroundTurn =
                  params.turnId !== undefined && session.backgroundTurns.has(params.turnId);
                const activeTurnId = yield* interactionTurn(session, params.turnId, backgroundTurn);
                if (backgroundTurn || activeTurnId === undefined || session.interrupting)
                  return cancelled;
                yield* pruneInteractions(session);
                const approvalId = RuntimeRequestId.make(
                  yield* Effect.orDie(crypto.randomUUIDv4()),
                );
                const deferred = yield* Deferred.make<unknown, never>();
                const questions = params.questions?.map((question, index) => ({
                  id: `${params.requestId}:${index}`,
                  header: question.header,
                  question: question.question,
                  options: question.options.map((option) => ({
                    ...option,
                    description: option.description ?? option.label,
                  })),
                  multiSelect: question.multiSelect ?? false,
                  allowCustomAnswer: true,
                }));
                const existing = yield* Ref.modify(pendingUserInputs, (map) => {
                  const previous = [...map.values()].find(
                    (entry) => entry.nativeRequestId === params.requestId,
                  );
                  if (previous) return [previous, map] as const;
                  const next = new Map(map);
                  next.set(approvalId, {
                    turnId: activeTurnId,
                    nativeTurnId: params.turnId,
                    background: backgroundTurn,
                    serverRequestId,
                    nativeRequestId: params.requestId,
                    questionIds: questions?.map((question) => question.id),
                    response: deferred,
                  });
                  return [undefined, next] as const;
                });
                if (existing) return yield* Deferred.await(existing.response);
                yield* emitFor(session, {
                  type: "user-input.requested",
                  requestId: approvalId,
                  ...(activeTurnId !== undefined ? { turnId: activeTurnId } : {}),
                  payload: {
                    questions: questions ?? [
                      {
                        id: params.requestId,
                        header: "ZCode",
                        question: params.prompt ?? "ZCode requests input",
                        options:
                          params.choices?.map((choice) => ({
                            value: choice,
                            label: choice,
                            description: choice,
                          })) ?? [],
                        allowCustomAnswer: true,
                      },
                    ],
                  },
                });
                if (
                  !session.live ||
                  (!backgroundTurn && activeTurnId !== (yield* Ref.get(session.activeTurnId)))
                )
                  yield* settleInteractions(session, session.live ? activeTurnId : undefined);
                return yield* Deferred.await(deferred);
              }).pipe(
                Effect.catch(() =>
                  Effect.succeed(
                    params.questions
                      ? { action: "cancel" }
                      : { requestId: params.requestId, cancelled: true },
                  ),
                ),
              ),
          },
        }),
        (cause) => adapterError(input.threadId, "Failed to spawn the ZCode app-server", cause),
      ).pipe(Effect.onError(() => Scope.close(sessionScope, Exit.void).pipe(Effect.ignore)));

      const session: ZCodeSession = {
        threadId: input.threadId,
        cwd,
        runtimeMode: input.runtimeMode,
        modelSelection: input.modelSelection,
        mode,
        live: true,
        interrupting: false,
        nativeTurns: new Map(),
        backgroundTurns: new Set(),
        toolNames: new Map(),
        startInput: input,
        spawned,
        scope: sessionScope,
        zcodeSessionId: yield* Ref.make<string | undefined>(undefined),
        activeTurnId: yield* Ref.make<TurnId | undefined>(undefined),
        pendingApprovals,
        pendingUserInputs,
      };
      if (terminated) {
        yield* Scope.close(sessionScope, Exit.void);
        return yield* adapterError(input.threadId, "ZCode app-server terminated during setup");
      }
      sessionRef.current = session;
      sessions.set(input.threadId, session);
      // Translation runs synchronously in onSessionEvent; drain the protocol's
      // independent notification stream so its queue cannot grow indefinitely.
      yield* spawned.client.sessionEvents.pipe(Stream.runDrain, Effect.forkIn(sessionScope));
      return session;
    });

    const materializeAppServerSession = Effect.fn("t3-provider-zcode/materializeSession")(
      function* (
        session: ZCodeSession,
        input: NativeSessionInput,
      ): Effect.fn.Return<NativeSessionRef, ProviderAdapterProcessError> {
        const resumeId = yield* resumeIdFor(input);
        const mcp = yield* mcpSessions.read(input.threadId);
        const mcpServers: ReadonlyArray<ZCodeWire.McpServerConfig> = mcp
          ? [
              {
                name: "t3-code",
                type: "http",
                url: mcp.endpoint,
                headers: [{ name: "Authorization", value: mcp.authorizationHeader }],
              },
            ]
          : [];
        const created = resumeId
          ? yield* session.spawned.client
              .sessionResume({
                sessionId: resumeId,
                workspace: workspaceRef(session.cwd),
                mcpServers,
              })
              .pipe(
                Effect.mapError((cause) =>
                  adapterError(session.threadId, "session/resume failed", cause),
                ),
              )
          : yield* session.spawned.client
              .sessionCreate({
                workspace: workspaceRef(session.cwd),
                mcpServers,
                mode: zcodeTurnModeFor(input, session.mode),
                ...(input.modelSelection !== undefined
                  ? { model: modelRefFor(input.modelSelection) }
                  : {}),
                persistence: "immediate",
                titleGenerationEnabled: false,
              })
              .pipe(
                Effect.mapError((cause) =>
                  adapterError(session.threadId, "session/create failed", cause),
                ),
              );
        const zcodeSessionId = created.session?.sessionId;
        if (
          zcodeSessionId === undefined ||
          (resumeId !== undefined && zcodeSessionId !== resumeId)
        ) {
          return yield* Effect.fail(
            adapterError(session.threadId, "ZCode runtime returned no session id"),
          );
        }
        yield* Ref.set(session.zcodeSessionId, zcodeSessionId);
        if (!session.live) {
          recoveryInputs.set(session.threadId, {
            ...input,
            resumeCursor: { sessionId: zcodeSessionId },
          });
          return yield* adapterError(
            session.threadId,
            "ZCode app-server terminated during materialization",
          );
        }
        if (created.session?.target !== undefined) {
          session.hasNativeGoal = created.session.target !== null;
          yield* emitFor(session, {
            type: "thread.metadata.updated",
            payload: { metadata: { goal: created.session.target } },
          });
        }
        // Plan is a persistent session mode on the app-server route; resume
        // does not carry a mode, so set it explicitly after resuming.
        if (resumeId !== undefined) {
          yield* session.spawned.client
            .sessionSetMode({
              sessionId: zcodeSessionId,
              mode: zcodeTurnModeFor(input, session.mode),
            })
            .pipe(
              Effect.mapError((cause) =>
                adapterError(session.threadId, "session/setMode failed", cause),
              ),
            );
        }
        yield* subscribeAndPump(session, zcodeSessionId);
        return {
          resumeCursor: { sessionId: zcodeSessionId },
          ...(created.messages === undefined ? {} : { messages: created.messages }),
        };
      },
    );

    const startSession = (input: NativeSessionInput, ownerScope?: Scope.Scope) =>
      Effect.gen(function* () {
        const recovery = recoveryInputs.get(input.threadId);
        if (input.resumeCursor === undefined && recovery !== undefined)
          input = { ...input, resumeCursor: recovery.resumeCursor };
        const mode = yield* zcodeModeOrReject(input);
        const cwd = input.cwd ?? process.cwd();
        const resumeId = yield* resumeIdFor(input);
        let session = sessions.get(input.threadId);
        if (session !== undefined) {
          const currentId = yield* Ref.get(session.zcodeSessionId);
          if (
            session.cwd !== cwd ||
            session.mode !== mode ||
            session.runtimeMode !== input.runtimeMode ||
            (resumeId !== undefined && currentId !== resumeId)
          ) {
            return yield* adapterError(
              input.threadId,
              "Stop the existing ZCode session before changing its workspace, mode or native identity",
            );
          }
        }
        if (session === undefined) session = yield* makeAppServerSession(input, mode, ownerScope);
        const currentId = yield* Ref.get(session.zcodeSessionId);
        const started =
          currentId === undefined
            ? yield* materializeAppServerSession(session, input).pipe(
                Effect.onError(() =>
                  Effect.gen(function* () {
                    yield* Scope.close(session.scope, Exit.void);
                    if (sessions.get(input.threadId) === session) sessions.delete(input.threadId);
                  }),
                ),
              )
            : { resumeCursor: { sessionId: currentId } };
        if (!session.live)
          return yield* adapterError(input.threadId, "ZCode app-server terminated during setup");
        recoveryInputs.delete(input.threadId);
        return started;
      });

    return ZCodeSessionRuntime.of({
      startSession,
      sendTurn: (input) => {
        let ownedTurnId: TurnId | undefined;
        return Effect.gen(function* () {
          let session = sessions.get(input.threadId);
          const recovery = recoveryInputs.get(input.threadId);
          if (session === undefined && recovery !== undefined) {
            yield* startSession(recovery);
            session = sessions.get(input.threadId);
          }
          if (session === undefined) {
            return yield* Effect.fail(
              adapterError(input.threadId, "No active ZCode session for this thread"),
            );
          }
          if (!session.live || session.interrupting)
            return yield* adapterError(input.threadId, "ZCode session is stopping");
          if (input.input === undefined) {
            return yield* Effect.fail(
              adapterError(input.threadId, "ZCode requires a continuation prompt for empty turns"),
            );
          }
          const goalCommand = nativeGoalCommand(input);
          if (goalCommand !== undefined) {
            if (zcodeTurnModeFor(input, session.mode) === "plan")
              return yield* adapterError(
                input.threadId,
                "Goal commands are unavailable in Plan mode",
              );
          }
          const turnId = TurnId.make(yield* Effect.orDie(crypto.randomUUIDv4()));
          const reserved = yield* Ref.modify(session.activeTurnId, (current) =>
            current === undefined ? [true, turnId] : [false, current],
          );
          if (!reserved)
            return yield* adapterError(input.threadId, "A ZCode turn is already active");
          session.toolNames.clear();
          ownedTurnId = turnId;

          const attachments = [];
          for (const attachment of input.attachments ?? []) {
            const attachmentPath = resolveAttachmentPath({ attachmentsDir, attachment });
            if (attachmentPath === null)
              return yield* adapterError(input.threadId, "Invalid ZCode attachment path");
            const mimeType =
              "mimeType" in attachment && typeof attachment.mimeType === "string"
                ? attachment.mimeType
                : "";
            attachments.push({
              path: attachmentPath,
              type: mimeType.startsWith("image/")
                ? "image"
                : mimeType === "application/pdf"
                  ? "pdf"
                  : mimeType.startsWith("video/")
                    ? "video"
                    : "file",
            });
          }
          const zcodeSessionId = yield* Ref.get(session.zcodeSessionId);
          if (zcodeSessionId === undefined) {
            return yield* Effect.fail(
              adapterError(input.threadId, "ZCode session is not materialized yet"),
            );
          }
          {
            yield* session.spawned.client
              .sessionSetMode({
                sessionId: zcodeSessionId,
                mode: zcodeTurnModeFor(input, session.mode),
              })
              .pipe(
                Effect.mapError((cause) =>
                  adapterError(session.threadId, "session/setMode failed", cause),
                ),
              );
          }
          session.goalTerminal = undefined;
          session.goalTurnStarted = false;
          session.goalIterationUsage = new Map();
          session.waitsForGoalBoundary =
            goalCommand !== undefined || session.hasNativeGoal === true;
          if (goalCommand !== undefined) {
            const client = session.spawned.client;
            const selection = input.modelSelection ?? session.modelSelection;
            const model = modelRefFor(selection);
            if (model !== undefined) {
              yield* client
                .sessionSetModel({ sessionId: zcodeSessionId, model })
                .pipe(
                  Effect.mapError((cause) =>
                    adapterError(input.threadId, "session/setModel failed", cause),
                  ),
                );
            }
            const goalStateVersion = session.goalStateVersion;
            const result = yield* client
              .sessionGoal({ sessionId: zcodeSessionId, inputId: turnId, ...goalCommand })
              .pipe(
                Effect.tapError(() =>
                  client
                    .sessionStop({ sessionId: zcodeSessionId })
                    .pipe(Effect.ignore, Effect.andThen(settleInteractions(session))),
                ),
                Effect.mapError((cause) =>
                  adapterError(input.threadId, "session/goal failed", cause),
                ),
              );
            const target = result.snapshot.session?.target;
            if (target !== undefined && session.goalStateVersion === goalStateVersion) {
              session.hasNativeGoal = target !== null;
              yield* emitFor(session, {
                type: "thread.metadata.updated",
                turnId,
                payload: { metadata: { goal: target } },
              });
            }
            if (result.response.length > 0)
              yield* emitFor(session, {
                type: "content.delta",
                turnId,
                payload: { streamKind: "assistant_text", delta: result.response },
              });
            if (result.startedTurn !== true) {
              session.waitsForGoalBoundary = false;
              yield* Ref.set(session.activeTurnId, undefined);
              yield* emitFor(session, {
                type: "turn.completed",
                turnId,
                payload: { state: "completed" },
              });
            }
            if (input.modelSelection !== undefined) session.modelSelection = input.modelSelection;
            return {
              threadId: input.threadId,
              turnId,
              resumeCursor: { sessionId: zcodeSessionId },
            };
          }
          yield* session.spawned.client
            .sessionSend({
              sessionId: zcodeSessionId,
              inputId: turnId,
              content: input.input,
              ...(attachments.length > 0 ? { attachments } : {}),
              ...((input.modelSelection ?? session.modelSelection) !== undefined
                ? { modelSelection: modelRefFor(input.modelSelection ?? session.modelSelection) }
                : {}),
            })
            .pipe(
              Effect.mapError((cause) =>
                adapterError(input.threadId, "session/send failed", cause),
              ),
            );
          if (input.modelSelection !== undefined) session.modelSelection = input.modelSelection;
          return { threadId: input.threadId, turnId, resumeCursor: { sessionId: zcodeSessionId } };
        }).pipe(
          Effect.onError(() =>
            // Turn teardown is best-effort; ignore cleanup failures.
            Effect.gen(function* () {
              const session = sessions.get(input.threadId);
              if (session === undefined || ownedTurnId === undefined) return;
              if ((yield* Ref.get(session.activeTurnId)) === ownedTurnId) {
                session.waitsForGoalBoundary = false;
                session.goalTerminal = undefined;
                yield* settleInteractions(session, ownedTurnId);
                for (const [nativeId, owner] of session.nativeTurns) {
                  if (owner === ownedTurnId) session.nativeTurns.delete(nativeId);
                }
                yield* Ref.set(session.activeTurnId, undefined);
              }
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        );
      },
      interruptTurn: (threadId: ThreadId, expectedTurnId?: TurnId) =>
        Effect.gen(function* () {
          const session = sessions.get(threadId);
          if (session === undefined) return;
          const turnId = yield* Ref.get(session.activeTurnId);
          if (turnId === undefined || (expectedTurnId !== undefined && expectedTurnId !== turnId))
            return;
          if (session.interrupting) return;
          session.interrupting = true;
          session.stopBoundary = yield* Deferred.make<void>();
          yield* settleInteractions(session, turnId);
          if (session.spawned !== undefined) {
            const sessionId = yield* Ref.get(session.zcodeSessionId);
            if (sessionId !== undefined) {
              // Stop acknowledges abort before the vendor releases its prompt lock.
              const stopped = yield* session.spawned.client.sessionStop({ sessionId }).pipe(
                Effect.andThen(Deferred.await(session.stopBoundary)),
                Effect.interruptible,
                Effect.timeoutOption("5 seconds"),
                Effect.catch(() => Effect.succeed(Option.none())),
              );
              if (Option.isNone(stopped)) {
                yield* session.spawned.terminate;
                yield* invalidateSession(session);
              }
            }
          }
          const tokenUsage = interruptedUsage(session);
          if (
            yield* Ref.modify(session.activeTurnId, (current) =>
              current === turnId ? [true, undefined] : [false, current],
            )
          ) {
            yield* emitFor(session, {
              type: "turn.aborted",
              turnId,
              payload: { reason: "Interrupted from T3", ...(tokenUsage ? { tokenUsage } : {}) },
            });
          }
          session.waitsForGoalBoundary = false;
          session.goalTerminal = undefined;
          session.goalIterationUsage = undefined;
          session.stopBoundary = undefined;
          for (const [nativeId, owner] of session.nativeTurns) {
            if (owner === turnId) session.nativeTurns.delete(nativeId);
          }
          session.interrupting = false;
          return tokenUsage;
        }).pipe(Effect.uninterruptible),
      respondToRequest: (threadId, requestId, decision, optionId) =>
        Effect.gen(function* () {
          const session = sessions.get(threadId);
          if (session === undefined) return;
          const pendingMap = yield* Ref.get(session.pendingApprovals);
          const pending = pendingMap.get(requestId);
          // Unknown or already-settled ids are ignored (validated no-op).
          if (pending === undefined || (yield* Deferred.isDone(pending.response))) return;
          // Forward the advertised response unchanged, including project rules.
          const optionResponse = permissionOptionFor(pending.options, decision, optionId)?.response;
          if (optionId !== undefined && optionResponse === undefined)
            return yield* adapterError(threadId, "Native ZCode permission option was not offered");
          if (optionResponse === undefined && decision !== "decline" && decision !== "cancel")
            return yield* adapterError(threadId, "Native ZCode permission option is not supported");
          const resolved = yield* Deferred.succeed(
            pending.response,
            optionResponse ?? { decision: "deny" },
          );
          if (resolved)
            yield* emitFor(session, {
              type: "request.resolved",
              requestId: RuntimeRequestId.make(requestId),
              payload: {
                requestType: "permission_approval",
                decision,
                ...(optionId === undefined ? {} : { optionId }),
              },
            });
        }),
      respondToUserInput: (threadId, requestId, answers) =>
        Effect.gen(function* () {
          const session = sessions.get(threadId);
          if (session === undefined) return;
          const pendingMap = yield* Ref.get(session.pendingUserInputs);
          const pending = pendingMap.get(requestId);
          if (pending === undefined || (yield* Deferred.isDone(pending.response))) return;
          const resolved = yield* Deferred.succeed(
            pending.response,
            pending.questionIds
              ? {
                  action: "accept",
                  content: Object.fromEntries(
                    pending.questionIds.map((id, index) => [`answer_${index}`, answers[id]]),
                  ),
                }
              : {
                  requestId: pending.nativeRequestId,
                  value: answers[pending.nativeRequestId],
                },
          );
          if (resolved)
            yield* emitFor(session, {
              type: "user-input.resolved",
              requestId: RuntimeRequestId.make(requestId),
              payload: { answers },
            });
        }),
      readNativeSnapshot: (threadId) =>
        Effect.gen(function* () {
          const session = sessions.get(threadId);
          if (!session?.live)
            return yield* adapterError(
              threadId,
              "Native snapshot requires a live app-server session",
            );
          const sessionId = yield* Ref.get(session.zcodeSessionId);
          if (!sessionId)
            return yield* adapterError(threadId, "Native session identity is unavailable");
          const result = yield* session.spawned.client
            .request("session/read", { sessionId })
            .pipe(
              Effect.mapError((cause) =>
                adapterError(threadId, "Native session read failed", cause),
              ),
            );
          const snapshot = yield* decodeNativeSnapshot(result).pipe(
            Effect.mapError((cause) =>
              adapterError(threadId, "Invalid native session snapshot", cause),
            ),
          );
          if (snapshot.session?.sessionId !== sessionId)
            return yield* adapterError(threadId, "Native snapshot belongs to a different session");
          return snapshot;
        }),
      forkNativeHead: (threadId) =>
        Effect.gen(function* () {
          const session = sessions.get(threadId);
          if (!session?.live)
            return yield* adapterError(threadId, "Native fork requires a live app-server session");
          if ((yield* Ref.get(session.activeTurnId)) !== undefined)
            return yield* adapterError(threadId, "Cannot fork during an active turn");
          const sessionId = yield* Ref.get(session.zcodeSessionId);
          if (!sessionId)
            return yield* adapterError(threadId, "Native session identity is unavailable");
          const response = yield* session.spawned.client
            .request("session/fork", { sessionId })
            .pipe(
              Effect.mapError((cause) =>
                adapterError(threadId, "Native checkpoint fork failed", cause),
              ),
            );
          const fork = yield* decodeNativeFork(response).pipe(
            Effect.mapError((cause) => adapterError(threadId, "Invalid native fork result", cause)),
          );
          if (
            fork.forkedSessionId === sessionId ||
            fork.snapshot.session?.sessionId !== fork.forkedSessionId ||
            (fork.parentSessionId !== undefined && fork.parentSessionId !== sessionId)
          )
            return yield* adapterError(
              threadId,
              "Native fork returned an inconsistent session identity",
            );
          // The fork inherits its parent's live MCP handles. Release them before
          // handing off the durable child to a separately owned T3 session.
          yield* session.spawned.client
            .sessionClose({ sessionId: fork.forkedSessionId })
            .pipe(
              Effect.mapError((cause) =>
                adapterError(threadId, "Could not release native fork handles", cause),
              ),
            );
          return fork.forkedSessionId;
        }),
      stopSession: (threadId) =>
        Effect.gen(function* () {
          recoveryInputs.delete(threadId);
          const session = sessions.get(threadId);
          if (session === undefined) return;
          session.live = false;
          sessions.delete(threadId);
          const turnId = yield* Ref.getAndSet(session.activeTurnId, undefined);
          yield* settleInteractions(session);
          if (turnId !== undefined)
            yield* emitFor(session, {
              type: "turn.aborted",
              turnId,
              payload: { reason: "ZCode session closed" },
            });
          if (session.spawned !== undefined) {
            const zcodeSessionId = yield* Ref.get(session.zcodeSessionId);
            if (zcodeSessionId !== undefined) {
              yield* session.spawned.client
                .sessionClose({ sessionId: zcodeSessionId })
                .pipe(Effect.ignore);
            }
            yield* session.spawned.terminate;
          }
          yield* Scope.close(session.scope, Exit.void).pipe(Effect.ignore);
        }),
      listSessions: () =>
        Effect.gen(function* () {
          const snapshots: Array<
            NativeSessionRef & {
              threadId: ThreadId;
              status: "running" | "ready";
              activeTurnId?: TurnId;
            }
          > = [];
          for (const session of sessions.values()) {
            if (!session.live) continue;
            const zcodeSessionId = yield* Ref.get(session.zcodeSessionId);
            const activeTurnId = yield* Ref.get(session.activeTurnId);
            const running = activeTurnId !== undefined;
            snapshots.push({
              status: running ? ("running" as const) : ("ready" as const),
              threadId: session.threadId,
              ...(zcodeSessionId !== undefined
                ? { resumeCursor: { sessionId: zcodeSessionId } }
                : {}),
              ...(activeTurnId !== undefined ? { activeTurnId } : {}),
            });
          }
          return snapshots;
        }),
      hasSession: (threadId) => Effect.sync(() => sessions.get(threadId)?.live === true),
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    });
  });

export const layer = (settings: ZCodeSettings, options: ZCodeSessionRuntimeOptions) =>
  Layer.effect(ZCodeSessionRuntime, makeZCodeSessionRuntime(settings, options));
