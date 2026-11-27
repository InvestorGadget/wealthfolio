import type { ActivityRuleExplanation, AppliedRule, RuleDraft, RuleMatchType } from "../types/rule";
import { PAYEES_TAXONOMY_ID } from "./payee";
import { MAX_REGEX_PATTERN_LENGTH } from "./rule-conditions";

/** What the user has just filed a transaction, or several, under by hand. */
export interface ManualEdit {
  /** The category they set. Left out when the edit did not set one. */
  category?: { taxonomyId: string; categoryId: string };
  /** They set a payee: the one the transactions are now filed under. */
  payeeChanged?: boolean;
}

export type RuleSuggestion =
  | {
      kind: "create";
      draft: RuleDraft;
      /** The payee the suggestion is about, for "don't suggest for this payee". */
      payeeId: string | null;
      /** The text the transactions share, to name the rule after. */
      bankText: string | null;
    }
  | {
      kind: "update";
      /** The rule that sets something else than the user just did. */
      applied: AppliedRule;
      payeeId: string | null;
    };

/** A text with its whitespace tidied: trimmed, and runs of it as one space. */
export function normalizeBankText(text: string | null | undefined): string {
  return (text ?? "").trim().replace(/\s+/g, " ");
}

// The characters `regex::escape` escapes, as in `rule-conditions.ts`.
const REGEX_META = /[\\.+*?()|[\]{}^$#&\-~]/g;
const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

/**
 * The condition that matches exactly this bank text, whatever its spacing.
 *
 * A tidy text is an `exact` condition, which the form can loosen to "contains"
 * or a list. The matcher compares an exact text character for character, so a
 * text with stray or doubled spaces is matched by a regex of its words
 * instead: the tidied text alone would not match the transaction it came from.
 */
export function bankTextCondition(text: string): { pattern: string; matchType: RuleMatchType } {
  const tidy = normalizeBankText(text);
  if (tidy === text) return { pattern: text, matchType: "exact" };
  const words = tidy.split(" ").map((word) => word.replace(REGEX_META, "\\$&"));
  const pattern = `(?i)^\\s*${words.join("\\s+")}\\s*$`;
  // Too long to store as a regex: the text as it is still matches itself.
  if (utf8Length(pattern) > MAX_REGEX_PATTERN_LENGTH) return { pattern: text, matchType: "exact" };
  return { pattern, matchType: "regex" };
}

const MAX_RULE_NAME_LENGTH = 60;

/** A rule's name: the payee's, else the bank text, shortened. */
export function suggestedRuleName(
  payeeName: string | null | undefined,
  bankText: string | null | undefined,
): string {
  const name = normalizeBankText(payeeName) || normalizeBankText(bankText);
  if (name.length <= MAX_RULE_NAME_LENGTH) return name;
  return `${name.slice(0, MAX_RULE_NAME_LENGTH - 1).trimEnd()}…`;
}

/** The value every item has, or undefined when they differ or one has none. */
function shared<T>(values: (T | null | undefined)[]): T | undefined {
  const [first] = values;
  if (first == null) return undefined;
  return values.every((value) => value === first) ? first : undefined;
}

type RuleVerdict =
  /** Every transaction already gets the chosen value from a rule. */
  | { state: "done" }
  /** One rule gives another value, to all of them or to those it applies to. */
  | { state: "differs"; applied: AppliedRule }
  /** No rule applies to any of them. */
  | { state: "none" }
  /** Some already get the chosen value and no rule touches the rest. */
  | { state: "partial" }
  /** Different rules give other values: there is no one rule to change. */
  | { state: "conflict" };

function verdict(rules: (AppliedRule | null | undefined)[], chosen: string): RuleVerdict {
  if (rules.every((applied) => applied?.categoryId === chosen)) return { state: "done" };
  if (rules.every((applied) => !applied)) return { state: "none" };
  const differing = rules.filter(
    (applied): applied is AppliedRule => !!applied && applied.categoryId !== chosen,
  );
  if (differing.length === 0) return { state: "partial" };
  // A new rule beside one that says otherwise would only compete with it.
  const [first] = differing;
  return differing.every((applied) => applied.rule.id === first.rule.id)
    ? { state: "differs", applied: first }
    : { state: "conflict" };
}

const textDraft = (
  text: string,
  target: { taxonomyId: string; categoryId: string },
  setPayeeId: string | null = null,
): RuleDraft => ({
  ...bankTextCondition(text),
  taxonomyId: target.taxonomyId,
  categoryId: target.categoryId,
  payeeConditionId: null,
  setPayeeId,
});

const payeeDraft = (
  payeeId: string,
  target: { taxonomyId: string; categoryId: string },
): RuleDraft => ({
  // The form shows a rule without a text condition as an empty text.
  pattern: "",
  matchType: "contains",
  taxonomyId: target.taxonomyId,
  categoryId: target.categoryId,
  payeeConditionId: payeeId,
  setPayeeId: null,
});

/**
 * The rule to offer after a manual edit, or null when there is none to offer.
 *
 * `explanations` are what the rules make of the edited transactions, read
 * after the edit (`explain_activity_rules`): matching stays in the backend.
 * No rule is offered when the rules already give what the user chose; when one
 * rule gives something else, that rule is offered for editing instead.
 *
 * A category is matched on the payee when a rule files the transactions under
 * it, else on the exact bank text (which then sets a hand-set payee too). A
 * payee is matched on the exact bank text. Several transactions are only
 * matched on what they all share.
 */
export function buildRuleSuggestion(
  explanations: ActivityRuleExplanation[],
  edit: ManualEdit,
): RuleSuggestion | null {
  if (explanations.length === 0) return null;
  const single = explanations.length === 1;
  const payeeId = shared(explanations.map((explained) => explained.payeeId)) ?? null;
  // The tidy text they all have, and one of them as stored: a stray space in
  // any of them makes the condition match on the words instead.
  const tidyText = shared(explanations.map((explained) => normalizeBankText(explained.bankText)));
  const bankText = tidyText
    ? (explanations.find((explained) => explained.bankText !== tidyText)?.bankText ?? tidyText)
    : null;
  // What the rules make of the payee these are filed under. A payee the user
  // cleared leaves nothing to ask about.
  const payee = payeeId
    ? verdict(
        explanations.map((explained) => explained.payeeRule),
        payeeId,
      )
    : null;

  if (edit.category) {
    const category = verdict(
      explanations.map((explained) => explained.categoryRule),
      edit.category.categoryId,
    );
    if (category.state === "differs") {
      return { kind: "update", applied: category.applied, payeeId };
    }
    if (category.state === "conflict") return null;
    if (category.state !== "done") {
      if (payee && payeeId) {
        // The user has just set this payee and a rule files these under
        // another: that rule comes first, the category would follow it.
        if (edit.payeeChanged && payee.state === "differs") {
          return { kind: "update", applied: payee.applied, payeeId };
        }
        // A rule files them under this payee, so a rule can match on it.
        if (payee.state === "done") {
          return { kind: "create", draft: payeeDraft(payeeId, edit.category), payeeId, bankText };
        }
        // No rule does: the payee is there by hand, and a rule matching on
        // it would never meet an imported transaction. It matches on the
        // text instead, and sets the payee too when no rule sets any.
        if (bankText) {
          return {
            kind: "create",
            draft: textDraft(bankText, edit.category, payee.state === "none" ? payeeId : null),
            payeeId,
            bankText,
          };
        }
        // Nothing but the payee is shared: a rule on it still files what the
        // user gives that payee.
        return { kind: "create", draft: payeeDraft(payeeId, edit.category), payeeId, bankText };
      }
      if (single && bankText) {
        return { kind: "create", draft: textDraft(bankText, edit.category), payeeId, bankText };
      }
      return null;
    }
  }

  if (!edit.payeeChanged || !payee || !payeeId) return null;
  if (payee.state === "done" || payee.state === "conflict") return null;
  if (payee.state === "differs") return { kind: "update", applied: payee.applied, payeeId };
  if (!bankText) return null;
  return {
    kind: "create",
    draft: textDraft(bankText, { taxonomyId: PAYEES_TAXONOMY_ID, categoryId: payeeId }),
    payeeId,
    bankText,
  };
}

/**
 * The rule the form opens with for "Create rule" on a transaction: matched on
 * the payee a rule gives it, else on its exact bank text, and setting the
 * category it has.
 */
export function ruleDraftForActivity(
  explained: ActivityRuleExplanation,
  category: { taxonomyId: string; categoryId: string } | null,
): RuleDraft {
  const target = {
    taxonomyId: category?.taxonomyId ?? null,
    categoryId: category?.categoryId ?? null,
  };
  const hasText = !!explained.bankText?.trim();
  // On the payee when a rule files the transaction under it, or when there is
  // no text to match instead. A payee set by hand is matched on the text, as
  // in `buildRuleSuggestion`: imports only get a payee from a rule.
  if (explained.payeeId && (explained.payeeRule?.categoryId === explained.payeeId || !hasText)) {
    return {
      pattern: "",
      matchType: "contains",
      ...target,
      payeeConditionId: explained.payeeId,
      setPayeeId: null,
    };
  }
  const setPayeeId =
    explained.payeeId && !explained.payeeRule && category ? explained.payeeId : null;
  const condition =
    explained.bankText && hasText
      ? bankTextCondition(explained.bankText)
      : { pattern: "", matchType: "contains" as const };
  return { ...condition, ...target, payeeConditionId: null, setPayeeId };
}
