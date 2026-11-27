import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Spinner,
} from "@wealthfolio/ui";

import {
  previewCategorizationRulesRerun,
  rerunCategorizationRulesDetailed,
} from "../adapters/rules";
import { invalidateSpendingCaches } from "../lib/invalidation";
import {
  RuleRunOverrideCheckbox,
  RuleRunOverrideConfirm,
  useRuleRunOverride,
} from "./rule-run-override";

interface RunRulesDialogProps {
  /** The transactions to run the rules on. */
  activityIds: string[];
  onClose: () => void;
  /** Called once the rules have run, before the dialog closes. */
  onRan?: () => void;
}

/**
 * Runs the categorization rules on the selected transactions.
 *
 * It first shows what the run would change and how many hand-set categories
 * and payees it would keep. Those are kept unless the user ticks the override
 * and confirms it; with the box ticked the numbers are those of the run that
 * replaces them. The run replaces what earlier rules, imports and the
 * assistant set, as "Recategorize all" does, on these transactions only.
 */
export function RunRulesDialog({ activityIds, onClose, onRan }: RunRulesDialogProps) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const previewOf = (overrideManual: boolean) => ({
    queryKey: ["spending-rules-run-preview", activityIds, overrideManual],
    queryFn: () => previewCategorizationRulesRerun(false, { activityIds, overrideManual }),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  // The protected run is always previewed: its kept count is what the
  // override offers to replace.
  const protectedPreview = useQuery(previewOf(false));
  const run = useMutation({
    mutationFn: (overrideManual: boolean) =>
      rerunCategorizationRulesDetailed(false, { activityIds, overrideManual }),
    onSuccess: (summary) => {
      invalidateSpendingCaches(qc);
      const details: string[] = [];
      if (summary.replacedManualActivities > 0) {
        details.push(
          t("spending:rules.runSelected.doneReplaced", {
            count: summary.replacedManualActivities,
          }),
        );
      }
      if (summary.keptManualActivities > 0) {
        details.push(
          t("spending:rules.runSelected.doneKept", { count: summary.keptManualActivities }),
        );
      }
      if (summary.protectedSplits > 0) {
        details.push(
          t("spending:rules.runSelected.splitsKept", { count: summary.protectedSplits }),
        );
      }
      toast.success(t("spending:rules.runSelected.done", { count: summary.changedActivities }), {
        description: details.length > 0 ? details.join(" ") : undefined,
      });
      onRan?.();
      onClose();
    },
    onError: () => toast.error(t("spending:rules.runSelected.error")),
  });
  const override = useRuleRunOverride((overrideManual) => run.mutate(overrideManual));

  const overridePreview = useQuery({ ...previewOf(true), enabled: override.checked });
  // What is shown and run is the preview of the run the box asks for.
  const preview = override.checked ? overridePreview : protectedPreview;

  const replaceable = protectedPreview.data?.keptManualActivities ?? 0;
  const changes = preview.data?.changedActivities ?? 0;
  const keptManual = preview.data?.keptManualActivities ?? 0;
  const replaced = preview.data?.replacedManualActivities ?? 0;
  const canRun = !!preview.data && !run.isPending && changes > 0;

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && !run.isPending && onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("spending:rules.runSelected.title")}</DialogTitle>
            <DialogDescription>
              {/* Announced when it arrives, and again when the box changes it. */}
              <span role="status" aria-live="polite">
                {preview.isLoading
                  ? t("spending:rules.runSelected.loading")
                  : preview.isError
                    ? t("spending:rules.runSelected.previewError")
                    : changes === 0 && keptManual === 0
                      ? t("spending:rules.runSelected.nothing")
                      : [
                          t("spending:rules.runSelected.willChange", { count: changes }),
                          replaced > 0
                            ? t("spending:rules.runSelected.replacesManual", { count: replaced })
                            : "",
                          keptManual > 0
                            ? t("spending:rules.runSelected.keptManual", { count: keptManual })
                            : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
              </span>
            </DialogDescription>
          </DialogHeader>
          {replaceable > 0 && (
            <RuleRunOverrideCheckbox
              override={override}
              count={replaceable}
              disabled={run.isPending}
            />
          )}
          <DialogFooter>
            <Button variant="outline" disabled={run.isPending} onClick={onClose}>
              {t("common:cancel")}
            </Button>
            <Button disabled={!canRun} onClick={override.submit}>
              {run.isPending && <Spinner className="me-2 h-3.5 w-3.5" />}
              {t("spending:rules.runSelected.apply")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <RuleRunOverrideConfirm override={override} count={replaced} />
    </>
  );
}
