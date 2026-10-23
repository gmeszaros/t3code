import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { UsageLimitSourceId } from "./usageLimitSourceId.ts";

/**
 * `id` is stable per provider (`five_hour`, `seven_day_opus`, `primary`) so a
 * sparse turn-driven update lands on the same row a full probe produced.
 */
export const ServerProviderUsageWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
  label: TrimmedNonEmptyString,
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.optional(IsoDateTime),
  windowDurationMins: Schema.optional(NonNegativeInt),
});
export type ServerProviderUsageWindow = typeof ServerProviderUsageWindow.Type;

export const ServerProviderResetCredits = Schema.Struct({
  availableCount: NonNegativeInt,
  nextExpiresAt: Schema.optional(IsoDateTime),
  /** Pins hub redemption to the displayed credit, including retries from another client. */
  nextCreditId: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderResetCredits = typeof ServerProviderResetCredits.Type;

/** Per-window reset inventory. Redemption is explicit rather than inferred from a balance. */
export const ServerProviderResetCreditWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  availableCount: Schema.NullOr(NonNegativeInt),
  nextExpiresAt: Schema.optional(IsoDateTime),
  canRedeem: Schema.optional(Schema.Boolean),
});
export type ServerProviderResetCreditWindow = typeof ServerProviderResetCreditWindow.Type;

/**
 * Why the per-window reset inventory is not a known count, when it is not.
 * `notSignedIn` means this environment cannot see the account's banked resets
 * at all; `probeFailed` means the read failed this time. A reported zero is a
 * fact and never carries this.
 */
