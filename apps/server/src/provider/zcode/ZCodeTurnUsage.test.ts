import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { TurnTokenUsage } from "@t3tools/contracts";
import { aggregateZCodeTurnUsage, readZCodeTurnUsage } from "./ZCodeTurnUsage.ts";

import { nativeUsageFixture } from "./ZCodeUsage.testkit.ts";

const decodeUsage = Schema.decodeSync(TurnTokenUsage);

describe("ZCode turn usage", () => {
  it("preserves the provider turn aggregate and cache/reasoning subsets", () => {
    const usage = readZCodeTurnUsage(
      {
        ...nativeUsageFixture,
        usage: {
          ...nativeUsageFixture.usage,
          cacheReadTokens: 20,
          cacheWriteTokens: 3,
          reasoningTokens: 2,
        },
      },
      true,
    );
    expect(decodeUsage(usage)).toEqual({
      usageScope: "main_agent",
      usageStatus: "complete",
      hasSubagents: false,
      inputTokens: 30,
      outputTokens: 7,
      totalTokens: 37,
      cachedInputTokens: 20,
      cacheCreationTokens: 3,
      reasoningTokens: 2,
    });
  });

  it.each([{}, { tokenCount: 0 }, { usage: {}, tokenCount: 0 }, { usage: null }])(
    "keeps absent provider usage unavailable: %j",
    (payload) => {
      expect(readZCodeTurnUsage(payload, true)).toEqual({
        usageScope: "main_agent",
        usageStatus: "unavailable",
        hasSubagents: false,
      });
    },
  );

  it("does not relabel a legacy combined total as output", () => {
    expect(readZCodeTurnUsage({ tokenCount: 37 }, true)).toEqual({
      usageScope: "main_agent",
      usageStatus: "partial",
      hasSubagents: false,
      totalTokens: 37,
    });
  });

  it("keeps a reported zero distinct from missing usage", () => {
    expect(
      readZCodeTurnUsage({ usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }, true),
    ).toMatchObject({ usageStatus: "complete", totalTokens: 0 });
  });

  it("keeps interrupted usage partial and never invents a missing breakdown", () => {
    expect(readZCodeTurnUsage(nativeUsageFixture, false)).toMatchObject({
      usageStatus: "partial",
      totalTokens: 37,
    });
    expect(readZCodeTurnUsage({ usage: { inputTokens: 30 } }, true)).toEqual({
      usageScope: "main_agent",
      usageStatus: "partial",
      hasSubagents: false,
      inputTokens: 30,
    });
  });

  it("rejects invalid counters and ignores cumulative session/context counters and prices", () => {
    expect(
      readZCodeTurnUsage(
        {
          tokenCount: -1,
          usage: { inputTokens: NaN, outputTokens: 1.5, totalTokens: Infinity },
          totalTokenCount: 5000,
          contextUsed: 2000,
          totalCostUsd: 10,
        },
        true,
      ),
    ).toEqual({ usageScope: "main_agent", usageStatus: "unavailable", hasSubagents: false });
  });
});

it("keeps missing goal iteration usage unknown while retaining observed totals", () => {
  const observed = readZCodeTurnUsage(nativeUsageFixture, true);
  expect(
    decodeUsage(aggregateZCodeTurnUsage([observed, readZCodeTurnUsage({}, true)])),
  ).toMatchObject({ usageStatus: "partial", inputTokens: 30, outputTokens: 7, totalTokens: 37 });
  expect(decodeUsage(aggregateZCodeTurnUsage([observed, observed]))).toMatchObject({
    usageStatus: "complete",
    inputTokens: 60,
    outputTokens: 14,
    totalTokens: 74,
  });
});
