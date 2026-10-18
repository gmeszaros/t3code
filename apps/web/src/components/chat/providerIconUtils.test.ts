import { describe, expect, it } from "vite-plus/test";

import {
  getDisplayModelName,
  getProviderInstanceLabel,
  getProviderRowLabel,
} from "./providerIconUtils";

describe("getProviderInstanceLabel", () => {
  it("distinguishes the configured account label from its harness", () => {
    expect(getProviderInstanceLabel("GLM Coding Plan", "OpenCode")).toBe(
      "GLM Coding Plan (OpenCode)",
    );
    expect(getProviderInstanceLabel("Personal", "ZCode")).toBe("Personal (ZCode)");
  });

  it("preserves names that already identify their harness", () => {
    expect(getProviderInstanceLabel("OpenCode", "OpenCode")).toBe("OpenCode");
    expect(getProviderInstanceLabel("ZCode Personal", "ZCode")).toBe("ZCode Personal");
    expect(getProviderInstanceLabel("opencode work", "OpenCode")).toBe("opencode work");
  });
});

describe("getProviderRowLabel", () => {
  it("shows a sub-provider named after its provider on its own", () => {
    expect(getProviderRowLabel("OpenCode", "OpenCode Zen")).toBe("OpenCode Zen");
    expect(getProviderRowLabel("OpenCode", "OpenCode Go")).toBe("OpenCode Go");
  });

  it("keeps a provider id that merely starts like the provider name", () => {
    expect(getProviderRowLabel("OpenCode", "opencode-go")).toBe("OpenCode · opencode-go");
  });

  it("joins a sub-provider that names something else", () => {
    expect(getProviderRowLabel("OpenCode", "GitHub Copilot")).toBe("OpenCode · GitHub Copilot");
  });

  it("keeps the provider name when a model has no sub-provider", () => {
    expect(getProviderRowLabel("Claude", undefined)).toBe("Claude");
  });
});

describe("getDisplayModelName", () => {
  it("drops a leading sub-provider qualifier from the model name", () => {
    expect(
      getDisplayModelName({
        slug: "a/b",
        name: "OpenCode Zen: Step 5",
        subProvider: "OpenCode Zen",
      }),
    ).toBe("Step 5");
  });
});
