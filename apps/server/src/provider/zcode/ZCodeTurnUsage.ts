import type { TurnTokenUsage } from "@t3tools/contracts";

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export function aggregateZCodeTurnUsage(iterations: ReadonlyArray<TurnTokenUsage>): TurnTokenUsage {
  const totals: Record<string, number> = {};
  for (const iteration of iterations) {
    for (const field of [
      "inputTokens",
      "outputTokens",
      "totalTokens",
      "cachedInputTokens",
      "cacheCreationTokens",
      "reasoningTokens",
    ] as const) {
      const value = iteration[field];
      if (value !== undefined) totals[field] = (totals[field] ?? 0) + value;
    }
  }
  const fields = {
    usageScope: "main_agent",
    hasSubagents: false,
    ...totals,
  } as const;
  return iterations.length > 0 && iterations.every((item) => item.usageStatus === "complete")
    ? {
        ...fields,
        usageStatus: "complete",
        inputTokens: totals.inputTokens!,
        outputTokens: totals.outputTokens!,
      }
    : { ...fields, usageStatus: Object.keys(totals).length > 0 ? "partial" : "unavailable" };
}

/**
 * ZCode's turn.completed usage is already a turn aggregate, not a delta or a
 * session cumulative counter. Cache/reasoning counts are subsets of input/output.
 * Source: zai-org/ZCode@aac4755666d09fdcd70272fcf063c077a639015f,
 * apps/zcode-cli/packages/contracts/src/model/index.ts (ModelUsageSummary),
 * core/src/runtime/methods/turn.ts and bootstrap/src/zcode-protocol/session-mapper.ts.
 */
export function readZCodeTurnUsage(
  payload: Readonly<Record<string, unknown>>,
  completed: boolean,
): TurnTokenUsage {
  const raw = payload.usage;
  const usage =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const inputTokens = count(usage.inputTokens);
  const outputTokens = count(usage.outputTokens);
  // tokenCount is input + output, and the vendor emits 0 when usage is absent.
  // A positive legacy total is useful, but cannot establish either breakdown.
  const legacyTotal = count(payload.tokenCount);
  const totalTokens =
    count(usage.totalTokens) ??
    (inputTokens !== undefined && outputTokens !== undefined
      ? count(inputTokens + outputTokens)
      : legacyTotal !== undefined && legacyTotal > 0
        ? legacyTotal
        : undefined);
  const cachedInputTokens = count(usage.cacheReadTokens);
  const cacheCreationTokens = count(usage.cacheWriteTokens);
  const reasoningTokens = count(usage.reasoningTokens);
  const observed = [
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    cacheCreationTokens,
    reasoningTokens,
  ].some((value) => value !== undefined);

  const fields = {
    usageScope: "main_agent" as const,
    hasSubagents: false,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cachedInputTokens !== undefined
      ? {
          cachedInputTokens:
            inputTokens === undefined
              ? cachedInputTokens
              : Math.min(inputTokens, cachedInputTokens),
        }
      : {}),
    ...(cacheCreationTokens !== undefined
      ? {
          cacheCreationTokens:
            inputTokens === undefined
              ? cacheCreationTokens
              : Math.min(inputTokens, cacheCreationTokens),
        }
      : {}),
    ...(reasoningTokens !== undefined
      ? {
          reasoningTokens:
            outputTokens === undefined ? reasoningTokens : Math.min(outputTokens, reasoningTokens),
        }
      : {}),
  };
  return completed && inputTokens !== undefined && outputTokens !== undefined
    ? { ...fields, usageStatus: "complete", inputTokens, outputTokens }
    : { ...fields, usageStatus: observed ? "partial" : "unavailable" };
}
