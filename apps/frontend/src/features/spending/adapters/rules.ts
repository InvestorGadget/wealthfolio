import { invoke, logger } from "#platform";
import type {
  ActivityRuleExplanation,
  CategorizationRule,
  ImportPresetResult,
  NewCategorizationRule,
  RemovePresetResult,
  RulePresetSummary,
} from "../types/rule";

export type { ImportPresetResult, RemovePresetResult, RulePresetSummary } from "../types/rule";

export {
  listCategorizationRules,
  createCategorizationRule,
  updateCategorizationRule,
  deleteCategorizationRule,
  rerunCategorizationRules,
  rerunCategorizationRulesDetailed,
  previewCategorizationRulesRerun,
} from "../../../adapters/shared/spending";

export const listRulePresets = async (): Promise<RulePresetSummary[]> => {
  try {
    return await invoke<RulePresetSummary[]>("list_rule_presets");
  } catch (e) {
    logger.error("Error listing rule presets.");
    throw e;
  }
};

export const importRulePreset = async (presetId: string): Promise<ImportPresetResult> => {
  try {
    return await invoke<ImportPresetResult>("import_rule_preset", { presetId });
  } catch (e) {
    logger.error("Error importing rule preset.");
    throw e;
  }
};

export const removeRulePreset = async (presetId: string): Promise<RemovePresetResult> => {
  try {
    return await invoke<RemovePresetResult>("remove_rule_preset", { presetId });
  } catch (e) {
    logger.error("Error removing rule preset.");
    throw e;
  }
};

/**
 * The rules that apply to these transactions, as a rule run matches them.
 * Read-only; transactions outside Spending are left out.
 */
export const explainActivityRules = async (
  activityIds: string[],
): Promise<ActivityRuleExplanation[]> => {
  try {
    return await invoke<ActivityRuleExplanation[]>("explain_activity_rules", { activityIds });
  } catch (e) {
    logger.error("Error explaining categorization rules.");
    throw e;
  }
};

/**
 * Saves a rule without running it. Saving a rule normally files the
 * uncategorized transactions it matches straight away, in the background;
 * `deferApply` leaves that to the caller, which asks the user first and then
 * runs the rules itself. `id` saves over that rule; without one a rule is
 * created.
 */
export const saveRuleWithoutApplying = async (
  rule: NewCategorizationRule,
  id?: string,
): Promise<CategorizationRule> => {
  try {
    return id
      ? await invoke<CategorizationRule>("update_categorization_rule", {
          id,
          patch: rule,
          deferApply: true,
        })
      : await invoke<CategorizationRule>("create_categorization_rule", {
          rule,
          deferApply: true,
        });
  } catch (e) {
    logger.error("Error saving categorization rule.");
    throw e;
  }
};
