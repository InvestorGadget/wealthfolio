import { describe, expect, it } from "vitest";

import type { CategorizationRule } from "../types/rule";
import {
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

  it("leaves out a text the list form cannot hold whole, from the list and the count", () => {
    const summary = summarizeBankTexts([
      { notes: " PADDED" },
      { notes: "TWO\nLINES" },
      { notes: "PLAIN" },
    ]);

    // The count is what "the K most frequent of N" is said of.
    expect(summary).toEqual({ texts: ["PLAIN"], distinct: 1 });
  });
});

describe("payeeRuleCoversTexts", () => {
  const texts = ["CORNER BAKERY 0042", "SQ *BAKERY"];
  const list = (items: string[], mode: "exact" | "contains" = "exact") =>
    payeeRule("p1", { matchType: "regex", pattern: compileAnyOfPattern({ mode, items }) });
  const covers = (rules: CategorizationRule[], payeeId = "p1") =>
    payeeRuleCoversTexts(rules, payeeId, texts);

  it("holds when a list rule for the payee has every text", () => {
    expect(covers([list(["corner bakery 0042", "SQ *BAKERY", "MORE"])])).toBe(true);
    expect(covers([list(["bakery"], "contains")])).toBe(true);
  });

  it("weighs single-text rules as the matcher does, ignoring case", () => {
    expect(covers([payeeRule("p1", { matchType: "contains", pattern: "bakery" })])).toBe(true);
    expect(
      covers([
        payeeRule("p1", { matchType: "starts_with", pattern: "corner" }),
        payeeRule("p1", { matchType: "exact", pattern: "sq *bakery" }),
      ]),
    ).toBe(true);
    // Only the start, and only the whole text.
    expect(covers([payeeRule("p1", { matchType: "starts_with", pattern: "BAKERY" })])).toBe(false);
    expect(covers([payeeRule("p1", { matchType: "exact", pattern: "BAKERY" })])).toBe(false);
  });

  it("compares an exact pattern as stored, spaces included", () => {
    const one = ["SQ *BAKERY"];
    const exact = (pattern: string) => [payeeRule("p1", { matchType: "exact", pattern })];

    expect(payeeRuleCoversTexts(exact("SQ *BAKERY"), "p1", one)).toBe(true);
    expect(payeeRuleCoversTexts(exact("SQ *BAKERY "), "p1", one)).toBe(false);
  });

  it("counts a category rule that also sets the payee", () => {
    expect(covers([rule({ matchType: "contains", pattern: "BAKERY", setPayeeId: "p1" })])).toBe(
      true,
    );
    expect(covers([rule({ matchType: "contains", pattern: "BAKERY", setPayeeId: "p2" })])).toBe(
      false,
    );
  });

  it("does not hold when a text is missing, or the rule is for something else", () => {
    expect(covers([list(["CORNER BAKERY 0042"])])).toBe(false);
    expect(covers([list(texts)], "p2")).toBe(false);
    // A category rule that sets no payee.
    expect(covers([rule({ matchType: "contains", pattern: "BAKERY" })])).toBe(false);
    expect(covers([])).toBe(false);
  });

  it("does not count a rule that is narrowed, has no text, or is another regex", () => {
    for (const narrowed of [
      { isGlobal: false, accountId: "acct" },
      { activityType: "WITHDRAWAL" },
      { amountOp: "gt" as const, amountValue: 5 },
    ]) {
      expect(covers([{ ...list(texts), ...narrowed }])).toBe(false);
    }
    expect(covers([payeeRule("p1", { matchType: "regex", pattern: "(?!)" })])).toBe(false);
    // A hand-written regex is not evaluated.
    expect(covers([payeeRule("p1", { matchType: "regex", pattern: "BAKERY" })])).toBe(false);
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
