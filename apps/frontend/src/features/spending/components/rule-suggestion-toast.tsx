import { useId } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@wealthfolio/ui";

export interface RuleSuggestionToastProps {
  /** The toast's own title, which names this group of buttons too. */
  title: string;
  /** What the rule would do, in a sentence. */
  description: string;
  /** "Create rule" or "Update rule". */
  actionLabel: string;
  /** The payee the suggestion is about, to offer silencing it. */
  payeeName?: string | null;
  onAction: () => void;
  /** "Not today": no suggestions for 24 hours. */
  onSnooze: () => void;
  onMutePayee?: () => void;
}

/**
 * What the "Create a rule for this?" toast says under its title, and its ways
 * out. The toast never blocks the list behind it, closes on its own close
 * button like any other, and nothing happens unless a button here is pressed.
 */
export function RuleSuggestionToast({
  title,
  description,
  actionLabel,
  payeeName,
  onAction,
  onSnooze,
  onMutePayee,
}: RuleSuggestionToastProps) {
  const { t } = useTranslation();
  const descriptionId = useId();
  return (
    <div
      role="group"
      aria-label={title}
      aria-describedby={descriptionId}
      data-testid="rule-suggestion"
      className="min-w-0"
    >
      <p id={descriptionId} className="wrap-break-word">
        {description}
      </p>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" className="h-7" onClick={onAction}>
          {actionLabel}
        </Button>
        <Button type="button" size="sm" variant="outline" className="h-7" onClick={onSnooze}>
          {t("spending:ruleSuggestion.notToday")}
        </Button>
        {payeeName && onMutePayee && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 max-w-full"
            onClick={onMutePayee}
          >
            <span className="truncate">
              {t("spending:ruleSuggestion.mutePayee", { payee: payeeName })}
            </span>
          </Button>
        )}
      </div>
      <p className="mt-2 text-xs opacity-70">{t("spending:ruleSuggestion.settingsHint")}</p>
    </div>
  );
}
