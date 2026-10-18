import { useAtomValue } from "@effect/atom-react";
import {
  resetCreditRequestAnswerInput,
  resetCreditRequestDisplay,
  resetCreditRequestFailureMessage,
  resetCreditRequestOutcomeLabel,
  type ResetCreditRequestItem,
} from "@t3tools/client-runtime/reset-credit-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { CheckIcon, HourglassIcon, MinusIcon, RefreshCcwIcon } from "lucide-react";
import { useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { WorkLogRow } from "./WorkLog";

/**
 * Inline card for a quota reset an agent asked the user to approve. Approving
 * spends one of the account's banked reset credits; the server redeems only
 * after the approve lands, and the card then shows the provider's own answer.
 * It never claims the model works again — only a later turn can show that.
 */
export function ResetCreditRequestCard(props: {
  readonly environmentId: EnvironmentId;
  readonly item: ResetCreditRequestItem;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
}) {
  const { item } = props;
  const display = resetCreditRequestDisplay(item, props.visibility);
  if (display.kind === "pending-elsewhere") {
    return (
      <WorkLogRow
        data-v2-item-type={item.type}
        icon={<HourglassIcon className="size-3.5 text-icon-muted" aria-hidden />}
        label={`${item.label} · waiting for an answer in the original thread`}
      />
    );
  }
  if (display.kind === "answered") {
    const Icon =
      display.outcome === "approved-reset"
        ? CheckIcon
        : display.outcome === "approved-pending"
          ? HourglassIcon
          : display.outcome === "unconfirmed" || display.outcome === "approved-failed"
            ? RefreshCcwIcon
            : MinusIcon;
    return (
      <WorkLogRow
        data-v2-item-type={item.type}
        icon={<Icon className="size-3.5 text-icon-muted" aria-hidden />}
        label={`${item.label} · ${resetCreditRequestOutcomeLabel(item)}`}
      />
    );
  }
  return <PendingResetCreditRequestForm environmentId={props.environmentId} item={item} />;
}

function PendingResetCreditRequestForm(props: {
  readonly environmentId: EnvironmentId;
  readonly item: ResetCreditRequestItem;
}) {
  const { item } = props;
  const canAnswer = useAtomValue(
    serverEnvironment.answerResetCreditRequest.permissionAtom(props.environmentId),
  );
  const answer = useAtomCommand(serverEnvironment.answerResetCreditRequest, {
    label: "answer reset credit request",
    // The failure cause holds the request; keep it out of the console.
    reportFailure: false,
    reportDefect: false,
  });
  const [submitting, setSubmitting] = useState<"approve" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Enter then a click can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);

  const send = async (reply: { readonly type: "approve" } | { readonly type: "decline" }) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(reply.type);
    setError(null);
    const result = await answer({
      environmentId: props.environmentId,
      input: resetCreditRequestAnswerInput(item, reply),
    }).finally(() => {
      inFlight.current = false;
      setSubmitting(null);
    });
    if (result._tag === "Success") {
      // The card switches to its answered row once the item updates.
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setError(resetCreditRequestFailureMessage(squashAtomCommandFailure(result)));
    }
  };

  // Same hierarchy as a chat card: what is asked, why, then the decision.
  return (
    <div
      data-v2-item-type={item.type}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-sm font-medium text-foreground">{item.label}</p>
        {item.reason.trim() ? <p className="text-sm text-muted-foreground">{item.reason}</p> : null}
      </div>
      {error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex min-w-0 items-center justify-end gap-2">
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          disabled={submitting !== null || !canAnswer}
          onClick={() => void send({ type: "decline" })}
        >
          Decline
        </Button>
        <Button
          type="button"
          size="xs"
          disabled={submitting !== null || !canAnswer}
          onClick={() => void send({ type: "approve" })}
        >
          {submitting === "approve" ? "Approving…" : "Approve reset"}
        </Button>
      </div>
    </div>
  );
}
