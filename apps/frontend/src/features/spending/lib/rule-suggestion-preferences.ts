import { profilePreferenceKey, readProfilePreference } from "@/hooks/use-persistent-state";

/**
 * Where "Create a rule for this?" is switched off, snoozed, or silenced for a
 * payee. Kept with the other per-device, per-profile preferences in browser
 * storage: how often to be asked belongs to the screen it is asked on, and
 * none of it is financial data.
 */
export const RULE_SUGGESTIONS_STORAGE_KEY = "spending-rule-suggestions";

export interface RuleSuggestionPreferences {
  /** "Suggest rules after I categorize", on unless switched off. */
  enabled: boolean;
  /** No suggestion before this time (epoch milliseconds): "Not today". */
  snoozedUntil: number | null;
  /** Payees never to suggest a rule for. */
  mutedPayeeIds: string[];
}

export const DEFAULT_RULE_SUGGESTION_PREFERENCES: RuleSuggestionPreferences = {
  enabled: true,
  snoozedUntil: null,
  mutedPayeeIds: [],
};

export const RULE_SUGGESTION_SNOOZE_MS = 24 * 60 * 60 * 1000;

/** Reads what is stored, falling back field by field on anything unreadable. */
export function parseRuleSuggestionPreferences(
  stored: string | null | undefined,
): RuleSuggestionPreferences {
  if (!stored) return DEFAULT_RULE_SUGGESTION_PREFERENCES;
  try {
    const value = JSON.parse(stored) as Partial<RuleSuggestionPreferences> | null;
    return {
      enabled: typeof value?.enabled === "boolean" ? value.enabled : true,
      snoozedUntil: typeof value?.snoozedUntil === "number" ? value.snoozedUntil : null,
      mutedPayeeIds: Array.isArray(value?.mutedPayeeIds)
        ? value.mutedPayeeIds.filter((id): id is string => typeof id === "string")
        : [],
    };
  } catch {
    return DEFAULT_RULE_SUGGESTION_PREFERENCES;
  }
}

export function readRuleSuggestionPreferences(): RuleSuggestionPreferences {
  try {
    return parseRuleSuggestionPreferences(readProfilePreference(RULE_SUGGESTIONS_STORAGE_KEY));
  } catch {
    // Browser storage can be unavailable: suggestions then stay on.
    return DEFAULT_RULE_SUGGESTION_PREFERENCES;
  }
}

/** Changes what is stored. Returns the preferences as they now are. */
export function updateRuleSuggestionPreferences(
  change: (current: RuleSuggestionPreferences) => RuleSuggestionPreferences,
): RuleSuggestionPreferences {
  const next = change(readRuleSuggestionPreferences());
  try {
    localStorage.setItem(profilePreferenceKey(RULE_SUGGESTIONS_STORAGE_KEY), JSON.stringify(next));
  } catch {
    // Not stored: the choice holds until the next suggestion only.
  }
  return next;
}

/** "Not today": no suggestion for the next 24 hours. */
export const snoozeRuleSuggestions = (now: number = Date.now()): RuleSuggestionPreferences =>
  updateRuleSuggestionPreferences((current) => ({
    ...current,
    snoozedUntil: now + RULE_SUGGESTION_SNOOZE_MS,
  }));

/** "Don't suggest for this payee". */
export const muteRuleSuggestionsForPayee = (payeeId: string): RuleSuggestionPreferences =>
  updateRuleSuggestionPreferences((current) =>
    current.mutedPayeeIds.includes(payeeId)
      ? current
      : { ...current, mutedPayeeIds: [...current.mutedPayeeIds, payeeId] },
  );

/** Whether suggestions are being made at all right now. */
export function ruleSuggestionsActive(
  preferences: RuleSuggestionPreferences,
  now: number = Date.now(),
): boolean {
  if (!preferences.enabled) return false;
  return preferences.snoozedUntil === null || preferences.snoozedUntil <= now;
}

/** Whether a suggestion about this payee may be shown. */
export function mayOfferRuleSuggestion(
  preferences: RuleSuggestionPreferences,
  payeeId: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!ruleSuggestionsActive(preferences, now)) return false;
  return !payeeId || !preferences.mutedPayeeIds.includes(payeeId);
}
