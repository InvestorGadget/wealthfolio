import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Checkbox,
  Label,
} from "@wealthfolio/ui";

/**
 * The opt-in that lets a rule run replace categories and payees set by hand.
 *
 * A run keeps them unless the user ticks the box, and a ticked box is
 * confirmed once more before the run starts: replacing them cannot be undone.
 * `run` receives whether to override, which is only ever true after that
 * confirmation. Any screen that runs rules on a list of transactions can use
 * the hook with `RuleRunOverrideCheckbox` and `RuleRunOverrideConfirm`.
 */
export function useRuleRunOverride(run: (overrideManual: boolean) => void) {
  const [checked, setChecked] = useState(false);
  const [confirming, setConfirming] = useState(false);
  return {
    checked,
    setChecked,
    confirming,
    /** Starts the run, by way of the confirmation when the box is ticked. */
    submit: () => {
      if (checked) setConfirming(true);
      else run(false);
    },
    confirm: () => {
      setConfirming(false);
      run(true);
    },
    cancel: () => setConfirming(false),
  };
}

export type RuleRunOverride = ReturnType<typeof useRuleRunOverride>;

interface RuleRunOverrideProps {
  override: RuleRunOverride;
  /** Transactions with a hand-set value the rules would file differently. */
  count: number;
}

/** The unticked-by-default box. Render it only when there is something to replace. */
export function RuleRunOverrideCheckbox({
  override,
  count,
  disabled,
}: RuleRunOverrideProps & { disabled?: boolean }) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <Checkbox
        id={id}
        className="mt-0.5"
        checked={override.checked}
        disabled={disabled}
        onCheckedChange={(checked) => override.setChecked(checked === true)}
      />
      <Label htmlFor={id} className="text-sm leading-snug font-normal">
        {t("spending:rules.override.label", { count })}
      </Label>
    </div>
  );
}

/** The confirmation a ticked box goes through. Render it beside the checkbox's dialog. */
export function RuleRunOverrideConfirm({ override, count }: RuleRunOverrideProps) {
  const { t } = useTranslation();
  return (
    <AlertDialog open={override.confirming} onOpenChange={(open) => !open && override.cancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("spending:rules.override.confirmTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("spending:rules.override.confirmDescription", { count })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={override.cancel}>
            {t("common:cancel")}
          </Button>
          <Button variant="destructive" onClick={override.confirm}>
            {t("spending:rules.override.confirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
