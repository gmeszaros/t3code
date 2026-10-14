// Effect's Crypto has no synchronous createHash.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHash.
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  MessageId,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRetry,
  type ProviderInstanceId,
  type RunId,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ThreadManagementService from "./ThreadManagementService.ts";

/** Unknown failures and explicit permanent/native-retry evidence fail closed. */
export function isTransientTerminalFailure(
  failure: OrchestrationV2ProviderFailure,
  retry?: OrchestrationV2ProviderRetry,
): boolean {
  if (
    failure.retryable === false ||
    (retry !== undefined && (retry.maxAttempts === null || retry.attempt < retry.maxAttempts))
  )
    return false;
  if (failure.class !== "provider_error" && failure.class !== "transport_error") return false;
  const evidence = `${failure.code ?? ""} ${failure.message}`.toLowerCase();
  if (
    /auth|credential|unauthorized|forbidden|quota|billing|credit|payment|invalid|unsupported|not found|permission|approval|denied|cancel|interrupt|out of memory|oom_kill/.test(
      evidence,
    )
  )
    return false;
  return (
    /selected model is at capacity|overloaded|service unavailable|temporarily unavailable/.test(
      evidence,
    ) ||
    /^(?:capacity|overloaded|server_overloaded|service_unavailable|internal_server_error|502|503|504|econnreset|econnrefused|etimedout)$/i.test(
      failure.code ?? "",
    ) ||
    (failure.class === "transport_error" &&
      failure.retryable === true &&
      /connection reset|connection refused|timed? out|network error|socket closed/.test(evidence))
  );
}

/**
 * Fail closed when settings change while waiting, including account config
 * and project overrides. Only a digest is persisted because settings can
 * contain private values. Thread selection and modes are checked separately.
 */
export function continuationConfigurationFingerprint(
  settings: ServerSettings,
  instanceId: ProviderInstanceId,
): string {
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify({ settings, instanceId }))
    .digest("hex");
}

export const continueFailedRun = Effect.fn("ProviderFailureContinuation.continueFailedRun")(
  function* (input: { readonly threadId: ThreadId; readonly sourceRunId: RunId }) {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    // All eligibility checks happen inside message.dispatch's orchestration lock.
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`command:failure-continuation:${input.sourceRunId}`),
      threadId: input.threadId,
      messageId: MessageId.make(`message:failure-continuation:${input.sourceRunId}`),
      text: "continue",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "server",
      failureContinuationOfRunId: input.sourceRunId,
    });
    yield* threads.recoverDelegatedTask(input.threadId, input.sourceRunId);
  },
);
