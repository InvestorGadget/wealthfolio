import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, Switch } from "@wealthfolio/ui";

import {
  readRuleSuggestionPreferences,
  ruleSuggestionsActive,
  updateRuleSuggestionPreferences,
  type RuleSuggestionPreferences,
} from "@/features/spending/lib/rule-suggestion-preferences";

/**
 * "Suggest rules after I categorize": whether filing a transaction by hand
 * offers to make a rule of it. Kept on this device, with what the prompt
 * itself remembers ("Not today", "Don't suggest for this payee").
 *
 * Read and written through the same functions as the prompt: each change is
 * made to what is stored at that moment, so switching this does not undo a
 * snooze or a silenced payee the prompt has stored since the page opened.
 */
export function RuleSuggestionsToggle() {
  const { t } = useTranslation();
  const [preferences, setPreferences] = useState(readRuleSuggestionPreferences);
  const change = (next: (current: RuleSuggestionPreferences) => RuleSuggestionPreferences) =>
    setPreferences(updateRuleSuggestionPreferences(next));
  const labelId = useId();
  const descriptionId = useId();
  const { enabled, mutedPayeeIds } = preferences;
  const held = enabled && (mutedPayeeIds.length > 0 || !ruleSuggestionsActive(preferences));

  return (
    <div className="border-border/60 bg-card/40 rounded-md border px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p id={labelId} className="text-foreground text-sm font-medium">
            {t("settings:spending.rule_suggestions.title")}
          </p>
          <p id={descriptionId} className="text-muted-foreground mt-0.5 text-xs">
            {t("settings:spending.rule_suggestions.description")}
          </p>
        </div>
        <Switch
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          checked={enabled}
          onCheckedChange={(next) => change((current) => ({ ...current, enabled: next }))}
        />
      </div>
      {held && (
        <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span>{t("settings:spending.rule_suggestions.held")}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 text-xs"
            onClick={() =>
              change((current) => ({ ...current, snoozedUntil: null, mutedPayeeIds: [] }))
            }
          >
            {t("settings:spending.rule_suggestions.resume")}
          </Button>
        </div>
      )}
    </div>
  );
}
