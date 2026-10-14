import type { OrchestrationV2AutomaticContinuation } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export function providerFailureContinuationText(
  continuation: OrchestrationV2AutomaticContinuation | null | undefined,
): string | null {
  switch (continuation?.status) {
    case "scheduled":
      return `Automatic continuation scheduled for ${DateTime.toDateUtc(continuation.dueAt).toLocaleTimeString()}. Sending a message or stopping cancels it.`;
    case "retrying":
      return "Automatic continuation in progress (1 of 1).";
    case "exhausted":
      return "Automatic continuation failed. No further automatic attempts will run.";
    case "cancelled":
      return "Automatic continuation cancelled.";
    default:
      return null;
  }
}
