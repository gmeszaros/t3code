/**
 * ResetCreditRequests - quota resets an agent asks the user to approve.
 *
 * The agent asks through its provider toolkit; the user answers an approval
 * card in the asking thread. Only an explicit approval there redeems, and the
 * redemption runs through the provider instance's own `consumeResetCredit`
 * with an idempotency key pinned to the approved card. Uncertain attempts are
 * never automatically or manually replayed by this service. An
 * accepted reset is reported as accepted, never as recovered execution.
 *
 * @module ResetCreditRequests
 */
import {
  CommandId,
  NodeId,
  type OrchestrationV2StoredEvent,
  type ProviderInstanceId,
  ProviderQuotaResetRequestResult,
  type ProviderQuotaResetRequestInput,
  ResetCreditRequestAnswerInput,
  ResetCreditRequestError,
  type RunId,
  type ServerProviderResetCreditWindow,
  type ServerProviderResetCreditWindowsUnavailable,
  type ServerProviderUsageWindow,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHash.
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

const ITEM_PREFIX = "turn-item:reset-credit-request";
const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_WAIT_TIMEOUT_MS = 60 * 60 * 1_000;
const WINDOW_LABELS = { five_hour: "5-hour", weekly: "weekly" } as const;
const ASKING_AGAIN_NOTE =
  "Ask again with a new clientRequestId if a reset is still needed; a new id is a new, separately approved request.";

export class ResetCreditRequestThreadInactiveError extends Schema.TaggedError<ResetCreditRequestThreadInactiveError>()(
  "ResetCreditRequestThreadInactiveError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "Asking for a quota reset requires an active run owned by this provider session.";
  }
}

/** The asking run: the card lives on it, and it ends the card if it ends first. */
interface AskingRun {
  readonly id: RunId;
  readonly nodeId: NodeId;
}

/**
 * The card's whole identity, derived from where the request was asked. A
 * retry with the same clientRequestId finds the same card, answer and
 * outcome; a new id is a new, separately approved request.
 */
interface RequestIdentity {
  readonly turnItemId: ReturnType<typeof TurnItemId.make>;
  /** Correlation key for the single approved provider operation; no retry safety is assumed. */
  readonly idempotencyKey: string;
}

type ResetCreditRequestCard = Extract<
  OrchestrationV2ThreadProjection["turnItems"][number],
  { readonly type: "reset_credit_request" }
>;

/** An answer a settled card carries, as the tool result reports it. */
const cardResult = (card: ResetCreditRequestCard): ProviderQuotaResetRequestResult => {
  if (card.requestStatus === "declined") {
    return { status: "declined", verifiedRecovery: false, resetWindowId: card.resetWindowId };
  }
  if (card.requestStatus === "cancelled") {
    return {
      status: "approval_cancelled",
      verifiedRecovery: false,
      resetWindowId: card.resetWindowId,
    };
  }
  // Missing or lost outcomes remain uncertain. Never infer that no credit was spent.
  if (card.outcome === undefined || card.outcome === "unconfirmed") {
    return {
      status: "unconfirmed",
      verifiedRecovery: false,
      resetWindowId: card.resetWindowId,
      note: "The provider's redemption outcome is uncertain; the credit may have been spent.",
    };
  }
  if (card.outcome === "failed") {
    return {
      status: "failed",
      verifiedRecovery: false,
      resetWindowId: card.resetWindowId,
      note: "The provider refused this approved reset.",
    };
  }
  if (card.outcome === "reset") {
    return {
      status: "accepted",
      verifiedRecovery: false,
      resetWindowId: card.resetWindowId,
      outcome: "reset",
      // quotaAfter belongs only to the original result. The caller attaches
      // current replay inventory separately; it is not historical usage.
      note: "The provider accepted this reset earlier; no new redemption was attempted. quotaBefore is the current replay snapshot, not historical pre-reset usage; quotaAfter from the original attempt is not retained. This is not verified recovery.",
    };
  }
  return {
    status: "failed",
    verifiedRecovery: false,
    resetWindowId: card.resetWindowId,
    outcome: card.outcome,
    note: `The provider reported ${card.outcome}.`,
  };
};

/**
 * True when the card already answers its request and a replay needs nothing
 * from the provider: a declined or cancelled ask, or an approved redemption
 * whose outcome names a settled result. Lost answers remain uncertain and never redeem again.
 */
