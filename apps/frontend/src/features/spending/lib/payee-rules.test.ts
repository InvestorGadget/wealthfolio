import { describe, expect, it } from "vitest";

import type { CategorizationRule } from "../types/rule";
import {
  bankText,
  countRulesByPayee,
  MAX_MERGE_RULE_TEXTS,
  mergeRuleDraft,
  payeeConditionDraft,
  payeeRuleCoversTexts,
  ruleNamesPayee,
  rulesForPayeePath,
  summarizeBankTexts,
} from "./payee-rules";
import {
  compileAnyOfPattern,
  MAX_REGEX_PATTERN_LENGTH,
  textConditionDraft,
} from "./rule-conditions";

const rule = (overrides: Partial<CategorizationRule>): CategorizationRule => ({
  id: "r",
  name: "Rule",
  pattern: "X",
  matchType: "contains",
  taxonomyId: "spending_categories",
  categoryId: "cat",
  priority: 0,
  isGlobal: true,
  createdAt: "",
  updatedAt: "",
  ...overrides,
});
const payeeRule = (payeeId: string, overrides: Partial<CategorizationRule> = {}) =>
  rule({ taxonomyId: "payees", categoryId: payeeId, ...overrides });

describe("ruleNamesPayee", () => {
  it("holds for the payee a rule targets, matches on, or also sets", () => {
    expect(ruleNamesPayee(payeeRule("p1"), "p1")).toBe(true);
    expect(ruleNamesPayee(rule({ payeeConditionId: "p1" }), "p1")).toBe(true);
    expect(ruleNamesPayee(rule({ setPayeeId: "p1" }), "p1")).toBe(true);
  });

  it("does not hold for another payee, or a category that shares the id", () => {
    expect(ruleNamesPayee(payeeRule("p2"), "p1")).toBe(false);
    expect(ruleNamesPayee(rule({ categoryId: "p1" }), "p1")).toBe(false);
    expect(ruleNamesPayee(rule({}), "p1")).toBe(false);
  });
});

describe("countRulesByPayee", () => {
  it("counts each rule once for every payee it names", () => {
    const rules = [
      payeeRule("p1"),
      rule({ payeeConditionId: "p1" }),
      rule({ setPayeeId: "p1" }),
      rule({ setPayeeId: "p2" }),
      // A category with a payee's id is not that payee.
      rule({ categoryId: "p2" }),
      rule({}),
    ];

    const counts = countRulesByPayee(rules);

    expect(Object.fromEntries(counts)).toEqual({ p1: 3, p2: 1 });
    // The count is the number of rules the rules page shows for the payee.
    for (const [payeeId, count] of counts) {
      expect(rules.filter((r) => ruleNamesPayee(r, payeeId))).toHaveLength(count);
    }
  });
});

it("links to the rules page narrowed to a payee", () => {
  expect(rulesForPayeePath("p 1&x")).toBe("/settings/spending/rules?payee=p%201%26x");
});

describe("bankText", () => {
  it("is the imported description, else the notes, as rules read them", () => {
    expect(bankText({ importedDescription: "TESCO 3301", notes: "Weekly shop" })).toBe(
      "TESCO 3301",
    );
    expect(bankText({ importedDescription: "   ", notes: "TESCO EXPRESS" })).toBe("TESCO EXPRESS");
    expect(bankText({ importedDescription: null, notes: "  " })).toBeUndefined();
  });
});

