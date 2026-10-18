import * as Schema from "effect/Schema";

import { ThreadId, TurnItemId } from "./baseSchemas.ts";

/**
 * The user's answer to an agent's request to spend a banked quota reset
 * credit. Approval is per redemption: the requesting tool redeems once, only
 * after an explicit approve.
 */
export const ResetCreditRequestAnswerInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  answer: Schema.Union([
    Schema.Struct({ type: Schema.Literal("approve") }),
    Schema.Struct({ type: Schema.Literal("decline") }),
  ]),
});
export type ResetCreditRequestAnswerInput = typeof ResetCreditRequestAnswerInput.Type;

const RESET_CREDIT_REQUEST_FAILURE_MESSAGES = {
  load_failed: "Could not load the reset request.",
  not_found: "This reset request no longer exists.",
  already_answered: "This reset request was already answered.",
  agent_stopped: "The agent that asked has stopped, so this reset can't be redeemed.",
  record_failed: "Could not update the reset request.",
} as const;

export const ResetCreditRequestFailureReason = Schema.Literals(
  Object.keys(RESET_CREDIT_REQUEST_FAILURE_MESSAGES) as Array<
    keyof typeof RESET_CREDIT_REQUEST_FAILURE_MESSAGES
  >,
);
export type ResetCreditRequestFailureReason = typeof ResetCreditRequestFailureReason.Type;

/** Answering a request failed; the message is shown to users and agents. */
export class ResetCreditRequestError extends Schema.TaggedError<ResetCreditRequestError>()(
  "ResetCreditRequestError",
  {
    reason: ResetCreditRequestFailureReason,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return RESET_CREDIT_REQUEST_FAILURE_MESSAGES[this.reason];
  }
}
