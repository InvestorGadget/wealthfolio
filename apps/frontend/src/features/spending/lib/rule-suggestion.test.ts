import { describe, expect, it } from "vitest";

import type { ActivityRuleExplanation, AppliedRule, CategorizationRule } from "../types/rule";
import {
  bankTextCondition,
  buildRuleSuggestion,
  normalizeBankText,
  ruleDraftForActivity,
  suggestedRuleName,
} from "./rule-suggestion";

const SPENDING = "spending_categories";
const groceries = { taxonomyId: SPENDING, categoryId: "cat_groceries" };

function applied(id: string, taxonomyId: string, categoryId: string): AppliedRule {
  return { rule: { id, name: id } as CategorizationRule, taxonomyId, categoryId };
}

function explained(
  activityId: string,
  fields: Partial<ActivityRuleExplanation> = {},
): ActivityRuleExplanation {
  return { activityId, bankText: "TESCO STORES 3301", payeeId: null, ...fields };
}

describe("bankTextCondition", () => {
  it("matches a tidy text exactly, so the form can loosen it", () => {
    expect(bankTextCondition("TESCO STORES 3301")).toEqual({
      pattern: "TESCO STORES 3301",
      matchType: "exact",
    });
  });

  it("matches a text with stray spaces on its words, since exact compares every character", () => {
    const { pattern, matchType } = bankTextCondition("  AMZN  Mktp (US)*1 ");
    expect(matchType).toBe("regex");
    expect(pattern).toBe("(?i)^\\s*AMZN\\s+Mktp\\s+\\(US\\)\\*1\\s*$");
    // The same shape the backend's regex matcher is given: the original text
    // and its tidied form both match, another text does not.
    const regex = new RegExp(pattern.replace("(?i)", ""), "i");
    expect(regex.test("  AMZN  Mktp (US)*1 ")).toBe(true);
    expect(regex.test("amzn mktp (us)*1")).toBe(true);
    expect(regex.test("AMZN Mktp (US)*12")).toBe(false);
  });

  it("keeps a text too long for a regex as it is", () => {
    const text = ` ${"WORD ".repeat(120)}`;
    expect(bankTextCondition(text)).toEqual({ pattern: text, matchType: "exact" });
  });
});

describe("suggestedRuleName", () => {
  it("is the payee's name, else the bank text, tidied and shortened", () => {
    expect(suggestedRuleName("Tesco", "TESCO STORES 3301")).toBe("Tesco");
    expect(suggestedRuleName(null, "  TESCO   STORES 3301 ")).toBe("TESCO STORES 3301");
    const long = suggestedRuleName("", "A".repeat(80));
    expect(long).toHaveLength(60);
    expect(long.endsWith("…")).toBe(true);
    expect(normalizeBankText(" a \t b ")).toBe("a b");
  });
});