const settledConfirmed = (card: ResetCreditRequestCard): boolean => {
  if (card.requestStatus === "declined" || card.requestStatus === "cancelled") return true;
  return (
    card.requestStatus === "approved" &&
    card.outcome !== undefined &&
    card.outcome !== "unconfirmed"
  );
};

const identityFor = (input: {
  readonly requestNamespace: string;
  readonly threadId: ThreadId;
  readonly clientRequestId: string;
}): RequestIdentity => {
  const turnItemId = TurnItemId.make(
    [
      ITEM_PREFIX,
      encodeURIComponent(input.requestNamespace),
      encodeURIComponent(input.threadId),
      encodeURIComponent(input.clientRequestId),
    ].join(":"),
  );
  return {
    turnItemId,
    idempotencyKey: NodeCrypto.createHash("sha256").update(turnItemId).digest("hex").slice(0, 32),
  };
};

/**
 * Picks the window to redeem: the one named, or the only one with a usable
 * credit. Both empty means nothing to redeem; anything else unnamed — several
 * windows, or counts the provider did not report — leaves the choice to the
 * agent rather than guessing.
 */
const resolveWindow = (
  requested: "five_hour" | "weekly" | undefined,
  windows: ReadonlyArray<ServerProviderResetCreditWindow> | undefined,
): "five_hour" | "weekly" | "none" | "ambiguous" => {
  if (requested !== undefined) return requested;
  if (windows === undefined) return "ambiguous";
  const usable = windows.filter(
    (window): window is typeof window & { readonly id: "five_hour" | "weekly" } =>
      (window.id === "five_hour" || window.id === "weekly") && window.availableCount !== 0,
  );
  const only = usable.length === 1 ? usable[0] : undefined;
  if (only !== undefined) return only.id;
  return usable.length === 0 && windows.every((window) => window.availableCount === 0)
    ? "none"
    : "ambiguous";
};

/**
 * A fresh read of what the account can redeem and how its quota stands, taken
 * when the ask is (re)joined so the card never offers credit that is gone and
 * the result carries the pre-reset quota schedule. Both halves are optional:
 * an absent half means the boundary could not read it, and the result says so
 * instead of omitting it silently.
 */
interface ResetInventoryRead {
  readonly resetCreditWindows?: ReadonlyArray<ServerProviderResetCreditWindow>;
  readonly resetCreditWindowsUnavailable?: ServerProviderResetCreditWindowsUnavailable;
  readonly quotaWindows?: ReadonlyArray<ServerProviderUsageWindow>;
  readonly quotaUnavailableReason?: "unsupported" | "probeFailed";
}

/** The inventory's fields, as the result schema carries them. */
const inventoryFields = (
  inventory: ResetInventoryRead,
): Pick<
  ProviderQuotaResetRequestResult,
  | "resetCreditWindows"
  | "resetCreditWindowsUnavailable"
  | "quotaBefore"
  | "quotaState"
  | "quotaSchedule"
> => ({
  quotaState:
    inventory.quotaUnavailableReason === "probeFailed"
      ? "error"
      : inventory.quotaUnavailableReason !== undefined || inventory.quotaWindows === undefined
        ? "unavailable"
        : "supported",
  quotaSchedule: (inventory.quotaWindows ?? []).map((window) => ({
    id: window.id,
    kind: window.kind,
    exhausted: window.usedPercent >= 100,
    ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
    timezone:
      window.resetsAt !== undefined && EXPLICIT_ZONE.test(window.resetsAt)
        ? ("explicit" as const)
        : ("unknown" as const),
  })),
  ...(inventory.resetCreditWindows === undefined
    ? {}
    : { resetCreditWindows: [...inventory.resetCreditWindows] }),
  ...(inventory.resetCreditWindowsUnavailable === undefined
    ? {}
    : { resetCreditWindowsUnavailable: inventory.resetCreditWindowsUnavailable }),
  ...(inventory.quotaWindows === undefined
    ? {}
    : {
        quotaBefore: inventory.quotaWindows.map(({ resetsAt, ...window }) => ({
          ...window,
          ...(resetsAt !== undefined && EXPLICIT_ZONE.test(resetsAt) ? { resetsAt } : {}),
        })),
      }),
});

