import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export class ProviderDriverError extends Schema.TaggedError<ProviderDriverError>()(
  "ProviderDriverError",
  {
    driver: ProviderDriverKind,
    instanceId: ProviderInstanceId,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    /**
     * Set only when the error came from a reset-credit redemption.
     * `refused` means the reset was not applied with evidence: the provider
     * answered and rejected it, or the operation never reached the provider.
     * `unconfirmed` means the operation may have been applied but the answer
     * was lost; callers must not claim either way. Absent for errors outside
     * a redemption, which callers treat as unconfirmed.
     */
    redemption: Schema.optional(Schema.Literals(["refused", "unconfirmed"])),
  },
) {
  override get message(): string {
    return `Provider driver '${this.driver}' failed to create instance '${this.instanceId}': ${this.detail}`;
  }
}

export class ProviderCredentialError extends Schema.TaggedError<ProviderCredentialError>()(
  "ProviderCredentialError",
  {
    operation: Schema.Literals(["get", "set", "remove"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not ${this.operation} stored provider credentials.`;
  }
}
