import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import {
  muteRuleSuggestionsForPayee,
  readRuleSuggestionPreferences,
  RULE_SUGGESTIONS_STORAGE_KEY,
  ruleSuggestionsActive,
  snoozeRuleSuggestions,
} from "@/features/spending/lib/rule-suggestion-preferences";
import { render, screen } from "@/test/render";

import { RuleSuggestionsToggle } from "./rule-suggestions-toggle";

beforeEach(() => localStorage.clear());

describe("RuleSuggestionsToggle", () => {
  it("is on by default and says what it does", () => {
    render(<RuleSuggestionsToggle />);
    const toggle = screen.getByRole("switch", { name: "Suggest rules after I categorize" });
    expect(toggle).toBeChecked();
    expect(toggle).toHaveAccessibleDescription(/Nothing is created until you confirm/);
    expect(screen.queryByRole("button", { name: "Suggest again" })).not.toBeInTheDocument();
  });

  it("switches suggestions off and on again, and keeps the choice", async () => {
    const user = userEvent.setup();
    const view = render(<RuleSuggestionsToggle />);
    await user.click(screen.getByRole("switch"));

    expect(readRuleSuggestionPreferences().enabled).toBe(false);
    expect(ruleSuggestionsActive(readRuleSuggestionPreferences())).toBe(false);

    // Still off for the next visit to the page.
    view.unmount();
    render(<RuleSuggestionsToggle />);
    expect(screen.getByRole("switch")).not.toBeChecked();

    await user.click(screen.getByRole("switch"));
    expect(readRuleSuggestionPreferences().enabled).toBe(true);
  });

  it("lifts a snooze and the silenced payees, which the prompt has no way back from", async () => {
    const user = userEvent.setup();
    snoozeRuleSuggestions();
    muteRuleSuggestionsForPayee("payee_tesco");
    render(<RuleSuggestionsToggle />);

    await user.click(screen.getByRole("button", { name: "Suggest again" }));
    expect(readRuleSuggestionPreferences()).toEqual({
      enabled: true,
      snoozedUntil: null,
      mutedPayeeIds: [],
    });
    expect(screen.queryByRole("button", { name: "Suggest again" })).not.toBeInTheDocument();
  });

  it("keeps what the prompt remembers when it is switched off", async () => {
    const user = userEvent.setup();
    muteRuleSuggestionsForPayee("payee_tesco");
    render(<RuleSuggestionsToggle />);
    await user.click(screen.getByRole("switch"));

    expect(readRuleSuggestionPreferences()).toMatchObject({
      enabled: false,
      mutedPayeeIds: ["payee_tesco"],
    });
  });

  it("does not undo what the prompt stored after the page opened", async () => {
    const user = userEvent.setup();
    render(<RuleSuggestionsToggle />);
    // The prompt, elsewhere, while this page is open.
    snoozeRuleSuggestions();
    muteRuleSuggestionsForPayee("payee_tesco");

    await user.click(screen.getByRole("switch"));
    const stored = readRuleSuggestionPreferences();
    expect(stored.enabled).toBe(false);
    expect(stored.snoozedUntil).not.toBeNull();
    expect(stored.mutedPayeeIds).toEqual(["payee_tesco"]);
  });

  it("reads a stored value without a snooze as not held", () => {
    localStorage.setItem(RULE_SUGGESTIONS_STORAGE_KEY, JSON.stringify({ enabled: true }));
    render(<RuleSuggestionsToggle />);
    expect(screen.getByRole("switch")).toBeChecked();
    expect(screen.queryByRole("button", { name: "Suggest again" })).not.toBeInTheDocument();
  });
});