// An evidenced reset time ends with an explicit UTC offset; anything else the
// provider sent is reported with its timezone unknown, never given one.
const EXPLICIT_ZONE = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

/**
 * The one sentence the result must add about the pre-reset schedule: unknown
 * when it could not be read, unknown timezone when the provider sent bare
 * timestamps. An evidenced schedule needs no extra words — `quotaBefore`
 * carries the UTC times themselves.
 */
const quotaScheduleNote = (inventory: ResetInventoryRead): string | undefined => {
  if (inventory.quotaUnavailableReason !== undefined || inventory.quotaWindows === undefined) {
    return "The account's current quota and its reset schedule could not be read, so the reset time is unknown.";
  }
  if (inventory.quotaWindows.length === 0) {
    return "This provider reports no quota windows here, so no reset schedule is known.";
  }
  if (
    inventory.quotaWindows.some(
      (window) => window.resetsAt !== undefined && !EXPLICIT_ZONE.test(window.resetsAt),
    )
  ) {
    return "The provider reported reset times without a timezone: treat them as timezone unknown.";
  }
  return undefined;
};

export class ResetCreditRequests extends Context.Service<
  ResetCreditRequests,
  {
    /**
     * Asks the user in the asking thread to approve spending one banked reset
     * credit, and redeems only after an explicit approval there. Reusing a
     * clientRequestId returns the earlier answer without a second redemption.
     */
    readonly request: (input: {
      readonly requestNamespace: string;
      readonly threadId: ThreadId;
      readonly providerInstanceId: ProviderInstanceId;
      readonly input: ProviderQuotaResetRequestInput;
    }) => Effect.Effect<ProviderQuotaResetRequestResult, ResetCreditRequestThreadInactiveError>;
    /** Answers a pending card in a thread. Approval alone redeems nothing. */
    readonly answer: (
      input: ResetCreditRequestAnswerInput,
    ) => Effect.Effect<void, ResetCreditRequestError>;
  }
>()("t3/provider/ResetCreditRequests") {}

