import { useTranslation } from "react-i18next";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@wealthfolio/ui";

import type { CategorizationRunSummary } from "../types/rule";

interface RuleApplyDialogProps {
  /** What running the rules on uncategorized transactions would change; null closes the dialog. */
  preview: CategorizationRunSummary | null;
  isApplying?: boolean;
  onApply: () => void;
  onClose: () => void;
  /**
   * More to choose before applying, below the counts. The dialog itself only
   * ever fills in what has no category: anything that widens the run (such as
   * overwriting what was categorized by hand) is the caller's to add here and
   * to act on in `onApply`.
   */
  children?: React.ReactNode;
}

/**
 * "Apply to N matching uncategorized transactions?", asked once a suggested
 * rule is saved. Declining leaves the rule for the next import or rerun.
 */
export function RuleApplyDialog({
  preview,
  isApplying = false,
  onApply,
  onClose,
  children,
}: RuleApplyDialogProps) {
  const { t } = useTranslation();
  const kept = preview?.protectedManual ?? 0;
  return (
    <AlertDialog open={!!preview} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("spending:ruleSuggestion.applyTitle", { count: preview?.eligible ?? 0 })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {kept > 0
              ? t("spending:ruleSuggestion.applyKept", { count: kept })
              : t("spending:ruleSuggestion.applyKeepsManual")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel>{t("spending:ruleSuggestion.applyLater")}</AlertDialogCancel>
          <AlertDialogAction onClick={onApply} disabled={isApplying}>
            {t("spending:ruleSuggestion.applyConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
