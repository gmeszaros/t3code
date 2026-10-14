import { ComputerAction as ComputerActionSchema, ComputerInspection } from "@t3tools/contracts";
import { ComputerFailureReason } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
export const ComputerGrantSchema = Schema.Struct({
  owner: Identifier,
  processId: Schema.Int.check(Schema.isGreaterThan(0)),
  application: Identifier,
  expiresAt: Schema.Finite,
  readOnly: Schema.Boolean,
});

export const ComputerWorkerRequest = Schema.Union([
  Schema.Struct({ id: Identifier, kind: Schema.Literal("resolve"), application: Identifier }),
  Schema.Struct({ id: Identifier, kind: Schema.Literal("init"), grant: ComputerGrantSchema }),
  Schema.Struct({ id: Identifier, kind: Schema.Literal("inspect"), owner: Identifier }),
  Schema.Struct({
    id: Identifier,
    kind: Schema.Literal("act"),
    owner: Identifier,
    snapshotId: Identifier,
    action: ComputerActionSchema,
  }),
]);

export { ComputerInspection } from "@t3tools/contracts";

export const ComputerApplicationIdentity = Schema.Struct({
  processId: Schema.Int.check(Schema.isGreaterThan(0)),
  application: Identifier,
});

export const ComputerWorkerResponse = Schema.Union([
  Schema.Struct({ ready: Schema.Literal(true) }),
  Schema.Struct({
    id: Identifier,
    ok: Schema.Boolean,
    reason: Schema.optional(ComputerFailureReason),
    result: Schema.optional(Schema.Union([ComputerInspection, ComputerApplicationIdentity])),
  }),
]);
