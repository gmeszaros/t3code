import type { OrchestrationV2TurnItem, ResetCreditRequestAnswerInput } from "@t3tools/contracts";

export type ResetCreditRequestItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "reset_credit_request" }
>;

/**
 * What a reset request card shows: the approve/decline form while pending,
 * otherwise a one-line outcome. An accepted reset is never shown as verified
 * recovery — the card says the provider confirmed the redemption.
 */
export type ResetCreditRequestDisplay =
  | { readonly kind: "pending" }
  | { readonly kind: "pending-elsewhere" }
  | {
      readonly kind: "answered";
      readonly outcome:
        | "approved-reset"
        | "approved-failed"
        | "approved-pending"
        | "unconfirmed"
        | "noCredit"
        | "nothingToReset"
        | "alreadyRedeemed"
        | "declined"
        | "ended";
    };

const WINDOW_LABELS = { five_hour: "5-hour", weekly: "weekly" } as const;

export const resetCreditWindowLabel = (windowId: "five_hour" | "weekly") => WINDOW_LABELS[windowId];

/** `visibility` is the projected row's: a request can only be answered where it was asked. */
export function resetCreditRequestDisplay(
  item: Pick<ResetCreditRequestItem, "requestStatus" | "outcome">,
  visibility: "local" | "inherited" | "synthetic",
): ResetCreditRequestDisplay {
  switch (item.requestStatus) {
    case "pending":
      return visibility === "local" ? { kind: "pending" } : { kind: "pending-elsewhere" };
    case "approved":
      return {
        kind: "answered",
        outcome:
          item.outcome === undefined
            ? "approved-pending"
            : item.outcome === "reset"
              ? "approved-reset"
              : item.outcome === "failed"
                ? "approved-failed"
                : item.outcome,
      };
    case "declined":
      return { kind: "answered", outcome: "declined" };
    case "cancelled":
      return { kind: "answered", outcome: "ended" };
  }
}

/** One-line card summary for an answered request, in the thread's voice. */
export function resetCreditRequestOutcomeLabel(
  item: Pick<ResetCreditRequestItem, "requestStatus" | "outcome" | "resetWindowId">,
): string {
  const window = resetCreditWindowLabel(item.resetWindowId);
  switch (item.requestStatus) {
    case "pending":
      return `Waiting for approval to redeem a ${window} quota reset`;
    case "declined":
      return `Declined: no reset was redeemed`;
    case "cancelled":
      return `Request ended: no reset was redeemed`;
    case "approved":
      switch (item.outcome) {
        case undefined:
          return `Approved: redemption pending`;
        case "unconfirmed":
          return `Redemption uncertain: the provider may have spent the credit`;
        case "failed":
          return `Approved, but the provider refused the reset`;
        case "reset":
          return `Reset accepted for the ${window} window`;
        case "nothingToReset":
          return `Approved, but nothing needed a reset`;
        case "noCredit":
          return `Approved, but no reset credit remained`;
        case "alreadyRedeemed":
          return `Approved, but this reset was already redeemed`;
      }
  }
}

/**
 * Builds the RPC payload for an answer; the caller keeps Approve always
 * available (a deliberate approval is never blank like a secret).
 */
export function resetCreditRequestAnswerInput(
  item: Pick<ResetCreditRequestItem, "id" | "threadId">,
  answer: { readonly type: "approve" } | { readonly type: "decline" },
): ResetCreditRequestAnswerInput {
  return { threadId: item.threadId, turnItemId: item.id, answer };
}

/** Failures whose message is written for the user and never echoes the request payload. */
const USER_FACING_FAILURE_TAGS = new Set([
  "ResetCreditRequestError",
  "EnvironmentAuthorizationError",
]);

/**
 * Inline error copy for a failed answer. Only known server errors pass their
 * message through: anything else (transport or encoding failures) gets the
 * generic copy, so the typed value can never surface in the UI.
 */
export function resetCreditRequestFailureMessage(failure: unknown): string {
  if (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    typeof failure._tag === "string" &&
    USER_FACING_FAILURE_TAGS.has(failure._tag) &&
    "message" in failure &&
    typeof failure.message === "string" &&
    failure.message.trim().length > 0
  ) {
    return failure.message;
  }
  return "Could not answer the request. Try again.";
}
