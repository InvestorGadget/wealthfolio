import { useTranslation } from "react-i18next";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@wealthfolio/ui";

import {
  RuleForm,
  type RuleFormAccountOption,
  type RuleFormCategoryOption,
  type RuleFormValues,
} from "./rule-form";
import type { CategorizationRule, RuleDraft } from "../types/rule";

interface RuleEditModalProps {
  open: boolean;
  onClose: () => void;
  rule?: CategorizationRule;
  /** What a new rule starts from. Ignored when editing `rule`. */
  draft?: RuleDraft;
  categoryOptions: RuleFormCategoryOption[];
  accountOptions: RuleFormAccountOption[];
  onSave: (values: RuleFormValues) => void;
  isLoading?: boolean;
}

export function RuleEditModal({
  open,
  onClose,
  rule,
  draft,
  categoryOptions,
  accountOptions,
  onSave,
  isLoading,
}: RuleEditModalProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-160">
        <DialogHeader>
          <DialogTitle>
            {rule ? t("spending:rules.editTitle") : t("spending:rules.addTitle")}
          </DialogTitle>
          <DialogDescription>{t("spending:rules.editDescription")}</DialogDescription>
        </DialogHeader>
        <RuleForm
          rule={rule}
          draft={draft}
          categoryOptions={categoryOptions}
          accountOptions={accountOptions}
          onSubmit={onSave}
          onCancel={onClose}
          isLoading={isLoading}
        />
      </DialogContent>
    </Dialog>
  );
}
