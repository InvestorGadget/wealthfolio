import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { getTaxonomy } from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import { getCategoryLabel } from "@/lib/taxonomy-labels";

import { explainActivityRules, previewCategorizationRulesRerun } from "../adapters/rules";
import {
  useCategorizationRuleMutations,
  useSaveRuleWithoutApplying,
} from "../hooks/use-categorization-rules";
import { useRuleFormOptions } from "../hooks/use-rule-form-options";
import { PAYEES_TAXONOMY_ID } from "../lib/payee";
import {
  buildRuleSuggestion,
  normalizeBankText,
  ruleDraftForActivity,
  suggestedRuleName,
  type ManualEdit,
  type RuleDraft,
  type RulePrefill,
  type RuleSuggestion,
} from "../lib/rule-suggestion";
import {
  mayOfferRuleSuggestion,
  muteRuleSuggestionsForPayee,
  readRuleSuggestionPreferences,
  ruleSuggestionsActive,
  snoozeRuleSuggestions,
} from "../lib/rule-suggestion-preferences";
import type { CategorizationRule, CategorizationRunSummary } from "../types/rule";
import { RuleApplyDialog } from "./rule-apply-dialog";
import { RuleEditModal } from "./rule-edit-modal";
import { newRuleFromFormValues, type RuleFormValues } from "./rule-form";
import { RuleSuggestionToast } from "./rule-suggestion-toast";

export interface RuleSuggestions {
  /**
   * Offers a rule after the user filed these transactions by hand. Call it
   * only once the write went through and changed something. It returns at
   * once: the offer, if there is one to make, shows up on its own.
   */
  suggestAfterEdit: (activityIds: string[], edit: ManualEdit) => void;
  /** Opens the rule form filled in for this transaction ("Create rule" in its menu). */
  createRuleFor: (
    activityId: string,
    category: { taxonomyId: string; categoryId: string } | null,
  ) => void;
}

const RuleSuggestionContext = createContext<RuleSuggestions | null>(null);

/** The rule suggestions of the screen, or null where nothing provides them. */
export function useRuleSuggestions(): RuleSuggestions | null {
  return useContext(RuleSuggestionContext);
}

/** One suggestion at a time: a newer one takes the place of the last. */
const TOAST_ID = "spending-rule-suggestion";
const TOAST_DURATION_MS = 20_000;
const MAX_QUOTED_TEXT_LENGTH = 60;

/** The rule form to open: a rule to edit, or a new one filled in. */
interface RuleFormRequest {
  /** Remounts the form for each request. */
  key: number;
  rule?: CategorizationRule;
  prefill?: RulePrefill;
}

/** The name of a category or payee, read through the cache the pickers share. */
async function categoryName(
  qc: QueryClient,
  t: ReturnType<typeof useTranslation>["t"],
  taxonomyId: string | null | undefined,
  categoryId: string | null | undefined,
): Promise<string> {
  if (!taxonomyId || !categoryId) return "";
  const read = async (staleTime: number) => {
    const taxonomy = await qc.fetchQuery({
      queryKey: QueryKeys.taxonomy(taxonomyId),
      queryFn: () => getTaxonomy(taxonomyId),
      staleTime,
    });
    return taxonomy?.categories.find((category) => category.id === categoryId);
  };
  // A payee created by the edit itself may not be in the cached list yet.
  const category = (await read(60_000)) ?? (await read(0));
  return category ? getCategoryLabel(t, taxonomyId, category.id, category.name) : "";
}

const quoted = (text: string | null): string => {
  const tidy = normalizeBankText(text);
  return tidy.length <= MAX_QUOTED_TEXT_LENGTH
    ? tidy
    : `${tidy.slice(0, MAX_QUOTED_TEXT_LENGTH - 1).trimEnd()}…`;
};

