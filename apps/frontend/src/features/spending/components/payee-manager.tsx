import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Icons,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@wealthfolio/ui";

import { useDeleteCategory, useUpdateCategory } from "@/hooks/use-taxonomies";
import { QueryKeys } from "@/lib/query-keys";
import type { TaxonomyCategory } from "@/lib/types";

import { invalidateSpendingCaches } from "../lib/invalidation";
import { cn } from "@/lib/utils";

import { getPayeeReferences, getPayeeUsage } from "../adapters/cash-activities";
import { listCategorizationRules } from "../adapters/rules";
import { useCategorizationRules } from "../hooks/use-categorization-rules";
import { ensurePayee, findPayee, PAYEES_TAXONOMY_ID } from "../lib/payee";
import { mergePayee } from "../lib/payee-merge";
import {
  countRulesByPayee,
  mergeRuleDraft,
  payeeConditionDraft,
  payeeRuleCoversTexts,
  RULES_PAGE_PATH,
  rulesForPayeePath,
  type BankTextSummary,
  type RuleDraft,
  type RulesPageState,
} from "../lib/payee-rules";

/** Query key of the per-payee transaction counts. */
const PAYEE_USAGE_KEY = "payee-usage";

interface PayeeManagerProps {
  payees: TaxonomyCategory[];
}

/**
 * The payees, by name, each with the number of transactions filed under it,
 * the rules that name it (or a way to create one), rename and delete. A payee still used by transactions or rules is not
 * deleted outright: it is merged into another one, which is also how two
 * spellings of the same payee are combined.
 */
export function PayeeManager({ payees }: PayeeManagerProps) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<TaxonomyCategory>();
  const [deleting, setDeleting] = useState<TaxonomyCategory>();
  const sorted = useMemo(() => [...payees].sort((a, b) => a.name.localeCompare(b.name)), [payees]);
  // Counts are a convenience: the list is usable while they load or if they fail.
  const usage = useQuery({ queryKey: [PAYEE_USAGE_KEY], queryFn: getPayeeUsage });
  // The rules that name each payee, counted from the rule list the rules page
  // filters with the same test, so a count and the page it opens agree.
  const rules = useCategorizationRules();
  const ruleCounts = useMemo(() => countRulesByPayee(rules.data ?? []), [rules.data]);
  const navigate = useNavigate();
  const openNewRule = (ruleDraft: RuleDraft) =>
    navigate(RULES_PAGE_PATH, { state: { ruleDraft } satisfies RulesPageState });

  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button size="sm" onClick={() => setAdding(true)}>
          <Icons.Plus className="me-2 h-3.5 w-3.5" />
          {t("settings:spending.payees.add")}
        </Button>
      </div>
      {sorted.length === 0 && (
        <div className="text-muted-foreground py-8 text-center text-sm">
          {t("settings:spending.payees.empty")}
        </div>
      )}
      <ul
        className={cn("divide-border divide-y rounded-md border", sorted.length === 0 && "hidden")}
        data-testid="payee-list"
      >
        {sorted.map((payee) => (
          <li key={payee.id} className="flex items-center gap-2 px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-sm">{payee.name}</span>
            {usage.data && (
              <span
                className="text-muted-foreground text-xs tabular-nums"
                title={t("settings:spending.payees.usage_title")}
              >
                {usage.data[payee.id] ?? 0}
              </span>
            )}
            {rules.data &&
              ((ruleCounts.get(payee.id) ?? 0) > 0 ? (
                <Link
                  to={rulesForPayeePath(payee.id)}
                  className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-sm text-xs tabular-nums underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:outline-none"
                  aria-label={t("settings:spending.payees.rules_for", {
                    count: ruleCounts.get(payee.id) ?? 0,
                    name: payee.name,
                  })}
                >
                  {t("settings:spending.payees.rules_count", {
                    count: ruleCounts.get(payee.id) ?? 0,
                  })}
                </Link>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground h-7 px-2 text-xs"
                  aria-label={t("settings:spending.payees.create_rule_for", { name: payee.name })}
                  onClick={() => void openNewRule(payeeConditionDraft(payee))}
                >
                  {t("settings:spending.payees.create_rule")}
                </Button>
              ))}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label={t("settings:spending.payees.rename", { name: payee.name })}
              onClick={() => setRenaming(payee)}
            >
              <Icons.Pencil className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label={t("settings:spending.payees.delete", { name: payee.name })}
              onClick={() => setDeleting(payee)}
            >
              <Icons.Trash className="h-4 w-4" />
            </Button>
          </li>
        ))}
      </ul>
      {adding && <PayeeNameDialog payees={payees} onClose={() => setAdding(false)} />}
      {renaming && (
        <PayeeNameDialog
          key={renaming.id}
          payee={renaming}
          payees={payees}
          onClose={() => setRenaming(undefined)}
        />
      )}
      {deleting && (
        <DeletePayeeDialog
          key={deleting.id}
          payee={deleting}
          others={sorted.filter((other) => other.id !== deleting.id)}
          onClose={() => setDeleting(undefined)}
          onCreateRule={(ruleDraft) => void openNewRule(ruleDraft)}
        />
      )}
    </>
  );
}

