// Source-derived protocol fixture, not a captured account turn:
// zai-org/ZCode@aac4755666d09fdcd70272fcf063c077a639015f
// apps/zcode-cli/packages/contracts/tests/model-usage.test.ts, model requests
// (10 in, 2 out) + (20 in, 5 out); ModelUsageSummary adds the breakdown fields.
export const nativeUsageFixture = {
  resultType: "success",
  tokenCount: 37,
  usage: {
    source: "provider",
    modelRequestCount: 2,
    inputTokens: 30,
    outputTokens: 7,
    totalTokens: 37,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
  },
};
