import { sortBySavedOrder } from "@t3tools/shared/serverSettings";
import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import type {
  ModelSelection,
  ProviderInstanceId,
  ProviderOptionDescriptor,
} from "@t3tools/contracts";
import {
  buildExplicitProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

export function modelFavoriteKey(provider: ProviderInstanceId, model: string): string {
  return `${provider}:${model}`;
}

export function favoritesFirst(
  models: ReadonlyArray<ModelOption>,
  favoriteKeys: ReadonlySet<string>,
): ReadonlyArray<ModelOption> {
  const favorites: ModelOption[] = [];
  const others: ModelOption[] = [];
  for (const model of models) {
    (favoriteKeys.has(model.key) ? favorites : others).push(model);
  }
  return [...favorites, ...others];
}

/** Favorites are one cross-instance list; retain the provider label for identical model names. */
export function orderedFavoriteModels(
  groups: ReadonlyArray<ProviderGroup>,
  favoriteKeys: ReadonlySet<string>,
  query: string,
): ReadonlyArray<ModelOption> {
  return sortBySavedOrder(
    groups.flatMap((group) =>
      group.models.filter(
        (model) =>
          favoriteKeys.has(model.key) &&
          modelMatchesCatalogQuery({ model, providerLabel: group.providerLabel, query }),
      ),
    ),
    [...favoriteKeys],
    (model) => model.key,
  ).map((model) => ({
    ...model,
    subtitle: [model.providerLabel, model.subtitle].filter(Boolean).join(" - "),
  }));
}

/** Match the terms a user can actually see or recognize in the model picker. */
export function modelMatchesCatalogQuery(input: {
  readonly model: ModelOption;
  readonly providerLabel: string;
  readonly query: string;
}): boolean {
  const query = input.query.trim().toLocaleLowerCase();
  if (query.length === 0) {
    return true;
  }

  return [
    input.model.label,
    input.model.subtitle,
    input.model.selection.model,
    input.providerLabel,
  ].some((value) => value.toLocaleLowerCase().includes(query));
}

export function pendingModelAfterPress(input: {
  readonly current: ModelOption | null;
  readonly pressed: ModelOption;
  readonly pressedIsApplied: boolean;
}): ModelOption | null {
  if (input.pressedIsApplied) {
    return null;
  }
  return input.current?.key === input.pressed.key ? input.current : input.pressed;
}

export function canCommitPendingModel(
  pending: ModelOption,
  groups: ReadonlyArray<ProviderGroup>,
): boolean {
  return groups.some((group) =>
    group.models.some(
      (model) => model.key === pending.key && !model.isUnavailable && !model.isHidden,
    ),
  );
}

export function providerSectionIsCollapsed(input: {
  readonly defaultExpanded: boolean;
  readonly hasExpansionOverride: boolean;
  readonly isNarrowed: boolean;
}): boolean {
  if (input.isNarrowed) {
    return false;
  }
  return input.defaultExpanded ? input.hasExpansionOverride : !input.hasExpansionOverride;
}

// This descriptor belongs to the picker; dispatch still uses the native model slug.
export const GEMINI_REASONING_DESCRIPTOR_ID = "t3:geminiReasoning";

function geminiReasoning(model: ModelOption) {
  if (model.providerDriver !== "antigravity") return null;
  const match = /^(Gemini .+?)\s+\(?(Minimal|Low|Medium|High)\)?$/i.exec(model.label);
  return match ? { family: match[1]!, level: match[2]! } : null;
}

function geminiReasoningVariants(model: ModelOption, models: ReadonlyArray<ModelOption>) {
  const source = models.find((candidate) => candidate.key === model.key) ?? model;
  if (source.isUnavailable || source.isHidden) return [];
  const reasoning = geminiReasoning(source);
  if (!reasoning) return [];
  const variants = models.filter(
    (candidate) =>
      candidate.selection.instanceId === source.selection.instanceId &&
      !candidate.isUnavailable &&
      !candidate.isHidden &&
      geminiReasoning(candidate)?.family === reasoning.family,
  );
  // Ambiguous catalog labels must remain individually selectable.
  const levels = variants.map((variant) => geminiReasoning(variant)!.level.toLowerCase());
  return variants.length > 1 && new Set(levels).size === variants.length ? variants : [];
}

/** Collapse only the catalog view; favorites and hidden-model management retain exact variants. */
export function collapseGeminiReasoningModels(
  models: ReadonlyArray<ModelOption>,
  displayedSelection: ModelSelection | null | undefined,
  favoriteKeys: ReadonlySet<string>,
): ReadonlyArray<ModelOption> {
  const seen = new Set<string>();
  return models.flatMap((model) => {
    if (seen.has(model.key)) return [];
    const variants = geminiReasoningVariants(model, models);
    if (!variants.length) return [model];
    for (const variant of variants) seen.add(variant.key);
    const selected =
      variants.find(
        (variant) =>
          variant.selection.instanceId === displayedSelection?.instanceId &&
          variant.selection.model === displayedSelection.model,
      ) ??
      variants.find((variant) => favoriteKeys.has(variant.key)) ??
      variants.find((variant) => variant.isDefault) ??
      variants[0]!;
    return [{ ...selected, label: geminiReasoning(selected)!.family }];
  });
}

export function geminiReasoningDescriptor(
  model: ModelOption,
  models: ReadonlyArray<ModelOption>,
): ProviderOptionDescriptor | null {
  const variants = geminiReasoningVariants(model, models);
  return variants.length
    ? {
        id: GEMINI_REASONING_DESCRIPTOR_ID,
        label: "Reasoning",
        type: "select",
        currentValue: model.selection.model,
        options: variants.map((variant) => ({
          id: variant.selection.model,
          label: geminiReasoning(variant)!.level,
          isDefault: variant.isDefault,
        })),
      }
    : null;
}

export function selectGeminiReasoningModel(
  current: ModelOption,
  models: ReadonlyArray<ModelOption>,
  slug: string,
): ModelOption | null {
  const target = geminiReasoningVariants(current, models).find(
    (model) => model.selection.model === slug,
  );
  if (!target) return null;
  const options = target.capabilities
    ? buildExplicitProviderOptionSelectionsFromDescriptors(
        getProviderOptionDescriptors({
          caps: target.capabilities,
          selections: current.selection.options,
        }),
        current.selection.options,
      )
    : undefined;
  return { ...target, selection: { ...target.selection, options } };
}
