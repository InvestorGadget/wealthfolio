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
}

/**
 * Runs the categorization rules on the selected transactions.
 *
 * It first shows what the run would change and how many hand-set categories
 * and payees it would keep. Those are kept unless the user ticks the override
 * and confirms it. The run replaces what earlier rules, imports and the
 * assistant set, as "Recategorize all" does, on these transactions only.
 */
export function RunRulesDialog({ activityIds, onClose }: RunRulesDialogProps) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const preview = useQuery({
    queryKey: ["spending-rules-run-preview", activityIds],
    queryFn: () => previewCategorizationRulesRerun(false, { activityIds }),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
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
      onClose();
    },
    onError: () => toast.error(t("spending:rules.runSelected.error")),
  });
  const override = useRuleRunOverride((overrideManual) => run.mutate(overrideManual));

  const changes = preview.data?.changedActivities ?? 0;
  const keptManual = preview.data?.keptManualActivities ?? 0;
  const canRun = !!preview.data && !run.isPending && (changes > 0 || override.checked);

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && !run.isPending && onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("spending:rules.runSelected.title")}</DialogTitle>
            <DialogDescription>
              {preview.isLoading
                ? t("spending:rules.runSelected.loading")
                : preview.isError
                  ? t("spending:rules.runSelected.previewError")
                  : changes === 0 && keptManual === 0
                    ? t("spending:rules.runSelected.nothing")
                    : [
                        t("spending:rules.runSelected.willChange", { count: changes }),
                        keptManual > 0
                          ? t("spending:rules.runSelected.keptManual", { count: keptManual })
                          : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
            </DialogDescription>
          </DialogHeader>
          {keptManual > 0 && (
            <RuleRunOverrideCheckbox
              override={override}
              count={keptManual}
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
      <RuleRunOverrideConfirm override={override} count={keptManual} />
    </>
  );
}
