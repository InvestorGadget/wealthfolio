import { useId } from "react";
import { useTranslation } from "react-i18next";

import { Button, Switch } from "@wealthfolio/ui";

import {
  DEFAULT_RULE_SUGGESTION_PREFERENCES,
  RULE_SUGGESTIONS_STORAGE_KEY,
  ruleSuggestionsActive,
  type RuleSuggestionPreferences,
} from "@/features/spending/lib/rule-suggestion-preferences";
import { usePersistentState } from "@/hooks/use-persistent-state";

/**
 * "Suggest rules after I categorize": whether filing a transaction by hand
 * offers to make a rule of it. Kept on this device, with what the prompt
 * itself remembers ("Not today", "Don't suggest for this payee").
 */
export function RuleSuggestionsToggle() {
  const { t } = useTranslation();
  const [preferences, setPreferences] = usePersistentState<RuleSuggestionPreferences>(
    RULE_SUGGESTIONS_STORAGE_KEY,
    DEFAULT_RULE_SUGGESTION_PREFERENCES,
  );
  const labelId = useId();
  const descriptionId = useId();
  const enabled = preferences.enabled !== false;
  const mutedPayeeIds = preferences.mutedPayeeIds ?? [];
  const held =
    enabled && (mutedPayeeIds.length > 0 || !ruleSuggestionsActive({ ...preferences, enabled }));

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
          onCheckedChange={(next) => setPreferences((current) => ({ ...current, enabled: next }))}
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
              setPreferences((current) => ({ ...current, snoozedUntil: null, mutedPayeeIds: [] }))
            }
          >
            {t("settings:spending.rule_suggestions.resume")}
          </Button>
        </div>
      )}
    </div>
  );
}