describe("buildRuleSuggestion", () => {
  it("matches a category on the payee the transaction has", () => {
    const suggestion = buildRuleSuggestion([explained("a1", { payeeId: "payee_tesco" })], {
      category: groceries,
    });
    expect(suggestion).toEqual({
      kind: "create",
      payeeId: "payee_tesco",
      bankText: "TESCO STORES 3301",
      draft: {
        pattern: "",
        matchType: "contains",
        taxonomyId: SPENDING,
        categoryId: "cat_groceries",
        payeeConditionId: "payee_tesco",
        setPayeeId: null,
      },
    });
  });

  it("matches a category on the exact bank text when there is no payee", () => {
    const suggestion = buildRuleSuggestion([explained("a1")], { category: groceries });
    expect(suggestion).toMatchObject({
      kind: "create",
      payeeId: null,
      draft: {
        pattern: "TESCO STORES 3301",
        matchType: "exact",
        taxonomyId: SPENDING,
        categoryId: "cat_groceries",
        payeeConditionId: null,
        setPayeeId: null,
      },
    });
  });

  it("makes a payee-only rule of a payee set by hand: the payee, on the bank text", () => {
    const suggestion = buildRuleSuggestion([explained("a1", { payeeId: "payee_tesco" })], {
      payeeChanged: true,
    });
    expect(suggestion).toMatchObject({
      kind: "create",
      payeeId: "payee_tesco",
      draft: {
        pattern: "TESCO STORES 3301",
        matchType: "exact",
        taxonomyId: "payees",
        categoryId: "payee_tesco",
        payeeConditionId: null,
        setPayeeId: null,
      },
    });
  });

  it("makes one rule of a payee and a category set together when no rule knows the payee", () => {
    const suggestion = buildRuleSuggestion([explained("a1", { payeeId: "payee_tesco" })], {
      category: groceries,
      payeeChanged: true,
    });
    expect(suggestion).toMatchObject({
      kind: "create",
      draft: {
        pattern: "TESCO STORES 3301",
        matchType: "exact",
        taxonomyId: SPENDING,
        categoryId: "cat_groceries",
        payeeConditionId: null,
        setPayeeId: "payee_tesco",
      },
    });
  });

  it("matches on the payee when a rule already sets the payee the user chose", () => {
    const suggestion = buildRuleSuggestion(
      [
        explained("a1", {
          payeeId: "payee_tesco",
          payeeRule: applied("payee-rule", "payees", "payee_tesco"),
        }),
      ],
      { category: groceries, payeeChanged: true },
    );
    expect(suggestion).toMatchObject({
      kind: "create",
      draft: { pattern: "", payeeConditionId: "payee_tesco", setPayeeId: null },
    });
  });

  it("offers nothing when a rule already gives the chosen category", () => {
    const rules = [explained("a1", { categoryRule: applied("r1", SPENDING, "cat_groceries") })];
    expect(buildRuleSuggestion(rules, { category: groceries })).toBeNull();
  });

  it("offers nothing when a rule already sets the chosen payee", () => {
    const rules = [
      explained("a1", {
        payeeId: "payee_tesco",
        payeeRule: applied("r1", "payees", "payee_tesco"),
      }),
    ];
    expect(buildRuleSuggestion(rules, { payeeChanged: true })).toBeNull();
  });

  it("offers to update the rule that gives another category", () => {
    const rule = applied("r1", SPENDING, "cat_dining");
    expect(
      buildRuleSuggestion([explained("a1", { categoryRule: rule })], { category: groceries }),
    ).toEqual({ kind: "update", applied: rule, payeeId: null });
  });

  it("offers to update the rule that sets another payee", () => {
    const rule = applied("r1", "payees", "payee_asda");
    const rules = [explained("a1", { payeeId: "payee_tesco", payeeRule: rule })];
    expect(buildRuleSuggestion(rules, { payeeChanged: true })).toEqual({
      kind: "update",
      applied: rule,
      payeeId: "payee_tesco",
    });
    // The category rule would match on that payee: the payee rule comes first.
    expect(buildRuleSuggestion(rules, { category: groceries, payeeChanged: true })).toMatchObject({
      kind: "update",
      applied: rule,
    });
  });

  it("still offers the payee rule when the category is already covered", () => {
    const suggestion = buildRuleSuggestion(
      [
        explained("a1", {
          payeeId: "payee_tesco",
          categoryRule: applied("r1", SPENDING, "cat_groceries"),
        }),
      ],
      { category: groceries, payeeChanged: true },
    );
    expect(suggestion).toMatchObject({
      kind: "create",
      draft: { taxonomyId: "payees", categoryId: "payee_tesco", matchType: "exact" },
    });
  });

  it("offers nothing for a payee that was cleared, or a transaction without text or payee", () => {
    expect(buildRuleSuggestion([explained("a1")], { payeeChanged: true })).toBeNull();
    expect(
      buildRuleSuggestion([explained("a1", { bankText: "  " })], { category: groceries }),
    ).toBeNull();
    expect(buildRuleSuggestion([], { category: groceries })).toBeNull();
    expect(buildRuleSuggestion([explained("a1")], {})).toBeNull();
  });

  describe("several transactions", () => {
    it("offers a category rule only when they share one payee", () => {
      const shared = [
        explained("a1", { payeeId: "payee_tesco", bankText: "TESCO 1" }),
        explained("a2", { payeeId: "payee_tesco", bankText: "TESCO 2" }),
      ];
      expect(buildRuleSuggestion(shared, { category: groceries })).toMatchObject({
        kind: "create",
        payeeId: "payee_tesco",
        draft: { pattern: "", payeeConditionId: "payee_tesco", categoryId: "cat_groceries" },
      });

      const different = [
        explained("a1", { payeeId: "payee_tesco" }),
        explained("a2", { payeeId: "payee_asda" }),
      ];
      expect(buildRuleSuggestion(different, { category: groceries })).toBeNull();
      // Identical texts are not enough for a category: without a payee, none.
      expect(
        buildRuleSuggestion([explained("a1"), explained("a2")], { category: groceries }),
      ).toBeNull();
    });

    it("offers a payee rule only when their bank texts are identical", () => {
      const same = [
        explained("a1", { payeeId: "payee_tesco" }),
        explained("a2", { payeeId: "payee_tesco" }),
      ];
      expect(buildRuleSuggestion(same, { payeeChanged: true })).toMatchObject({
        kind: "create",
        draft: {
          pattern: "TESCO STORES 3301",
          matchType: "exact",
          taxonomyId: "payees",
          categoryId: "payee_tesco",
        },
      });

      const different = [
        explained("a1", { payeeId: "payee_tesco", bankText: "TESCO 1" }),
        explained("a2", { payeeId: "payee_tesco", bankText: "TESCO 2" }),
      ];
      expect(buildRuleSuggestion(different, { payeeChanged: true })).toBeNull();
    });

    it("matches texts that differ only in spacing on their words", () => {
      const spaced = [
        explained("a1", { payeeId: "payee_tesco", bankText: "TESCO STORES 3301" }),
        explained("a2", { payeeId: "payee_tesco", bankText: "TESCO  STORES 3301 " }),
      ];
      expect(buildRuleSuggestion(spaced, { payeeChanged: true })).toMatchObject({
        kind: "create",
        draft: { matchType: "regex", pattern: "(?i)^\\s*TESCO\\s+STORES\\s+3301\\s*$" },
      });
    });

    it("applies the guard to all of them", () => {
      const covered = applied("r1", SPENDING, "cat_groceries");
      const other = applied("r2", SPENDING, "cat_dining");
      const payee = { payeeId: "payee_tesco" };
      // All covered: nothing to offer.
      expect(
        buildRuleSuggestion(
          [
            explained("a1", { ...payee, categoryRule: covered }),
            explained("a2", { ...payee, categoryRule: covered }),
          ],
          { category: groceries },
        ),
      ).toBeNull();
      // One rule gives all of them something else: update it.
      expect(
        buildRuleSuggestion(
          [
            explained("a1", { ...payee, categoryRule: other }),
            explained("a2", { ...payee, categoryRule: other }),
          ],
          { category: groceries },
        ),
      ).toMatchObject({ kind: "update", applied: other });
      // Only some are covered: a rule for the rest.
      expect(
        buildRuleSuggestion(
          [explained("a1", { ...payee, categoryRule: covered }), explained("a2", payee)],
          { category: groceries },
        ),
      ).toMatchObject({ kind: "create", draft: { payeeConditionId: "payee_tesco" } });
    });
  });
});

describe("ruleDraftForActivity", () => {
  it("matches on the payee and sets the category the transaction has", () => {
    expect(ruleDraftForActivity(explained("a1", { payeeId: "payee_tesco" }), groceries)).toEqual({
      pattern: "",
      matchType: "contains",
      taxonomyId: SPENDING,
      categoryId: "cat_groceries",
      payeeConditionId: "payee_tesco",
      setPayeeId: null,
    });
  });

  it("matches on the exact bank text without a payee, and leaves the target to choose", () => {
    expect(ruleDraftForActivity(explained("a1"), null)).toEqual({
      pattern: "TESCO STORES 3301",
      matchType: "exact",
      taxonomyId: null,
      categoryId: null,
      payeeConditionId: null,
      setPayeeId: null,
    });
  });
});
