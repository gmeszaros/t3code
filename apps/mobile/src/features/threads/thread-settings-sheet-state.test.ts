import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId, type ProviderOptionSelection } from "@t3tools/contracts";

import type { ModelOption } from "../../lib/modelOptions";
import {
  canCommitPendingModel,
  collapseGeminiReasoningModels,
  geminiReasoningDescriptor,
  selectGeminiReasoningModel,
  favoritesFirst,
  orderedFavoriteModels,
  modelMatchesCatalogQuery,
  pendingModelAfterPress,
} from "./thread-settings-sheet-state";

function modelOption(
  model: string,
  options: ReadonlyArray<ProviderOptionSelection> = [],
): ModelOption {
  return {
    key: `codex:${model}`,
    label: model,
    subtitle: "",
    providerKey: "codex",
    providerLabel: "Codex",
    providerDriver: "codex",
    isDefault: false,
    isLegacy: false,
    capabilities: null,
    selection: {
      instanceId: ProviderInstanceId.make("codex"),
      model,
      options,
    },
  };
}

describe("thread settings sheet state", () => {
  it("keeps favorites in catalog order ahead of other models", () => {
    const models = [
      modelOption("first"),
      modelOption("second"),
      modelOption("third"),
      modelOption("fourth"),
    ];
    const favorites = new Set([models[2]!.key, models[0]!.key]);

    expect(favoritesFirst(models, favorites).map((model) => model.selection.model)).toEqual([
      "first",
      "third",
      "second",
      "fourth",
    ]);
    expect(models.map((model) => model.selection.model)).toEqual([
      "first",
      "second",
      "third",
      "fourth",
    ]);
  });

  it("follows saved favorite order across instances, preserving selections and provider identity", () => {
    const work = modelOption("sol");
    const personal = {
      ...work,
      key: "codex_personal:sol",
      providerKey: "codex_personal",
      providerLabel: "Personal",
      selection: { ...work.selection, instanceId: ProviderInstanceId.make("codex_personal") },
    };
    const other = modelOption("luna");
    const groups = [
      { providerKey: "codex", providerLabel: "Work", models: [work, other] },
      { providerKey: "codex_personal", providerLabel: "Personal", models: [personal] },
    ];
    const favorites = new Set([personal.key, other.key, work.key, "removed:sol"]);
    const ordered = orderedFavoriteModels(groups, favorites, "");
    expect(ordered.map((model) => model.key)).toEqual([personal.key, other.key, work.key]);
    expect(ordered[0]?.selection).toBe(personal.selection);
    expect(ordered[0]?.subtitle).toBe("Personal");
    expect(orderedFavoriteModels(groups, favorites, "personal").map((model) => model.key)).toEqual([
      personal.key,
    ]);
  });

  it("matches visible model and provider terms", () => {
    const model = modelOption("gpt-next");

    expect(modelMatchesCatalogQuery({ model, providerLabel: "Codex", query: "NEXT" })).toBe(true);
    expect(modelMatchesCatalogQuery({ model, providerLabel: "Codex", query: "codex" })).toBe(true);
    expect(modelMatchesCatalogQuery({ model, providerLabel: "Codex", query: "claude" })).toBe(
      false,
    );
  });

  it("treats whitespace-only catalog searches as empty", () => {
    expect(
      modelMatchesCatalogQuery({
        model: modelOption("gpt-next"),
        providerLabel: "Codex",
        query: "   ",
      }),
    ).toBe(true);
  });

  it("matches the upstream provider's display name", () => {
    const model = {
      ...modelOption("opencode/claude-fable-5"),
      label: "Claude Fable 5",
      subtitle: "OpenCode Zen",
    };

    expect(modelMatchesCatalogQuery({ model, providerLabel: "OpenCode", query: " ZEN " })).toBe(
      true,
    );
    expect(modelMatchesCatalogQuery({ model, providerLabel: "OpenCode", query: "copilot" })).toBe(
      false,
    );
  });

  it("clears staging when the applied model is pressed", () => {
    expect(
      pendingModelAfterPress({
        current: modelOption("gpt-next"),
        pressed: modelOption("gpt-current"),
        pressedIsApplied: true,
      }),
    ).toBeNull();
  });

  it("preserves staged options when the highlighted model is pressed again", () => {
    const pending = modelOption("gpt-next", [{ id: "effort", value: "high" }]);

    expect(
      pendingModelAfterPress({
        current: pending,
        pressed: modelOption("gpt-next"),
        pressedIsApplied: false,
      }),
    ).toBe(pending);
  });

  it("stages a different model", () => {
    const pressed = modelOption("gpt-other");

    expect(
      pendingModelAfterPress({
        current: modelOption("gpt-next"),
        pressed,
        pressedIsApplied: false,
      }),
    ).toBe(pressed);
  });

  it("cannot select a hidden model exposed only for visibility management", () => {
    const pending = modelOption("gpt-next");
    expect(
      canCommitPendingModel(pending, [
        { providerKey: "codex", providerLabel: "Codex", models: [{ ...pending, isHidden: true }] },
      ]),
    ).toBe(false);
  });

  it("cannot save a staged model after sign-out removes it from the catalog", () => {
    const pending = modelOption("gemini-native");
    const group = { providerKey: "codex", providerLabel: "Codex", models: [pending] };

    expect(canCommitPendingModel(pending, [group])).toBe(true);
    expect(canCommitPendingModel(pending, [])).toBe(false);
    expect(
      canCommitPendingModel(pending, [
        {
          ...group,
          models: [{ ...pending, isUnavailable: true }],
        },
      ]),
    ).toBe(false);
  });
});

