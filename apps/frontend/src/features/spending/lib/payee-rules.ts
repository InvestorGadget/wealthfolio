import type { CategorizationRule, RuleMatchType } from "../types/rule";
import { PAYEES_TAXONOMY_ID } from "./payee";
import { getBankText } from "./bank-text";
import {
  compileAnyOfPattern,
  hasTextCondition,
  MAX_REGEX_PATTERN_LENGTH,
  parseAnyOfPattern,
} from "./rule-conditions";

type RulePayeeFields = Pick<
  CategorizationRule,
  "taxonomyId" | "categoryId" | "payeeConditionId" | "setPayeeId"
>;

/**
 * Whether the rule names the payee: as its target, as the payee it matches
 * on, or as the payee it also sets. These are the places a payee merge moves
 * and a payee's delete is refused for.
 */
export function ruleNamesPayee(rule: RulePayeeFields, payeeId: string): boolean {
  return (
    (rule.taxonomyId === PAYEES_TAXONOMY_ID && rule.categoryId === payeeId) ||
    rule.payeeConditionId === payeeId ||
    rule.setPayeeId === payeeId
  );
}

/** How many rules name each payee, by payee id. A rule counts once per payee. */
export function countRulesByPayee(rules: RulePayeeFields[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const rule of rules) {
    const named = new Set<string>();
    if (rule.taxonomyId === PAYEES_TAXONOMY_ID && rule.categoryId) named.add(rule.categoryId);
    if (rule.payeeConditionId) named.add(rule.payeeConditionId);
    if (rule.setPayeeId) named.add(rule.setPayeeId);
    for (const payeeId of named) counts.set(payeeId, (counts.get(payeeId) ?? 0) + 1);
  }
  return counts;
}

export const RULES_PAGE_PATH = "/settings/spending/rules";
/** The rules page's search parameter that narrows it to one payee's rules. */
export const RULES_PAYEE_PARAM = "payee";

/** The rules page showing only the rules that name the payee. */
export const rulesForPayeePath = (payeeId: string): string =>
  `${RULES_PAGE_PATH}?${RULES_PAYEE_PARAM}=${encodeURIComponent(payeeId)}`;

/** What a new rule's form starts from, when something else proposes the rule. */
export interface RuleDraft {
  name?: string;
  pattern?: string;
  matchType?: RuleMatchType;
  taxonomyId?: string;
  categoryId?: string;
  payeeConditionId?: string;
}

/** Router state that opens the rules page on a new rule started from `ruleDraft`. */
export interface RulesPageState {
  ruleDraft?: RuleDraft;
}

/** A new rule that matches on the payee, its target left for the user to pick. */
export const payeeConditionDraft = (payee: { id: string; name: string }): RuleDraft => ({
  name: payee.name,
  payeeConditionId: payee.id,
});

/** How many bank texts a merge's rule lists at most: the most frequent ones. */
export const MAX_MERGE_RULE_TEXTS = 20;

interface BankTextSource {
  importedDescription?: string | null;
  notes?: string | null;
}

export interface BankTextSummary {
  /** The texts a rule can list, most frequent first. */
  texts: string[];
  /** How many distinct texts a rule could list if it had room for them all. */
  distinct: number;
}

export const NO_BANK_TEXTS: BankTextSummary = { texts: [], distinct: 0 };

const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

/**
 * The distinct bank texts of some transactions, compared the way rules match
 * them (ignoring case), most frequent first. Each keeps the spelling it was
 * first seen with.
 *
 * `texts` is what one "matches any of" rule can hold: at most
 * `MAX_MERGE_RULE_TEXTS`, and only as many as fit the stored pattern's length
 * limit. A text the list form cannot hold as one whole text (it spans lines,
 * or begins or ends with a space) is left out of both `texts` and `distinct`.
 */
export function summarizeBankTexts(activities: BankTextSource[]): BankTextSummary {
  const seen = new Map<string, { text: string; count: number }>();
  for (const activity of activities) {
    const text = getBankText(activity);
    if (!text || text !== text.trim() || text.includes("\n")) continue;
    const key = text.toUpperCase();
    const entry = seen.get(key);
    if (entry) entry.count += 1;
    else seen.set(key, { text, count: 1 });
  }
  // Map order is first-seen order and the sort is stable, so ties keep it.
  const ranked = [...seen.values()].sort((a, b) => b.count - a.count);
  const texts: string[] = [];
  for (const { text } of ranked) {
    if (texts.length === MAX_MERGE_RULE_TEXTS) break;
    const pattern = compileAnyOfPattern({ mode: "exact", items: [...texts, text] });
    if (utf8Length(pattern) <= MAX_REGEX_PATTERN_LENGTH) texts.push(text);
  }
  return { texts, distinct: ranked.length };
}

/**
 * Whether the rule's text condition holds for `text`, as the rule matcher
 * decides it: both sides uppercased, the pattern as stored (untrimmed). A
 * regex is only weighed when it is a "matches any of" list; any other regex
 * counts as not matching, which at worst offers a rule that was not needed.
 */
function ruleTextMatches(rule: CategorizationRule, text: string): boolean {
  if (!hasTextCondition(rule)) return false;
  const haystack = text.toUpperCase();
  const pattern = rule.pattern.toUpperCase();
  switch (rule.matchType) {
    case "contains":
      return haystack.includes(pattern);
    case "starts_with":
      return haystack.startsWith(pattern);
    case "exact":
      return haystack === pattern;
    case "regex": {
      const list = parseAnyOfPattern(rule.pattern);
      if (!list) return false;
      return list.items.some((item) =>
        list.mode === "exact"
          ? haystack === item.toUpperCase()
          : haystack.includes(item.toUpperCase()),
      );
    }
  }
}

/**
 * Whether existing rules already file every one of `texts` under the payee:
 * for each text, a rule that matches it and sets the payee, as its target or
 * beside its category. A rule narrowed by account, type or amount does not
 * count, since it only covers some transactions; priorities between rules
 * are not weighed.
 */
export function payeeRuleCoversTexts(
  rules: CategorizationRule[],
  payeeId: string,
  texts: string[],
): boolean {
  const setters = rules.filter((rule) => {
    const sets = rule.taxonomyId === PAYEES_TAXONOMY_ID ? rule.categoryId : rule.setPayeeId;
    if (sets !== payeeId) return false;
    // A rule that matches on a payee cannot set one.
    return rule.isGlobal && !rule.activityType && !rule.amountOp && !rule.payeeConditionId;
  });
  return texts.every((text) => setters.some((rule) => ruleTextMatches(rule, text)));
}

/** The rule a merge offers: these texts, as whole texts, filed under the destination payee. */
export function mergeRuleDraft(
  texts: string[],
  destination: { id: string; name: string },
): RuleDraft {
  return {
    name: destination.name,
    pattern: compileAnyOfPattern({ mode: "exact", items: texts }),
    matchType: "regex",
    taxonomyId: PAYEES_TAXONOMY_ID,
    categoryId: destination.id,
  };
}