interface PayeeNameDialogProps {
  /** The payee to rename. Without one, the dialog adds a new payee. */
  payee?: TaxonomyCategory;
  payees: TaxonomyCategory[];
  onClose: () => void;
}

/** One name field: renames `payee`, or adds a payee when there is none. */
function PayeeNameDialog({ payee, payees, onClose }: PayeeNameDialogProps) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const update = useUpdateCategory();
  const add = useMutation({
    mutationFn: (name: string) => ensurePayee(name, payees),
    onSuccess: () => qc.invalidateQueries({ queryKey: QueryKeys.taxonomy(PAYEES_TAXONOMY_ID) }),
  });
  const pending = update.isPending || add.isPending;
  const [name, setName] = useState(payee?.name ?? "");
  const trimmed = name.trim();
  const namesake = findPayee(payees, trimmed);
  const taken = !!namesake && namesake.id !== payee?.id;
  const canSave = !pending && trimmed !== "" && !taken && trimmed !== payee?.name;

  const save = async () => {
    try {
      if (payee) {
        await update.mutateAsync({ ...payee, name: trimmed });
        toast.success(t("settings:spending.payees.renamed"));
      } else {
        await add.mutateAsync(trimmed);
        toast.success(t("settings:spending.payees.added"));
      }
      onClose();
    } catch {
      toast.error(t(`settings:spending.payees.${payee ? "rename_error" : "add_error"}`));
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t(`settings:spending.payees.${payee ? "rename_title" : "add"}`)}
          </DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave) void save();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="payee-name">{t("settings:spending.payees.name")}</Label>
            <Input
              id="payee-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
            {taken && (
              <p role="alert" className="text-destructive text-xs">
                {t("settings:spending.payees.name_taken")}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              {t("common:cancel")}
            </Button>
            <Button type="submit" disabled={!canSave}>
              {t("common:save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Whether a rule for the destination payee already lists every one of the
 * texts. Read after the merge, which has moved the merged payee's own rules
 * to the destination. Failing to read the rules leaves the offer standing.
 */
async function coveredByRule(destinationId: string, bankTexts: BankTextSummary): Promise<boolean> {
  try {
    return payeeRuleCoversTexts(await listCategorizationRules(), destinationId, bankTexts.texts);
  } catch {
    return false;
  }
}

interface DeletePayeeDialogProps {
  payee: TaxonomyCategory;
  /** The payees it could be merged into. */
  others: TaxonomyCategory[];
  onClose: () => void;
  /** Opens a new rule started from the draft a merge offers. */
  onCreateRule: (draft: RuleDraft) => void;
}

/** The rule a finished merge offers: the merged payee's bank texts, filed under the destination. */
interface MergeRuleOffer {
  destination: TaxonomyCategory;
  bankTexts: BankTextSummary;
}

function DeletePayeeDialog({ payee, others, onClose, onCreateRule }: DeletePayeeDialogProps) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [destinationId, setDestinationId] = useState<string>();
  const usage = useQuery({
    queryKey: ["payee-references", payee.id],
    queryFn: () => getPayeeReferences(payee.id),
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const remove = useDeleteCategory();
  const merge = useMutation({
    mutationFn: (destination: string) => mergePayee(payee.id, destination),
    // Also after a failure: a merge that stopped halfway has moved some rows.
    onSettled: () => {
      qc.invalidateQueries({ queryKey: QueryKeys.taxonomy(PAYEES_TAXONOMY_ID) });
      qc.invalidateQueries({ queryKey: [QueryKeys.SPENDING_RULES] });
      qc.invalidateQueries({ queryKey: [PAYEE_USAGE_KEY] });
      qc.invalidateQueries({ queryKey: [QueryKeys.ACTIVITIES] });
      invalidateSpendingCaches(qc);
    },
  });
  const [offer, setOffer] = useState<MergeRuleOffer>();
  const pending = remove.isPending || merge.isPending;
  const used = !!usage.data && (usage.data.transactions > 0 || usage.data.rules > 0);
  const destination = others.find((other) => other.id === destinationId);

  const confirm = async () => {
    try {
      if (used) {
        if (!destination) return;
        const bankTexts = await merge.mutateAsync(destination.id);
        toast.success(
          t("settings:spending.payees.merged", {
            name: payee.name,
            destination: destination.name,
          }),
        );
        // New transactions with the merged payee's bank texts would still
        // arrive without a payee. Offer a rule for them, unless there is
        // nothing to list or a rule for the destination lists them already.
        if (bankTexts.texts.length > 0 && !(await coveredByRule(destination.id, bankTexts))) {
          setOffer({ destination, bankTexts });
          return;
        }
      } else {
        await remove.mutateAsync({ taxonomyId: PAYEES_TAXONOMY_ID, categoryId: payee.id });
        toast.success(t("settings:spending.payees.deleted", { name: payee.name }));
      }
      onClose();
    } catch {
      toast.error(t("settings:spending.payees.delete_error"));
      void usage.refetch();
    }
  };

  if (offer) {
    const listed = offer.bankTexts.texts.length;
    return (
      <AlertDialog open onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings:spending.payees.merge_rule_title", {
                name: payee.name,
                destination: offer.destination.name,
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings:spending.payees.merge_rule_description", {
                count: listed,
                name: payee.name,
                destination: offer.destination.name,
              })}
              {offer.bankTexts.distinct > listed &&
                ` ${t("settings:spending.payees.merge_rule_capped", {
                  count: listed,
                  total: offer.bankTexts.distinct,
                })}`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t("settings:spending.payees.merge_rule_skip")}
            </Button>
            <Button
              onClick={() => {
                onCreateRule(mergeRuleDraft(offer.bankTexts.texts, offer.destination));
                onClose();
              }}
            >
              {t("settings:spending.payees.create_rule")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  return (
    <AlertDialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("settings:spending.payees.delete_title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {usage.isLoading
              ? t("common:loading")
              : usage.isError
                ? t("settings:spending.payees.usage_error")
                : used
                  ? t("settings:spending.payees.merge_description", {
                      name: payee.name,
                      transactions: usage.data?.transactions ?? 0,
                      rules: usage.data?.rules ?? 0,
                    })
                  : t("settings:spending.payees.delete_confirm", { name: payee.name })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {used &&
          (others.length > 0 ? (
            <div className="space-y-2 text-sm">
              <Label htmlFor="payee-merge-destination">
                {t("settings:spending.payees.merge_destination")}
              </Label>
              <Select
                value={destinationId ?? ""}
                disabled={pending}
                onValueChange={(value) => setDestinationId(value ?? undefined)}
              >
                <SelectTrigger id="payee-merge-destination" className="w-full">
                  <SelectValue placeholder={t("settings:spending.payees.merge_choose")}>
                    {destination?.name}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {others.map((other) => (
                    <SelectItem key={other.id} value={other.id}>
                      {other.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              {t("settings:spending.payees.merge_none")}
            </p>
          ))}
        <AlertDialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            {t("common:cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={pending || !usage.data || (used && !destination)}
            onClick={confirm}
          >
            {used ? t("settings:spending.payees.merge_confirm") : t("common:delete")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
