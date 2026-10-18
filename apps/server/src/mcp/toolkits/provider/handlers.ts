import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ProviderToolkit } from "./tools.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ResetCreditRequests from "../../../provider/ResetCreditRequests.ts";

export const layer = McpToolAccess.toLayer(ProviderToolkit, {
  provider_request_quota_reset: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      if (!scope.capabilities.has("orchestration"))
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "This credential cannot request quota resets.",
        });
      const service = yield* ResetCreditRequests.ResetCreditRequests;
      const thread = yield* McpInvocationContext.requireThreadScope(
        scope,
        "provider_request_quota_reset",
      );
      return yield* service
        .request({
          requestNamespace: scope.requestNamespace,
          threadId: thread.thread.threadId,
          providerInstanceId: thread.thread.providerInstanceId,
          input,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "parent_not_active", message: error.message }),
          ),
        );
    }),
  ),
});