describe("Gemini reasoning in the mobile picker", () => {
  const gemini = (slug: string, level: string, instance = "google"): ModelOption => ({
    ...modelOption(slug),
    key: `${instance}:${slug}`,
    label: `Gemini 3.1 Pro (${level})`,
    providerKey: instance,
    providerDriver: "antigravity",
    selection: { instanceId: ProviderInstanceId.make(instance), model: slug },
  });
  const high = { ...gemini("gemini-pro-agent", "High"), isDefault: true };
  const low = gemini("gemini-3.1-pro-low", "Low");

  it("shows one base model while retaining an applied non-default native slug", () => {
    const catalog = [high, low, modelOption("gpt-next")];
    const collapsed = collapseGeminiReasoningModels(catalog, low.selection, new Set());
    expect(collapsed.map((model) => model.label)).toEqual(["Gemini 3.1 Pro", "gpt-next"]);
    expect(collapsed[0]?.selection).toBe(low.selection);
    expect(catalog).toEqual([high, low, modelOption("gpt-next")]);
    expect(collapseGeminiReasoningModels(catalog, null, new Set())[0]?.selection).toBe(
      high.selection,
    );
    expect(geminiReasoningDescriptor(collapsed[0]!, catalog)).toMatchObject({
      label: "Reasoning",
      currentValue: low.selection.model,
      options: [
        { id: high.selection.model, label: "High" },
        { id: low.selection.model, label: "Low" },
      ],
    });
  });

  it("keeps provider instances separate and supports labels without parentheses", () => {
    const personalHigh = gemini("gemini-pro-agent", "High", "personal");
    const personalLow = {
      ...gemini("gemini-3.1-pro-low", "Low", "personal"),
      label: "Gemini 3.1 Pro Low",
    };
    const models = [high, low, personalHigh, personalLow];
    expect(
      collapseGeminiReasoningModels(models, personalLow.selection, new Set()).map(
        (model) => model.key,
      ),
    ).toEqual([high.key, personalLow.key]);
    expect(
      selectGeminiReasoningModel(high, [high, personalLow], personalLow.selection.model),
    ).toBeNull();
  });

  it("does not combine unrelated, single, ambiguous or unavailable models", () => {
    const otherProvider = { ...low, providerDriver: "opencode" };
    expect(collapseGeminiReasoningModels([high, otherProvider], null, new Set())).toEqual([
      high,
      otherProvider,
    ]);
    const duplicate = {
      ...high,
      key: "google:duplicate",
      selection: { ...high.selection, model: "duplicate" },
    };
    const ambiguous = [high, duplicate, low];
    expect(collapseGeminiReasoningModels(ambiguous, null, new Set())).toEqual(ambiguous);
    const unavailable = { ...low, isUnavailable: true };
    expect(geminiReasoningDescriptor(high, [high, unavailable])).toBeNull();
    expect(selectGeminiReasoningModel(high, [high, unavailable], low.selection.model)).toBeNull();
    expect(geminiReasoningDescriptor(high, [high])).toBeNull();
  });

  it("switches the native model, preserving only supported native options", () => {
    const capability = {
      optionDescriptors: [
        {
          id: "nativeMode",
          label: "Native mode",
          type: "select" as const,
          options: [{ id: "safe", label: "Safe" }],
          currentValue: "safe",
        },
      ],
    };
    const current = {
      ...high,
      selection: {
        ...high.selection,
        options: [
          { id: "nativeMode", value: "safe" },
          { id: "removed", value: "old" },
        ],
      },
    };
    const target = { ...low, capabilities: capability };
    const next = selectGeminiReasoningModel(current, [high, target], low.selection.model)!;
    expect(next.selection).toEqual({
      ...low.selection,
      options: [{ id: "nativeMode", value: "safe" }],
    });
    expect(next.key).toBe(low.key);
    expect(
      selectGeminiReasoningModel(current, [high, low], low.selection.model)?.selection.options,
    ).toBeUndefined();
    expect(selectGeminiReasoningModel(current, [high, low], "invented-model")).toBeNull();
    expect(
      canCommitPendingModel(next, [
        { providerKey: "google", providerLabel: "Google", models: [high] },
      ]),
    ).toBe(false);
  });

  it("keeps exact favorite variants and hidden model controls available", () => {
    const models = [high, low];
    const groups = [{ providerKey: "google", providerLabel: "Google", models }];
    const favorites = new Set([low.key, high.key]);
    expect(orderedFavoriteModels(groups, favorites, "").map((model) => model.key)).toEqual([
      low.key,
      high.key,
    ]);
    const hidden = { ...low, isHidden: true };
    expect(collapseGeminiReasoningModels([high, hidden], null, favorites)).toEqual([high, hidden]);
  });
});
