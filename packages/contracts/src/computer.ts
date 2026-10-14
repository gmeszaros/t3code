import * as Schema from "effect/Schema";

const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const ElementIndex = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThan(400));

export const ComputerAction = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["press", "scrollIntoView"]), element: ElementIndex }),
  Schema.Struct({
    kind: Schema.Literal("fill"),
    element: ElementIndex,
    text: Schema.String.check(Schema.isMaxLength(16_000)),
  }),
]);
export type ComputerAction = typeof ComputerAction.Type;

export const ComputerInspection = Schema.Struct({
  snapshotId: Identifier,
  application: Identifier,
  elements: Schema.Array(
    Schema.Struct({
      role: Schema.String.check(Schema.isMaxLength(100)),
      name: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
      value: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
      actions: Schema.Array(Schema.Literals(["press", "fill", "scrollIntoView"])),
    }),
  ).check(Schema.isMaxLength(400)),
  truncated: Schema.Boolean,
  image: Schema.optional(
    Schema.Struct({
      data: Schema.String.check(Schema.isMaxLength(6_666_668)),
      mimeType: Schema.Literal("image/png"),
    }),
  ),
});
export type ComputerInspection = typeof ComputerInspection.Type;

/** Filled by the authenticated server, never decoded from MCP tool arguments. */
export const ComputerInvocation = Schema.Struct({
  owner: Identifier,
  threadTitle: Schema.String.check(Schema.isMaxLength(200)),
  readOnly: Schema.Boolean,
});

export const ComputerDesktopRequest = Schema.Struct({
  id: Identifier,
  invocation: ComputerInvocation,
  command: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("requestAccess"), application: Identifier }),
    Schema.Struct({ kind: Schema.Literal("inspect") }),
    Schema.Struct({ kind: Schema.Literal("status") }),
    Schema.Struct({
      kind: Schema.Literal("act"),
      snapshotId: Identifier,
      action: ComputerAction,
    }),
    Schema.Struct({ kind: Schema.Literal("stop") }),
  ]),
});
export type ComputerDesktopRequest = typeof ComputerDesktopRequest.Type;

export const ComputerFailureReason = Schema.Literals([
  "denied",
  "stopped",
  "permissions",
  "focus-changed",
  "focus-before-capture-process",
  "focus-before-capture-name",
  "focus-after-capture-process",
  "focus-after-capture-name",
  "focus-before-action-process",
  "focus-before-action-name",

  "window-changed",
  "snapshot-unavailable",
  "read-only",
  "worker-failed",
  "unsupported",
  "native-platform",
  "native-timeout",
]);
export type ComputerFailureReason = typeof ComputerFailureReason.Type;

export const ComputerDesktopResponse = Schema.Struct({
  id: Identifier,
  result: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("pending"), application: Identifier }),
    Schema.Struct({
      kind: Schema.Literal("granted"),
      application: Identifier,
      readOnly: Schema.Boolean,
      expiresAt: Schema.Finite,
    }),
    Schema.Struct({ kind: Schema.Literal("snapshot"), snapshot: ComputerInspection }),
    Schema.Struct({ kind: Schema.Literal("completed") }),
    Schema.Struct({
      kind: Schema.Literal("unavailable"),
      reason: ComputerFailureReason,
    }),
  ]),
});
export type ComputerDesktopResponse = typeof ComputerDesktopResponse.Type;
