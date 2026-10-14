import type { ComputerFailureReason } from "@t3tools/contracts";

export class ComputerError extends Error {
  readonly reason: ComputerFailureReason;
  constructor(reason: ComputerFailureReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** Native exception messages can contain window text; only known categories cross IPC. */
export function computerFailureReason(error: unknown): ComputerFailureReason {
  if (error instanceof ComputerError) return error.reason;
  switch (error instanceof Error ? error.name : "") {
    case "PermissionDeniedError":
    case "AccessibilityNotEnabledError":
      return "permissions";
    case "PlatformError":
      return "native-platform";
    case "TimeoutError":
      return "native-timeout";
    case "ActionNotSupportedError":
      return "unsupported";
    default:
      return "worker-failed";
  }
}