const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const eventSink = yield* EventSink.EventSinkV2;

  const locks = yield* KeyedLock.make<string>();

  const loadCard = (threadId: ThreadId, turnItemId: string) =>
    threadManagement
      .getThreadRecords(threadId, ["runs", "turnItems"], {
        turnItemTypes: ["reset_credit_request"],
        messageRoles: [],
      })
      .pipe(
        Effect.mapError((cause) => new ResetCreditRequestError({ reason: "load_failed", cause })),
        Effect.map(
          (records) =>
            records.turnItems.find(
              (item): item is ResetCreditRequestCard =>
                item.id === turnItemId && item.type === "reset_credit_request",
            ) ?? null,
        ),
      );

  const loadAskingRun = (threadId: ThreadId) =>
    threadManagement
      .getThreadRecords(threadId, ["runs"], { turnItemTypes: [], messageRoles: [] })
      .pipe(
        Effect.mapError(() => new ResetCreditRequestThreadInactiveError({ threadId })),
        Effect.map((projection) => ThreadManagementService.latestActiveRun(projection)),
      );

  const readInventory = (providerInstanceId: ProviderInstanceId) =>
    providerRegistry.refreshInstance(providerInstanceId).pipe(
      Effect.map((providers): ResetInventoryRead => {
        const limits = providers.find((p) => p.instanceId === providerInstanceId)?.usageLimits;
        return {
          ...(limits?.resetCreditWindows === undefined
            ? {}
            : { resetCreditWindows: limits.resetCreditWindows }),
          ...(limits?.resetCreditWindowsUnavailable === undefined
            ? {}
            : { resetCreditWindowsUnavailable: limits.resetCreditWindowsUnavailable }),
          ...(limits?.windows === undefined ? {} : { quotaWindows: limits.windows }),
          ...(limits?.unavailable === undefined
            ? {}
            : { quotaUnavailableReason: limits.unavailable.reason }),
        };
      }),
      Effect.orElseSucceed((): ResetInventoryRead => ({
        quotaUnavailableReason: "probeFailed",
        resetCreditWindowsUnavailable: { reason: "probeFailed" },
      })),
    );

  const record = (input: {
    readonly threadId: ThreadId;
    readonly askingRun: AskingRun;
    readonly turnItemId: ReturnType<typeof TurnItemId.make>;
    readonly label: string;
    readonly reason: string;
    readonly providerInstanceId: ProviderInstanceId;
    readonly resetWindowId: "five_hour" | "weekly";
    readonly requestStatus: "pending" | "approved" | "declined" | "cancelled";
    readonly outcome?: ProviderQuotaResetRequestResult["outcome"] | "failed" | "unconfirmed";
    readonly warning?: string;
    readonly resetAccountIdentity?: string;
  }) =>
    threadManagement
      .dispatch({
        type: "reset_credit_request.record",
        commandId: CommandId.make(
          input.outcome === undefined
            ? `${ITEM_PREFIX}:${input.turnItemId}:${input.requestStatus}`
            : `${ITEM_PREFIX}:${input.turnItemId}:${input.requestStatus}:${input.outcome}`,
        ),
        threadId: input.threadId,
        runId: input.askingRun.id,
        nodeId: input.askingRun.nodeId,
        turnItemId: input.turnItemId,
        label: input.label,
        reason: input.reason,
        providerInstanceId: input.providerInstanceId,
        resetWindowId: input.resetWindowId,
        ...(input.resetAccountIdentity === undefined
          ? {}
          : { resetAccountIdentity: input.resetAccountIdentity }),
        requestStatus: input.requestStatus,
        ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
        ...(input.warning === undefined ? {} : { warning: input.warning }),
      })
      .pipe(
        Effect.mapError((cause) => new ResetCreditRequestError({ reason: "record_failed", cause })),
      );

  /**
   * Waits until the card is answered or the asking run ends. The committed
   * event stream carries exactly what clients see — the answer's
   * `turn-item.updated` and the run's terminal `run.updated` — so the wait
   * needs no polling. The sequence snapshot is taken before the card is read,
   * so an answer that races the read replays through the subscription and is
   * still seen.
   */
  const waitAnswered = Effect.fn("ResetCreditRequests.waitAnswered")(function* (input: {
    readonly threadId: ThreadId;
    readonly askingRun: AskingRun;
    readonly turnItemId: string;
  }) {
    const inactive = () => new ResetCreditRequestThreadInactiveError({ threadId: input.threadId });
    const afterSequence = yield* eventSink
      .latestSequence({ threadId: input.threadId })
      .pipe(Effect.mapError(() => inactive()));
    const card = yield* loadCard(input.threadId, input.turnItemId).pipe(
      Effect.mapError(() => inactive()),
    );
    if (card !== null && card.requestStatus !== "pending") return card.requestStatus;
    const asking = yield* loadAskingRun(input.threadId);
    if (asking === undefined || asking.id !== input.askingRun.id) {
      // The run that asked has ended or been replaced: nobody will act on an
      // answer, so the caller takes none and closes the card.
      return "cancelled";
    }
    const woke = yield* eventSink.stream({ threadId: input.threadId, afterSequence }).pipe(
      Stream.filter((stored: OrchestrationV2StoredEvent) => {
        if (stored.event.type === "turn-item.updated") {
          const item = stored.event.payload;
          return (
            item.id === input.turnItemId &&
            item.type === "reset_credit_request" &&
            item.requestStatus !== "pending"
          );
        }
        return (
          stored.event.type === "run.updated" &&
          stored.event.payload.id === input.askingRun.id &&
          ThreadManagementService.isTerminalRunStatus(stored.event.payload.status)
        );
      }),
      Stream.take(1),
      Stream.runHead,
      Effect.mapError(() => inactive()),
    );
    // The asking run ended first: the card takes no answer.
    if (Option.isSome(woke) && woke.value.event.type === "run.updated") return "cancelled";
    const settled = yield* loadCard(input.threadId, input.turnItemId).pipe(
      Effect.mapError(() => inactive()),
    );
    return settled !== null && settled.requestStatus !== "pending"
      ? settled.requestStatus
      : "cancelled";
  });

  return ResetCreditRequests.of({
    answer: (input) =>
      Effect.gen(function* () {
        const records = yield* threadManagement
          .getThreadRecords(input.threadId, ["runs", "turnItems"], {
            turnItemTypes: ["reset_credit_request"],
            messageRoles: [],
          })
          .pipe(
            Effect.mapError(
              (cause) => new ResetCreditRequestError({ reason: "load_failed", cause }),
            ),
          );
        const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
        if (item?.type !== "reset_credit_request" || item.runId === null || item.nodeId === null) {
          return yield* new ResetCreditRequestError({ reason: "not_found" });
        }
        if (item.requestStatus !== "pending") {
          return yield* new ResetCreditRequestError({ reason: "already_answered" });
        }
        // The agent is waiting inside the run that asked; once it has ended,
        // nobody will act on the answer, so it takes none.
        const run = records.runs.find((candidate) => candidate.id === item.runId);
        if (run === undefined || ThreadManagementService.isTerminalRunStatus(run.status)) {
          return yield* new ResetCreditRequestError({ reason: "agent_stopped" });
        }
        yield* threadManagement
          .dispatch({
            type: "reset_credit_request.record",
            commandId: CommandId.make(
              `${ITEM_PREFIX}:${item.id}:${input.answer.type === "approve" ? "approved" : "declined"}`,
            ),
            threadId: input.threadId,
            runId: item.runId,
            nodeId: item.nodeId,
            turnItemId: item.id,
            label: item.label,
            reason: item.reason,
            providerInstanceId: item.providerInstanceId,
            resetWindowId: item.resetWindowId,
            ...(item.resetAccountIdentity === undefined
              ? {}
              : { resetAccountIdentity: item.resetAccountIdentity }),
            requestStatus: input.answer.type === "approve" ? "approved" : "declined",
          })
          .pipe(
            Effect.mapError(
              (cause) => new ResetCreditRequestError({ reason: "record_failed", cause }),
            ),
          );
      }).pipe(Effect.withSpan("ResetCreditRequests.answer")),

    request: ({ input, providerInstanceId, requestNamespace, threadId }) =>
      Effect.gen(function* () {
        const identity = identityFor({
          requestNamespace,
          threadId,
          clientRequestId: input.clientRequestId ?? "default",
        });
        // One in-flight flow per card: a concurrent duplicate queues here and
        // then reads the settled answer instead of asking or redeeming again.
        return yield* locks.withLock(
          identity.turnItemId,
          Effect.gen(function* () {
            const existing = yield* loadCard(threadId, identity.turnItemId).pipe(
              Effect.mapError(() => new ResetCreditRequestThreadInactiveError({ threadId })),
            );
            if (existing !== null && existing.providerInstanceId !== providerInstanceId) {
              return {
                status: "unavailable",
                verifiedRecovery: false,
                resetWindowId: existing.resetWindowId,
                note: "This request belongs to another provider instance; its approval cannot be reused.",
              } satisfies ProviderQuotaResetRequestResult;
            }
            const currentRoute = yield* threadManagement.getThreadRecords(threadId, []).pipe(
              Effect.map((records) => records.thread.providerInstanceId),
              Effect.mapError(() => new ResetCreditRequestThreadInactiveError({ threadId })),
            );
            if (currentRoute !== providerInstanceId) {
              return {
                status: "unavailable",
                verifiedRecovery: false,
                note: "The thread provider changed; no approval or reset was reused.",
              } satisfies ProviderQuotaResetRequestResult;
            }
            const inventory = yield* readInventory(providerInstanceId);
            const metadata = inventoryFields(inventory);
            const scheduleNote = quotaScheduleNote(inventory);
            if (existing !== null && settledConfirmed(existing)) {
              return { ...cardResult(existing), ...metadata };
            }
            const askingRun = yield* loadAskingRun(threadId);
            if (
              askingRun === undefined ||
              askingRun.rootNodeId === null ||
              (existing !== null && existing.runId !== askingRun.id)
            ) {
              if (existing?.requestStatus === "approved")
                return { ...cardResult(existing), ...metadata };
              if (existing !== null)
                return {
                  status: "approval_cancelled",
                  verifiedRecovery: false,
                  resetWindowId: existing.resetWindowId,
                  ...metadata,
                } satisfies ProviderQuotaResetRequestResult;
              return yield* new ResetCreditRequestThreadInactiveError({ threadId });
            }
            const run: AskingRun = { id: askingRun.id, nodeId: askingRun.rootNodeId };
            if (existing?.requestStatus === "approved" && existing.outcome === undefined) {
              return {
                ...cardResult(existing),
                ...metadata,
                note: "Approval was preserved without an attempt record. No POST was retried: reconcile the account before approving another reset.",
              };
            }
            if (existing?.requestStatus === "approved" && existing.outcome === "unconfirmed") {
              return {
                ...cardResult(existing),
                ...metadata,
                note: "The earlier redemption is uncertain. No POST was retried: provider key retention is undocumented. Check the account before approving any new reset.",
              };
            }
            let resetAccountIdentity = existing?.resetAccountIdentity;
            const windows = inventory.resetCreditWindows;
            const windowId = existing?.resetWindowId ?? resolveWindow(input.resetWindowId, windows);

            // A new card asks; a pending replay rejoins its wait. The
            // availability gates run only for a new card: an existing card
            // already passed them when it was asked, and an approval, once
            // given, has already spent the user's decision.
            if (existing === null || existing.requestStatus === "pending") {
              const instance = yield* providerInstances.getInstance(providerInstanceId);
              if (existing === null && (instance === undefined || !instance.enabled)) {
                return {
                  status: "unsupported",
                  verifiedRecovery: false,
                  ...metadata,
                  ...(windowId === "five_hour" || windowId === "weekly"
                    ? { resetWindowId: windowId }
                    : {}),
                  note:
                    instance === undefined
                      ? "The calling thread's provider instance could not be found."
                      : "This provider instance is disabled, so nothing can be redeemed on it.",
                } satisfies ProviderQuotaResetRequestResult;
              }
              if (instance?.consumeResetCredit === undefined) {
                return {
                  status: "unsupported",
                  verifiedRecovery: false,
                  ...metadata,
                  note: "This provider does not bank reset credits.",
                } satisfies ProviderQuotaResetRequestResult;
              }
              if (instance.driverKind !== "zcode") {
                return {
                  status: "unsupported",
                  verifiedRecovery: false,
                  ...metadata,
                  note: `Agent-requested resets currently support the ZCode driver only, not ${instance.driverKind}.`,
                } satisfies ProviderQuotaResetRequestResult;
              }
              if (inventory.resetCreditWindowsUnavailable !== undefined || windows === undefined) {
                return {
                  status:
                    inventory.resetCreditWindowsUnavailable?.reason === "probeFailed"
                      ? "error"
                      : "unavailable",
                  verifiedRecovery: false,
                  ...metadata,
                  note: scheduleNote ?? "Banked reset inventory is unavailable; nothing was asked.",
                } satisfies ProviderQuotaResetRequestResult;
              }
              if (windowId === "none" || windowId === "ambiguous") {
                return {
                  status: windowId === "none" ? "no_credit_available" : "window_ambiguous",
                  verifiedRecovery: false,
                  ...metadata,
                  ...(windows === undefined ? {} : { resetCreditWindows: [...windows] }),
                  note:
                    windowId === "none"
                      ? "The account banks no usable reset credit for either window, so nothing was asked."
                      : "Pass resetWindowId to choose the window whose reset credit to redeem.",
                } satisfies ProviderQuotaResetRequestResult;
              }

              const accountIdentity =
                instance.resetCreditAccountIdentity === undefined
                  ? undefined
                  : yield* instance.resetCreditAccountIdentity.pipe(
                      Effect.orElseSucceed(() => undefined),
                    );
              if (
                accountIdentity === undefined ||
                (existing !== null && resetAccountIdentity !== accountIdentity)
              ) {
                if (existing !== null)
                  yield* record({
                    threadId,
                    askingRun: run,
                    turnItemId: identity.turnItemId,
                    label: existing.label,
                    reason: existing.reason,
                    providerInstanceId,
                    resetWindowId: existing.resetWindowId,
                    requestStatus: "cancelled",
                  }).pipe(Effect.orElseSucceed(() => undefined));
                return {
                  status: "unavailable",
                  verifiedRecovery: false,
                  ...metadata,
                  note: "The reset account is unavailable or changed since this request. Nothing was redeemed; request a new approval for the current account.",
                } satisfies ProviderQuotaResetRequestResult;
              }
              resetAccountIdentity = accountIdentity;
              const windowLabel = WINDOW_LABELS[windowId as "five_hour" | "weekly"];
              const label = `Redeem a ${windowLabel} quota reset`;
              const reason =
                `An agent in this thread asked to spend one ${instance.displayName} reset credit ` +
                `on the ${windowLabel} quota window (instance ${providerInstanceId}). ` +
                "Redeeming clears that window now; each further reset needs its own approval.";
              if (existing === null)
                yield* record({
                  threadId,
                  askingRun: run,
                  turnItemId: identity.turnItemId,
                  label,
                  reason,
                  providerInstanceId,
                  resetWindowId: windowId,
                  resetAccountIdentity,
                  requestStatus: "pending",
                }).pipe(
                  Effect.mapError(() => new ResetCreditRequestThreadInactiveError({ threadId })),
                );

              const closeCard = record({
                threadId,
                askingRun: run,
                turnItemId: identity.turnItemId,
                label,
                reason,
                providerInstanceId,
                resetWindowId: windowId,
                requestStatus: "cancelled",
              }).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Could not close a reset credit request card", {
                    error: error.message,
                  }),
                ),
              );

              const answered = yield* waitAnswered({
                threadId,
                askingRun: run,
                turnItemId: identity.turnItemId,
              }).pipe(
                Effect.timeoutOption(
                  Duration.millis(
                    Math.min(input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS),
                  ),
                ),
                Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : closeCard)),
              );
              if (Option.isNone(answered)) yield* closeCard;
              // An answer that raced the timeout still wins: the card is
              // answered once. Only the user's two answers count here — a
              // cancellation this call just recorded is the timeout itself.
              const status = Option.isSome(answered)
                ? answered.value
                : yield* loadCard(threadId, identity.turnItemId).pipe(
                    Effect.map((card) =>
                      card !== null &&
                      (card.requestStatus === "approved" || card.requestStatus === "declined")
                        ? card.requestStatus
                        : ("timed_out" as const),
                    ),
                    Effect.catch(() => Effect.succeed("timed_out" as const)),
                  );
              if (status !== "approved") {
                // A dead ask closes its card: the run that asked has ended, so
                // no answer can reach it and a pending card must not linger.
                if (status === "cancelled") yield* closeCard;
                return {
                  status:
                    status === "declined"
                      ? ("declined" as const)
                      : status === "cancelled"
                        ? ("approval_cancelled" as const)
                        : ("approval_timed_out" as const),
                  verifiedRecovery: false as const,
                  ...metadata,
                  resetWindowId: windowId,
                  ...(windows === undefined ? {} : { resetCreditWindows: [...windows] }),
                  ...(status === "timed_out"
                    ? {
                        note: `The user did not answer in time and the card is closed. ${ASKING_AGAIN_NOTE}`,
                      }
                    : {}),
                } satisfies ProviderQuotaResetRequestResult;
              }
            }

            // Revalidate after waiting for the human: provider changes and terminal
            // runs cannot transfer an approval to another route or a later run.
            const latest = yield* threadManagement
              .getThreadRecords(threadId, ["runs"])
              .pipe(Effect.mapError(() => new ResetCreditRequestThreadInactiveError({ threadId })));
            const active = ThreadManagementService.latestActiveRun(latest);
            if (
              latest.thread.providerInstanceId !== providerInstanceId ||
              active?.id !== run.id ||
              resetAccountIdentity === undefined
            ) {
              yield* record({
                threadId,
                askingRun: run,
                turnItemId: identity.turnItemId,
                label: existing?.label ?? "Redeem a quota reset",
                reason: existing?.reason ?? "User-approved quota reset",
                providerInstanceId,
                resetWindowId: windowId as "five_hour" | "weekly",
                requestStatus: "approved",
                outcome: "failed",
                warning: "The provider or active run changed. No reset was attempted.",
              }).pipe(Effect.orElseSucceed(() => undefined));
              return {
                status: "unavailable",
                verifiedRecovery: false,
                note: "The thread provider or active run changed while awaiting approval. Nothing was redeemed.",
              } satisfies ProviderQuotaResetRequestResult;
            }
            const instance = yield* providerInstances.getInstance(providerInstanceId);
            if (
              instance?.consumeResetCredit === undefined ||
              !instance.enabled ||
              instance.driverKind !== "zcode"
            ) {
              yield* record({
                threadId,
                askingRun: run,
                turnItemId: identity.turnItemId,
                label: existing?.label ?? "Redeem a quota reset",
                reason: existing?.reason ?? "User-approved quota reset",
                providerInstanceId,
                resetWindowId: windowId as "five_hour" | "weekly",
                requestStatus: "approved",
                outcome: "failed",
                warning: "The provider instance is unavailable. No reset was attempted.",
              }).pipe(Effect.orElseSucceed(() => undefined));
              return {
                status: existing?.outcome === "unconfirmed" ? "unconfirmed" : "failed",
                verifiedRecovery: false,
                resetWindowId: windowId as "five_hour" | "weekly",
                ...metadata,
                note:
                  existing?.outcome === "unconfirmed"
                    ? "The earlier redemption remains uncertain. This provider instance is unavailable; no retry was attempted."
                    : "The approved reset was not attempted because the provider instance is unavailable.",
              } satisfies ProviderQuotaResetRequestResult;
            }
            // Persist uncertainty before crossing the provider boundary. If the
            // process exits after the POST, restart cannot treat it as unattempted.
            yield* record({
              threadId,
              askingRun: run,
              turnItemId: identity.turnItemId,
              label: existing?.label ?? "Redeem a quota reset",
              reason: existing?.reason ?? "User-approved quota reset",
              providerInstanceId,
              resetWindowId: windowId as "five_hour" | "weekly",
              requestStatus: "approved",
              outcome: "unconfirmed",
            }).pipe(Effect.mapError(() => new ResetCreditRequestThreadInactiveError({ threadId })));
            const redemption = yield* instance
              .consumeResetCredit(windowId as "five_hour" | "weekly", {
                idempotencyKey: identity.idempotencyKey,
                expectedAccountIdentity: resetAccountIdentity,
              })
              .pipe(
                Effect.map((outcome) => ({ outcome }) as const),
                Effect.catch((cause) =>
                  Effect.succeed({
                    outcome:
                      cause.redemption === "refused"
                        ? ("failed" as const)
                        : ("unconfirmed" as const),
                  }),
                ),
              );
            // Recording the outcome can fail when the asking run was cut after
            // the approval; the redemption itself already ran, so the record
            // failure is tolerated and the card stays approved.
            yield* record({
              threadId,
              askingRun: run,
              turnItemId: identity.turnItemId,
              label: `Redeem a ${WINDOW_LABELS[windowId as "five_hour" | "weekly"]} quota reset`,
              reason: `An agent in this thread asked to spend one reset credit on the ${
                WINDOW_LABELS[windowId as "five_hour" | "weekly"]
              } quota window (instance ${providerInstanceId}).`,
              providerInstanceId,
              resetWindowId: windowId as "five_hour" | "weekly",
              requestStatus: "approved",
              outcome: redemption.outcome,
            }).pipe(Effect.orElseSucceed(() => undefined));

            if (redemption.outcome !== "reset") {
              return {
                status: redemption.outcome === "unconfirmed" ? "unconfirmed" : "failed",
                verifiedRecovery: false,
                resetWindowId: windowId as "five_hour" | "weekly",
                ...metadata,
                ...(redemption.outcome === "failed" || redemption.outcome === "unconfirmed"
                  ? {}
                  : { outcome: redemption.outcome }),
                note:
                  redemption.outcome === "unconfirmed"
                    ? "The provider may have redeemed the credit. Provider key retention is undocumented, so this request will not POST again. Check the account before requesting another approval."
                    : `The provider reported ${redemption.outcome}. ${scheduleNote ?? ""}`,
              } satisfies ProviderQuotaResetRequestResult;
            }

            // Refreshed percentages are display state; only a later successful
            // turn on the model verifies recovery, so this tool never claims it.
            const quotaAfter = yield* providerRegistry.refreshInstance(providerInstanceId).pipe(
              Effect.map(
                (providers) =>
                  providers.find((candidate) => candidate.instanceId === providerInstanceId)
                    ?.usageLimits?.windows,
              ),
              Effect.orElseSucceed(() => undefined),
            );
            return {
              status: "accepted",
              verifiedRecovery: false,
              resetWindowId: windowId as "five_hour" | "weekly",
              outcome: "reset",
              ...metadata,
              ...(quotaAfter === undefined ? {} : { quotaAfter: [...quotaAfter] }),
              note: "The provider accepted the reset. This is not verified recovery: run a turn to confirm the model works.",
            } satisfies ProviderQuotaResetRequestResult;
          }),
        );
      }).pipe(Effect.withSpan("ResetCreditRequests.request")),
  });
});

export const layer = Layer.effect(ResetCreditRequests, make);