export const ServerProviderResetCreditWindowsUnavailable = Schema.Struct({
  reason: Schema.Literals(["notSignedIn", "probeFailed"]),
  message: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderResetCreditWindowsUnavailable =
  typeof ServerProviderResetCreditWindowsUnavailable.Type;

/**
 * `unavailable` distinguishes an account that can never report windows (API
 * key, Bedrock) from a probe that failed this time, so clients can keep the
 * last good bars for the latter and clear them for the former.
 */
export const ServerProviderUsageLimits = Schema.Struct({
  checkedAt: IsoDateTime,
  windows: ForwardCompatibleArray(ServerProviderUsageWindow),
  credentialFingerprint: Schema.optional(TrimmedNonEmptyString),
  resetCredits: Schema.optional(ServerProviderResetCredits),
  resetCreditWindows: Schema.optional(Schema.Array(ServerProviderResetCreditWindow)),
  resetCreditWindowsUnavailable: Schema.optional(ServerProviderResetCreditWindowsUnavailable),
  /** Provider-owned usage settings when quota windows are not available to the client. */
  externalUsage: Schema.optional(
    Schema.Struct({
      label: TrimmedNonEmptyString,
      url: TrimmedNonEmptyString,
    }),
  ),
  unavailable: Schema.optional(
    Schema.Struct({
      reason: Schema.Literals(["unsupported", "probeFailed"]),
      message: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
});
export type ServerProviderUsageLimits = typeof ServerProviderUsageLimits.Type;

/**
 * Sparse by contract: Claude's `rate_limit_event` names one window at a time
 * and Codex documents its notification as a partial. Windows merge by `id` onto
 * the instance's published snapshot; omitted windows are unchanged.
 */
export const ProviderUsageLimitsUpdate = Schema.Struct({
  windows: Schema.Array(ServerProviderUsageWindow),
});
export type ProviderUsageLimitsUpdate = typeof ProviderUsageLimitsUpdate.Type;

export const UsageLimitSourceAccount = Schema.Struct({
  id: TrimmedNonEmptyString,
  driver: ProviderDriverKind,
  email: Schema.optional(TrimmedNonEmptyString),
  plan: Schema.optional(TrimmedNonEmptyString),
  workspaceId: Schema.optional(TrimmedNonEmptyString),
  usageLimits: ServerProviderUsageLimits,
});
export type UsageLimitSourceAccount = typeof UsageLimitSourceAccount.Type;

export const UsageLimitSourceSnapshot = Schema.Struct({
  id: UsageLimitSourceId,
  kind: Schema.Literal("cliproxy"),
  label: TrimmedNonEmptyString,
  checkedAt: IsoDateTime,
  accounts: ForwardCompatibleArray(UsageLimitSourceAccount),
  error: Schema.optional(TrimmedNonEmptyString),
});
export type UsageLimitSourceSnapshot = typeof UsageLimitSourceSnapshot.Type;

export const UsageLimitSourceSnapshots = ForwardCompatibleArray(UsageLimitSourceSnapshot);
export type UsageLimitSourceSnapshots = typeof UsageLimitSourceSnapshots.Type;

export const UsageLimitSourceConsumeResetCreditInput = Schema.Struct({
  sourceId: UsageLimitSourceId,
  accountId: TrimmedNonEmptyString,
  creditId: TrimmedNonEmptyString,
});
export type UsageLimitSourceConsumeResetCreditInput =
  typeof UsageLimitSourceConsumeResetCreditInput.Type;

export const ProviderConsumeResetCreditInput = Schema.Union([
  Schema.Struct({
    instanceId: ProviderInstanceId,
    resetWindowId: Schema.optional(Schema.Literals(["five_hour", "weekly"])),
  }),
  UsageLimitSourceConsumeResetCreditInput,
]);
export type ProviderConsumeResetCreditInput = typeof ProviderConsumeResetCreditInput.Type;

export class UsageLimitSourceError extends Schema.TaggedError<UsageLimitSourceError>()(
  "UsageLimitSourceError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export const ProviderConsumeResetCreditOutcome = Schema.Literals([
  "reset",
  "nothingToReset",
  "noCredit",
  "alreadyRedeemed",
]);
export type ProviderConsumeResetCreditOutcome = typeof ProviderConsumeResetCreditOutcome.Type;

export const ProviderConsumeResetCreditResult = Schema.Struct({
  outcome: ProviderConsumeResetCreditOutcome,
  warning: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderConsumeResetCreditResult = typeof ProviderConsumeResetCreditResult.Type;

/**
 * An agent's request to spend one banked reset credit. The request never
 * redeems on its own: the server asks the user in the requesting thread and
 * redeems only after an explicit approval there.
 */
export const ProviderQuotaResetRequestInput = Schema.Struct({
  resetWindowId: Schema.optional(Schema.Literals(["five_hour", "weekly"])).annotate({
    description:
      "Which quota window to redeem a reset for. Omit it only when you do not know which window is exhausted: with exactly one window holding banked resets it is chosen for you; otherwise the result lists every window and you must retry naming one.",
  }),
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 60 * 60 * 1_000 })),
  ).annotate({ description: "How long to wait for the user's answer. Default 10 minutes." }),
  clientRequestId: Schema.optional(TrimmedNonEmptyString).annotate({
    description:
      "Reuse for a caller-initiated retry of an uncertain result within 60 seconds in the same process: it uses the same approval and provider idempotency key. After restart or expiry, reconcile the uncertain operation before approving another reset; provider key retention is undocumented. Settled results replay without POST. Use a new id only for a NEW separately approved reset.",
  }),
});
export type ProviderQuotaResetRequestInput = typeof ProviderQuotaResetRequestInput.Type;

/**
 * How an authorized quota reset request ended. `accepted` means the provider
 * confirmed the redemption; it is not verified recovery — only a successful
 * turn on the model can establish that. `unconfirmed` means the redemption's
 * answer was lost after approval: the provider may already have consumed the
 * credit, so nothing may claim it was not redeemed.
 */
export const ProviderQuotaResetRequestResult = Schema.Struct({
  status: Schema.Literals([
    "accepted",
    "unconfirmed",
    "unavailable",
    "error",
    "declined",
    "approval_cancelled",
    "approval_timed_out",
    "window_ambiguous",
    "no_credit_available",
    "unsupported",
    "failed",
  ]).annotate({
    description:
      "accepted: the user approved and the provider confirmed the redemption. unconfirmed: the user approved, the redemption ran, but its answer was lost; the provider may have applied the reset and spent the credit; retrying this same request re-sends the same idempotency key, subject to provider key retention; after restart or the local retry window it requires reconciliation. declined/cancelled/timed_out: no redemption was attempted. window_ambiguous: several windows could be redeemed, so name a resetWindowId. no_credit_available: the account banks no usable reset credit, so nothing was asked. unsupported: this provider cannot redeem resets through this tool. unavailable: native sign-in or inventory is unavailable. error: the inventory probe failed. failed: the user approved but the provider answered and refused (see outcome and note).",
  }),
  resetWindowId: Schema.optional(Schema.Literals(["five_hour", "weekly"])),
  /** The provider's own redemption outcome, when one was attempted and answered. */
  outcome: Schema.optional(ProviderConsumeResetCreditOutcome),
  /** Banked resets per window as the provider reported them for this request. */
  resetCreditWindows: Schema.optional(Schema.Array(ServerProviderResetCreditWindow)),
  /**
   * Why the banked-reset inventory above is unknown rather than a count, when
   * it is: the account is not signed in, or the read failed this time.
   */
  resetCreditWindowsUnavailable: Schema.optional(ServerProviderResetCreditWindowsUnavailable),
  /**
   * Quota windows as the account reported them before this call
   * (a replay reads current usage, not historical pre-redemption usage): each window's usage and its `resetsAt` — the time the QUOTA window
   * resets, which is not the banked credit's own expiry. A `resetsAt` carries
   * an explicit UTC offset when the provider evidenced one; a window without
   * one has an unknown reset time, and no offset is ever invented here.
   */
  quotaBefore: Schema.optional(Schema.Array(ServerProviderUsageWindow)),
  quotaState: Schema.optional(Schema.Literals(["supported", "unavailable", "error"])),
  quotaSchedule: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: TrimmedNonEmptyString,
        kind: ServerProviderUsageWindow.fields.kind,
        exhausted: Schema.Boolean,
        resetsAt: Schema.optional(Schema.String),
        timezone: Schema.Literals(["explicit", "unknown"]),
      }),
    ),
  ),
  /**
   * Usage windows re-read after an accepted redemption; percentages are not
   * proof of recovery. Present only when the server re-read usage at
   * redemption time — a replay of an earlier result may omit it.
   */
  quotaAfter: Schema.optional(Schema.Array(ServerProviderUsageWindow)),
  /**
   * Always false: this tool never runs a generation probe, so it can never
   * claim the model works again. Verify by running a turn.
   */
  verifiedRecovery: Schema.Literal(false),
  note: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderQuotaResetRequestResult = typeof ProviderQuotaResetRequestResult.Type;

/** A point-in-time view of one provider's limits, built for the /usage-limits panel. */
export const UsageLimitsReport = Schema.Struct({
  createdAt: IsoDateTime,
  accounts: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      driver: ProviderDriverKind,
      label: TrimmedNonEmptyString,
      plan: Schema.optional(TrimmedNonEmptyString),
      email: Schema.optional(TrimmedNonEmptyString),
      sourceLabel: Schema.optional(TrimmedNonEmptyString),
      instanceId: Schema.optional(ProviderInstanceId),
      resetCreditInput: Schema.optional(ProviderConsumeResetCreditInput),
      displayName: Schema.optional(Schema.String),
      accentColor: Schema.optional(Schema.String),
      limits: ServerProviderUsageLimits,
    }),
  ),
  notices: Schema.Array(Schema.String),
});
export type UsageLimitsReport = typeof UsageLimitsReport.Type;