describe("summarizeBankTexts", () => {
  it("lists the distinct texts, ignoring case, most frequent first", () => {
    const summary = summarizeBankTexts([
      { notes: "SQ *BAKERY" },
      { importedDescription: "Corner Bakery 0042", notes: "croissants" },
      { importedDescription: "CORNER BAKERY 0042" },
      { notes: "corner bakery 0042" },
      { notes: "SQ *BAKERY" },
      { notes: "ONE OFF" },
      { notes: "" },
    ]);

    expect(summary).toEqual({
      texts: ["Corner Bakery 0042", "SQ *BAKERY", "ONE OFF"],
      distinct: 3,
    });
  });

  it("keeps the most frequent texts when there are more than the cap", () => {
    const activities = Array.from({ length: MAX_MERGE_RULE_TEXTS + 5 }, (_, i) => ({
      notes: `T${i}`,
    }));
    // The last one is the most frequent, so it must make the cut.
    activities.push({ notes: `T${MAX_MERGE_RULE_TEXTS + 4}` });

    const summary = summarizeBankTexts(activities);

    expect(summary.distinct).toBe(MAX_MERGE_RULE_TEXTS + 5);
    expect(summary.texts).toHaveLength(MAX_MERGE_RULE_TEXTS);
    expect(summary.texts[0]).toBe(`T${MAX_MERGE_RULE_TEXTS + 4}`);
    expect(summary.texts[1]).toBe("T0");
  });

  it("lists only as many texts as one stored rule can hold", () => {
    const long = (i: number) => `${"MERCHANT NAME ".repeat(6)}${i}`;
    const summary = summarizeBankTexts(Array.from({ length: 12 }, (_, i) => ({ notes: long(i) })));

    expect(summary.distinct).toBe(12);
    expect(summary.texts.length).toBeGreaterThan(0);
    expect(summary.texts.length).toBeLessThan(12);
    const pattern = compileAnyOfPattern({ mode: "exact", items: summary.texts });
    expect(new TextEncoder().encode(pattern).length).toBeLessThanOrEqual(MAX_REGEX_PATTERN_LENGTH);
  });

  it("counts but does not list a text the list form cannot hold whole", () => {
    const summary = summarizeBankTexts([
      { notes: " PADDED" },
      { notes: "TWO\nLINES" },
      { notes: "PLAIN" },
    ]);

    expect(summary).toEqual({ texts: ["PLAIN"], distinct: 3 });
  });
});

describe("payeeRuleCoversTexts", () => {
  const texts = ["CORNER BAKERY 0042", "SQ *BAKERY"];
  const list = (items: string[], mode: "exact" | "contains" = "exact") =>
    payeeRule("p1", { matchType: "regex", pattern: compileAnyOfPattern({ mode, items }) });

  it("holds when the payee's rules list every text as a whole text", () => {
    expect(
      payeeRuleCoversTexts([list(["corner bakery 0042", "SQ *BAKERY", "MORE"])], "p1", texts),
    ).toBe(true);
    expect(
      payeeRuleCoversTexts(
        [
          list(["CORNER BAKERY 0042"]),
          payeeRule("p1", { matchType: "exact", pattern: "sq *bakery" }),
        ],
        "p1",
        texts,
      ),
    ).toBe(true);
  });

  it("does not hold when a text is missing, or the rule is for something else", () => {
    expect(payeeRuleCoversTexts([list(["CORNER BAKERY 0042"])], "p1", texts)).toBe(false);
    expect(payeeRuleCoversTexts([list(texts)], "p2", texts)).toBe(false);
    expect(
      payeeRuleCoversTexts(
        [
          rule({
            matchType: "regex",
            pattern: compileAnyOfPattern({ mode: "exact", items: texts }),
          }),
        ],
        "p1",
        texts,
      ),
    ).toBe(false);
    expect(payeeRuleCoversTexts([], "p1", texts)).toBe(false);
  });

  it("does not count a rule that is narrowed, or matches another way", () => {
    for (const narrowed of [
      { isGlobal: false, accountId: "acct" },
      { activityType: "WITHDRAWAL" },
      { amountOp: "gt" as const, amountValue: 5 },
    ]) {
      expect(payeeRuleCoversTexts([{ ...list(texts), ...narrowed }], "p1", texts)).toBe(false);
    }
    expect(payeeRuleCoversTexts([list(texts, "contains")], "p1", texts)).toBe(false);
  });
});

describe("drafts", () => {
  it("starts a payee's rule on its payee condition alone", () => {
    expect(payeeConditionDraft({ id: "p1", name: "Corner Bakery" })).toEqual({
      name: "Corner Bakery",
      payeeConditionId: "p1",
    });
  });

  it("starts a merge's rule on the texts as a list of whole texts, for the destination", () => {
    const draft = mergeRuleDraft(["AT&T", "Disney+"], { id: "p1", name: "Phone" });

    expect(draft).toEqual({
      name: "Phone",
      pattern: "(?i)^(?:AT\\&T|Disney\\+)$",
      matchType: "regex",
      taxonomyId: "payees",
      categoryId: "p1",
    });
    // The form reads it back as its "exactly any of" list.
    expect(textConditionDraft({ pattern: draft.pattern!, matchType: "regex" })).toEqual({
      mode: "any_exact",
      pattern: "",
      list: "AT&T\nDisney+",
    });
  });
});
