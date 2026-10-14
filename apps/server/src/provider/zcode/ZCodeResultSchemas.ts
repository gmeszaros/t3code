import * as Schema from "effect/Schema";

import * as ZCodeSchema from "./ZCodeWireSchema.ts";

/**
 * Response payloads that arrive as bare JSON objects. They live in their own
 * module because tsgo (7.0.2+effect-tsgo) intermittently drops exports with
 * these names from the wire-schema module's symbol table when other files
 * reference them.
 */

export const RuntimeCapabilitiesResult = Schema.Struct({
  independentPlanState: Schema.optional(Schema.Boolean),
});
export type RuntimeCapabilitiesResult = typeof RuntimeCapabilitiesResult.Type;

export const SessionResumeResult = ZCodeSchema.SessionCreateResult;
export type SessionResumeResult = typeof SessionResumeResult.Type;

export const SessionGoalResult = Schema.Struct({
  response: Schema.String,
  snapshot: ZCodeSchema.SessionSnapshot,
  // The bridge needs the explicit control-only vs running acknowledgement.
  // Never infer completion from an older runtime omitting this field.
  startedTurn: Schema.Boolean,
});
export type SessionGoalResult = typeof SessionGoalResult.Type;

export const SessionStopResult = Schema.Struct({});
export type SessionStopResult = typeof SessionStopResult.Type;

export const SessionSetModelResult = Schema.Struct({});
export type SessionSetModelResult = typeof SessionSetModelResult.Type;

export const SessionSetModeResult = Schema.Struct({});
export type SessionSetModeResult = typeof SessionSetModeResult.Type;
