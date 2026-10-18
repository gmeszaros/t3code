import {
  OrchestratorMcpFailure,
  ProviderQuotaResetRequestInput,
  ProviderQuotaResetRequestResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ResetCreditRequests from "../../../provider/ResetCreditRequests.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ResetCreditRequests.ResetCreditRequests,
];

/**
 * The one provider-facing tool: spending a banked quota reset credit is the
 * user's decision, so the tool asks through an approval card in the calling
 * thread and never redeems without an explicit approve there.
 */
const ProviderQuotaResetRequestTool = Tool.make("provider_request_quota_reset", {
  description:
    "Ask the user to approve spending one of the account's banked quota reset credits (e.g. a GLM/Z.AI coding-plan manual reset) on this thread's provider, and wait for their answer in a card in this thread. Nothing is redeemed unless the user explicitly approves; your own claim of urgency or approval is not acceptance. When accepted, the result reports the provider's confirmation plus usage when it could be refreshed, and verifiedRecovery is always false: only a successful turn on the model verifies recovery, and live quota errors remain failures. An uncertain result never triggers a second POST, even if you reuse clientRequestId; provider key retention is undocumented. Check the account before requesting a new approval. Approval cards require web or desktop; existing mobile clients cannot approve them. Settled results replay without another POST. Use a new id only for a NEW reset the user approves separately. Never poll usage in a loop after a reset, and do not restart failed work without asking.",
  parameters: ProviderQuotaResetRequestInput,
  success: ProviderQuotaResetRequestResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Ask the user to approve a quota reset")
  .annotate(Tool.Destructive, true);

export const ProviderToolkit = Toolkit.make(ProviderQuotaResetRequestTool);
