import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_RULE_SUGGESTION_PREFERENCES,
  mayOfferRuleSuggestion,
  muteRuleSuggestionsForPayee,
  parseRuleSuggestionPreferences,
  readRuleSuggestionPreferences,
  RULE_SUGGESTION_SNOOZE_MS,
  RULE_SUGGESTIONS_STORAGE_KEY,
  ruleSuggestionsActive,
  snoozeRuleSuggestions,
  updateRuleSuggestionPreferences,
} from "./rule-suggestion-preferences";

beforeEach(() => localStorage.clear());

describe("rule suggestion preferences", () => {
  it("are on, unsnoozed and unsilenced until something is stored", () => {
    expect(readRuleSuggestionPreferences()).toEqual(DEFAULT_RULE_SUGGESTION_PREFERENCES);
    expect(mayOfferRuleSuggestion(readRuleSuggestionPreferences(), "payee_tesco")).toBe(true);
  });

  it("keep the switch across reads", () => {
    updateRuleSuggestionPreferences((current) => ({ ...current, enabled: false }));
    expect(readRuleSuggestionPreferences().enabled).toBe(false);
    expect(ruleSuggestionsActive(readRuleSuggestionPreferences())).toBe(false);
    expect(mayOfferRuleSuggestion(readRuleSuggestionPreferences(), null)).toBe(false);
  });

  it("snooze every suggestion for 24 hours, then resume", () => {
    const now = 1_700_000_000_000;
    snoozeRuleSuggestions(now);
    const stored = readRuleSuggestionPreferences();
    expect(stored.snoozedUntil).toBe(now + RULE_SUGGESTION_SNOOZE_MS);
    expect(ruleSuggestionsActive(stored, now + RULE_SUGGESTION_SNOOZE_MS - 1)).toBe(false);
    expect(ruleSuggestionsActive(stored, now + RULE_SUGGESTION_SNOOZE_MS)).toBe(true);
  });

  it("silence one payee and leave the others", () => {
    muteRuleSuggestionsForPayee("payee_tesco");
    muteRuleSuggestionsForPayee("payee_tesco");
    const stored = readRuleSuggestionPreferences();
    expect(stored.mutedPayeeIds).toEqual(["payee_tesco"]);
    expect(mayOfferRuleSuggestion(stored, "payee_tesco")).toBe(false);
    expect(mayOfferRuleSuggestion(stored, "payee_asda")).toBe(true);
    expect(mayOfferRuleSuggestion(stored, null)).toBe(true);
  });

  it("are stored in this browser only, as one JSON value", () => {
    muteRuleSuggestionsForPayee("payee_tesco");
    expect(JSON.parse(localStorage.getItem(RULE_SUGGESTIONS_STORAGE_KEY) ?? "null")).toEqual({
      enabled: true,
      snoozedUntil: null,
      mutedPayeeIds: ["payee_tesco"],
    });
  });

  it("read anything unreadable as the defaults, field by field", () => {
    expect(parseRuleSuggestionPreferences("not json")).toEqual(DEFAULT_RULE_SUGGESTION_PREFERENCES);
    expect(parseRuleSuggestionPreferences('{"enabled":false,"mutedPayeeIds":[1,"p"]}')).toEqual({
      enabled: false,
      snoozedUntil: null,
      mutedPayeeIds: ["p"],
    });
    expect(parseRuleSuggestionPreferences("null")).toEqual(DEFAULT_RULE_SUGGESTION_PREFERENCES);
  });
});