export function RuleSuggestionProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [formRequest, setFormRequest] = useState<RuleFormRequest | null>(null);
  const [applyPreview, setApplyPreview] = useState<CategorizationRunSummary | null>(null);

  const openForm = useCallback((request: Omit<RuleFormRequest, "key">) => {
    setFormRequest((previous) => ({ ...request, key: (previous?.key ?? 0) + 1 }));
  }, []);

  /** A draft with the name the form opens with. */
  const named = useCallback(
    async (draft: RuleDraft, bankText: string | null): Promise<RulePrefill> => {
      const payeeId =
        draft.payeeConditionId ??
        draft.setPayeeId ??
        (draft.taxonomyId === PAYEES_TAXONOMY_ID ? draft.categoryId : null);
      const payeeName = await categoryName(qc, t, PAYEES_TAXONOMY_ID, payeeId);
      return { ...draft, name: suggestedRuleName(payeeName, bankText) };
    },
    [qc, t],
  );

  const showSuggestion = useCallback(
    async (suggestion: RuleSuggestion) => {
      const payeeName = await categoryName(qc, t, PAYEES_TAXONOMY_ID, suggestion.payeeId);
      let title: string;
      let description: string;
      let actionLabel: string;
      let onAction: () => void;
      if (suggestion.kind === "update") {
        const { applied } = suggestion;
        title = t("spending:ruleSuggestion.updateTitle", {
          target: await categoryName(qc, t, applied.taxonomyId, applied.categoryId),
        });
        description = t("spending:ruleSuggestion.updateDescription", { rule: applied.rule.name });
        actionLabel = t("spending:ruleSuggestion.updateRule");
        onAction = () => openForm({ rule: applied.rule });
      } else {
        const { draft, bankText } = suggestion;
        const prefill = await named(draft, bankText);
        const target = await categoryName(qc, t, draft.taxonomyId, draft.categoryId);
        title = t("spending:ruleSuggestion.title");
        description = draft.payeeConditionId
          ? t("spending:ruleSuggestion.descPayee", { target, payee: payeeName })
          : draft.setPayeeId
            ? t("spending:ruleSuggestion.descTextWithPayee", {
                target,
                payee: payeeName,
                text: quoted(bankText),
              })
            : t("spending:ruleSuggestion.descText", { target, text: quoted(bankText) });
        actionLabel = t("spending:ruleSuggestion.createRule");
        onAction = () => openForm({ prefill });
      }
      // Asked again here: the names above took a moment to load.
      if (!mayOfferRuleSuggestion(readRuleSuggestionPreferences(), suggestion.payeeId)) return;
      const dismiss = () => toast.dismiss(TOAST_ID);
      const { payeeId } = suggestion;
      // The toast's close button dismisses this one suggestion, like any toast.
      toast(title, {
        id: TOAST_ID,
        duration: TOAST_DURATION_MS,
        closeButton: true,
        description: (
          <RuleSuggestionToast
            title={title}
            description={description}
            actionLabel={actionLabel}
            payeeName={payeeName || null}
            onAction={() => {
              dismiss();
              onAction();
            }}
            onSnooze={() => {
              snoozeRuleSuggestions();
              dismiss();
            }}
            onMutePayee={
              payeeId
                ? () => {
                    muteRuleSuggestionsForPayee(payeeId);
                    dismiss();
                  }
                : undefined
            }
          />
        ),
      });
    },
    [named, openForm, qc, t],
  );

  const suggestAfterEdit = useCallback(
    (activityIds: string[], edit: ManualEdit) => {
      if (activityIds.length === 0 || (!edit.category && !edit.payeeChanged)) return;
      // Switched off or snoozed: nothing is read, let alone shown.
      if (!ruleSuggestionsActive(readRuleSuggestionPreferences())) return;
      void (async () => {
        try {
          const explanations = await explainActivityRules(activityIds);
          // Every edited transaction has to be accounted for, or what they
          // share is not known.
          if (explanations.length !== activityIds.length) return;
          const suggestion = buildRuleSuggestion(explanations, edit);
          if (!suggestion) return;
          if (!mayOfferRuleSuggestion(readRuleSuggestionPreferences(), suggestion.payeeId)) return;
          await showSuggestion(suggestion);
        } catch {
          // The edit is saved; a suggestion that cannot be worked out is not offered.
        }
      })();
    },
    [showSuggestion],
  );

  const createRuleFor = useCallback<RuleSuggestions["createRuleFor"]>(
    (activityId, category) => {
      void (async () => {
        try {
          const [explained] = await explainActivityRules([activityId]);
          if (!explained) {
            toast.error(t("spending:ruleSuggestion.unavailable"));
            return;
          }
          const draft = ruleDraftForActivity(explained, category);
          openForm({ prefill: await named(draft, explained.bankText ?? null) });
        } catch {
          toast.error(t("spending:ruleSuggestion.unavailable"));
        }
      })();
    },
    [named, openForm, t],
  );

  const value = useMemo<RuleSuggestions>(
    () => ({ suggestAfterEdit, createRuleFor }),
    [suggestAfterEdit, createRuleFor],
  );

  return (
    <RuleSuggestionContext.Provider value={value}>
      {children}
      {formRequest && (
        <SuggestedRuleForm
          key={formRequest.key}
          request={formRequest}
          onClose={() => setFormRequest(null)}
          onSaved={setApplyPreview}
        />
      )}
      {applyPreview && (
        <ApplySuggestedRule preview={applyPreview} onClose={() => setApplyPreview(null)} />
      )}
    </RuleSuggestionContext.Provider>
  );
}

/**
 * The rule form, mounted only while it is open: what it offers (categories,
 * payees, accounts) is not loaded for a screen that never asks for it.
 *
 * Saving a rule elsewhere files the uncategorized transactions it matches at
 * once. A suggested rule is saved without that: the user is shown how many it
 * would file and decides (`RuleApplyDialog`). Declined, the rule waits for the
 * next import or rule run like any other.
 */
function SuggestedRuleForm({
  request,
  onClose,
  onSaved,
}: {
  request: RuleFormRequest;
  onClose: () => void;
  /** Called with what the saved rule would change, when that is anything. */
  onSaved: (preview: CategorizationRunSummary) => void;
}) {
  const { categoryOptions, accountOptions } = useRuleFormOptions();
  const save = useSaveRuleWithoutApplying();

  const handleSave = async (values: RuleFormValues) => {
    try {
      // Saved without being applied: whether to file what it matches is asked next.
      await save.mutateAsync({ rule: newRuleFromFormValues(values), id: request.rule?.id });
    } catch {
      // The mutation reports the error; the form stays open to try again.
      return;
    }
    onClose();
    try {
      const preview = await previewCategorizationRulesRerun(true);
      if (preview.eligible > 0) onSaved(preview);
    } catch {
      // The rule is saved; it applies on the next import or rerun.
    }
  };

  return (
    <RuleEditModal
      open
      onClose={onClose}
      rule={request.rule}
      prefill={request.prefill}
      categoryOptions={categoryOptions}
      accountOptions={accountOptions}
      onSave={handleSave}
      isLoading={save.isPending}
    />
  );
}

/** Runs the rules on what has no category yet, once the user says so. */
function ApplySuggestedRule({
  preview,
  onClose,
}: {
  preview: CategorizationRunSummary;
  onClose: () => void;
}) {
  const { rerun } = useCategorizationRuleMutations();
  return (
    <RuleApplyDialog
      preview={preview}
      isApplying={rerun.isPending}
      onApply={() => rerun.mutate(true, { onSettled: onClose })}
      onClose={onClose}
    />
  );
}
