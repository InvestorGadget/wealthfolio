export type RuleMatchType = "contains" | "starts_with" | "exact" | "regex";

/** Decisions from the existing rule writer, including matches that could not be applied. */
export interface CategorizationRunSummary {
  matched: number;
  eligible: number;
  changed: number;
  protectedSplits: number;
  protectedManual: number;
  skippedExisting: number;
  unchanged: number;
  incompatible: number;
  withoutTarget: number;
}

/** Amount condition operator. Compares against the activity's unsigned amount. */
export type RuleAmountOp = "eq" | "gt" | "gte" | "lt" | "lte" | "between";

export interface CategorizationRule {
  id: string;
  name: string;
  pattern: string;
  matchType: RuleMatchType;
  taxonomyId?: string | null;
  categoryId?: string | null;
  activityType?: string | null;
  /** Optional amount condition; amountValue2 is the upper bound for "between". */
  amountOp?: RuleAmountOp | null;
  amountValue?: number | null;
  amountValue2?: number | null;
  /** The rule only matches transactions filed under this payee. */
  payeeConditionId?: string | null;
  /** A payee a category rule also sets, beside its category. */
  setPayeeId?: string | null;
  priority: number;
  isGlobal: boolean;
  accountId?: string | null;
  /** Preset provenance — NULL/undefined for user-created rules. */
  presetId?: string | null;
  presetRuleKey?: string | null;
  presetVersion?: string | null;
  /** True when the user has edited a preset-sourced rule. */
  presetModified?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NewCategorizationRule {
  id?: string | null;
  name: string;
  pattern: string;
  matchType?: RuleMatchType;
  taxonomyId?: string | null;
  categoryId?: string | null;
  activityType?: string | null;
  amountOp?: RuleAmountOp | null;
  amountValue?: number | null;
  amountValue2?: number | null;
  payeeConditionId?: string | null;
  setPayeeId?: string | null;
  priority?: number;
  isGlobal?: boolean;
  accountId?: string | null;
  presetId?: string | null;
  presetRuleKey?: string | null;
  presetVersion?: string | null;
}

export interface UpdateCategorizationRule {
  name?: string;
  pattern?: string;
  matchType?: RuleMatchType;
  taxonomyId?: string | null;
  categoryId?: string | null;
  activityType?: string | null;
  /** Explicit null clears the amount condition. */
  amountOp?: RuleAmountOp | null;
  amountValue?: number | null;
  amountValue2?: number | null;
  /** Omitted keeps the stored payee; an explicit null clears it. */
  payeeConditionId?: string | null;
  setPayeeId?: string | null;
  priority?: number;
  isGlobal?: boolean;
  accountId?: string | null;
}

export interface RulePresetSummary {
  presetId: string;
  presetVersion: string;
  name: string;
  description?: string | null;
  language?: string | null;
  ruleCount: number;
  installed: boolean;
  installedVersion?: string | null;
}

export interface ImportPresetResult {
  presetId: string;
  presetVersion: string;
  added: number;
  updated: number;
  skippedExisting: number;
  skippedUnknownCategory: number;
  total: number;
}

export interface RemovePresetResult {
  presetId: string;
  removed: number;
  keptModified: number;
}

/** A rule that applies to a transaction, and what it sets there. */
export interface AppliedRule {
  rule: CategorizationRule;
  taxonomyId: string;
  categoryId: string;
}

/**
 * What a full rule run makes of one transaction, whatever is on file for it.
 * Mirrors `ActivityRuleExplanation` in `wealthfolio_spending`.
 */
export interface ActivityRuleExplanation {
  activityId: string;
  /** The text rules match: the bank's description, else the notes. */
  bankText?: string | null;
  /** The payee the transaction is filed under now. */
  payeeId?: string | null;
  /** The rule a run takes the transaction's payee from. */
  payeeRule?: AppliedRule | null;
  /** The rule a run takes the transaction's category from. */
  categoryRule?: AppliedRule | null;
}
