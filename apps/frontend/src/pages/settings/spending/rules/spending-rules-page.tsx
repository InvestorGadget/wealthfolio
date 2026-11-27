import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icons,
  Input,
  Skeleton,
  Spinner,
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@wealthfolio/ui";
import { cn } from "@/lib/utils";
import { useAccounts } from "@/hooks/use-accounts";
import { useTaxonomy } from "@/hooks/use-taxonomies";

import { RuleEditModal } from "@/features/spending/components/rule-edit-modal";
import {
  RuleItem,
  type RuleCategoryMeta,
  type RulePresetMeta,
} from "@/features/spending/components/rule-item";
import { PRESET_FLAGS } from "@/features/spending/components/rule-preset-constants";
import { RulePresetPicker } from "@/features/spending/components/rule-preset-picker";
import {
  newRuleFromFormValues,
  type RuleFormValues,
} from "@/features/spending/components/rule-form";
import { PAYEES_TAXONOMY_ID } from "@/features/spending/lib/payee";
import {
  ruleNamesPayee,
  RULES_PAYEE_PARAM,
  type RulesPageState,
} from "@/features/spending/lib/payee-rules";
import { hasTextCondition, parseAnyOfPattern } from "@/features/spending/lib/rule-conditions";
import {
  useCategorizationRuleMutations,
  useCategorizationRules,
  useRulePresets,
} from "@/features/spending/hooks/use-categorization-rules";
import { useRuleFormOptions } from "@/features/spending/hooks/use-rule-form-options";
import { useSpendingSettings } from "@/features/spending/hooks/use-spending-settings";
import type { CategorizationRule, RuleDraft } from "@/features/spending/types/rule";

import { SettingsHeader } from "../../settings-header";
import { SpendingBackLink } from "../components/spending-back-link";

const SPENDING_TAXONOMY = "spending_categories";
const INCOME_TAXONOMY = "income_sources";
const SAVINGS_TAXONOMY = "savings_categories";

export default function SpendingRulesPage() {
  const { t } = useTranslation();
  const { isEnabled, isLoading: settingsLoading } = useSpendingSettings();
  const { accounts } = useAccounts({ filterActive: false });
  const {
    data: rules = [],
    isLoading: rulesLoading,
    isError: rulesErrored,
    error: rulesError,
  } = useCategorizationRules();
  const { data: presets = [], isError: presetsErrored, error: presetsError } = useRulePresets();
  const spending = useTaxonomy(SPENDING_TAXONOMY);
  const income = useTaxonomy(INCOME_TAXONOMY);
  const savings = useTaxonomy(SAVINGS_TAXONOMY);
  const payees = useTaxonomy(PAYEES_TAXONOMY_ID);
  const { create, update, remove, rerun } = useCategorizationRuleMutations();

  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // `?payee=<id>` narrows the list to the rules that name that payee.
  const payeeFilter = searchParams.get(RULES_PAYEE_PARAM);
  const clearPayeeFilter = () => {
    setSearchParams(
      (params) => {
        const next = new URLSearchParams(params);
        next.delete(RULES_PAYEE_PARAM);
        return next;
      },
      { replace: true },
    );
  };

  // Another screen can open this one on a new rule it proposes (see
  // `RulesPageState`): the form starts from that draft.
  const [ruleDraft, setRuleDraft] = useState<RuleDraft | undefined>(
    () => (location.state as RulesPageState | null)?.ruleDraft,
  );
  const [visibleModal, setVisibleModal] = useState(ruleDraft !== undefined);
  const [selectedRule, setSelectedRule] = useState<CategorizationRule | undefined>();
  // A screen that stays mounted (the mobile stack keeps screens in a hidden
  // `<Activity>`) can be handed a new location: a draft that arrives with one
  // opens the form as on the first render.
  const [draftLocationKey, setDraftLocationKey] = useState(location.key);
  if (draftLocationKey !== location.key) {
    setDraftLocationKey(location.key);
    const incoming = (location.state as RulesPageState | null)?.ruleDraft;
    if (incoming) {
      setRuleDraft(incoming);
      setSelectedRule(undefined);
      setVisibleModal(true);
    }
  }
  const closeModal = () => {
    setVisibleModal(false);
    if ((location.state as RulesPageState | null)?.ruleDraft) {
      // Dropped from the history entry too, so coming back does not reopen it.
      void navigate({ search: location.search }, { replace: true, state: null });
    }
  };
  const [searchQuery, setSearchQuery] = useState("");
  // `presetFilter`: null = all, presetId = installed preset, "custom" = user-created rules.
  const [presetFilter, setPresetFilter] = useState<string | null>(null);
  const [confirmRerunAllOpen, setConfirmRerunAllOpen] = useState(false);

  const isLoading =
    rulesLoading || spending.isLoading || income.isLoading || savings.isLoading || payees.isLoading;
  const hasLoadError =
    rulesErrored ||
    presetsErrored ||
    spending.isError ||
    income.isError ||
    savings.isError ||
    payees.isError;
  const loadError =
    rulesError?.message ??
    presetsError?.message ??
    spending.error?.message ??
    income.error?.message ??
    savings.error?.message ??
    payees.error?.message ??
    t("settings:spending.rules.load_error");

  const { categoryOptions, accountOptions } = useRuleFormOptions();
  const categoryMeta = useMemo(() => {
    const meta: Record<string, RuleCategoryMeta> = {};
    categoryOptions.forEach((o) => {
      const entry = {
        name: o.label,
        color: o.color ?? null,
        parentName: o.parentName ?? null,
      };
      meta[o.value] = entry;
      meta[o.categoryId] ??= entry;
    });
    return meta;
  }, [categoryOptions]);

  const presetMeta = useMemo<Record<string, RulePresetMeta>>(() => {
    const meta: Record<string, RulePresetMeta> = {};
    presets.forEach((p) => {
      meta[p.presetId] = {
        name: p.name,
        flag: PRESET_FLAGS[p.presetId] ?? "🌐",
      };
    });
    return meta;
  }, [presets]);

  // Names cover every account, not just the pickable ones, so a rule scoped to
  // an account the user has since untracked still renders a real name.
  const accountMeta = useMemo(() => {
    const meta: Record<string, string> = {};
    accounts.forEach((a) => {
      meta[a.id] = a.name;
    });
    return meta;
  }, [accounts]);

  if (!settingsLoading && !isEnabled) {
    return <Navigate to="/settings/spending" replace />;
  }

  const handleAddRule = () => {
    setSelectedRule(undefined);
    setRuleDraft(undefined);
    setVisibleModal(true);
  };

  const handleEditRule = (rule: CategorizationRule) => {
    setSelectedRule(rule);
    setVisibleModal(true);
  };

  const handleDeleteRule = (rule: CategorizationRule) => {
    remove.mutate(rule.id);
  };

  const handleSave = async (values: RuleFormValues) => {
    // Every field is sent explicitly, on an update too: null clears a payee,
    // an amount condition or the account, and the backend rejects an
    // isGlobal/accountId pair that disagrees.
    const rule = newRuleFromFormValues(values);
    try {
      if (selectedRule) {
        await update.mutateAsync({ id: selectedRule.id, patch: rule });
      } else {
        await create.mutateAsync(rule);
      }
      closeModal();
    } catch {
      // The mutation reports the error; the modal stays open to try again.
    }
  };

  const installedPresets = useMemo(() => presets.filter((p) => p.installed), [presets]);

  const filteredRules = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return [...rules]
      .sort((a, b) => b.priority - a.priority)
      .filter((rule) => {
        if (payeeFilter && !ruleNamesPayee(rule, payeeFilter)) return false;
        if (presetFilter === "custom" && rule.presetId) return false;
        if (presetFilter && presetFilter !== "custom" && rule.presetId !== presetFilter)
          return false;
        if (!query) return true;
        const name = rule.name?.toLowerCase() ?? "";
        // The text as the rule shows it: nothing for a payee-only rule, and
        // the texts of a list in place of the regex they are stored as.
        const pattern = hasTextCondition(rule) ? rule.pattern.toLowerCase() : "";
        const listed =
          rule.matchType === "regex" ? (parseAnyOfPattern(rule.pattern)?.items ?? []) : [];
        const payees = [rule.payeeConditionId, rule.setPayeeId].map((payeeId) =>
          payeeId ? (categoryMeta[`${PAYEES_TAXONOMY_ID}:${payeeId}`]?.name ?? "") : "",
        );
        return [name, pattern, ...listed, ...payees].some((text) =>
          text.toLowerCase().includes(query),
        );
      });
  }, [rules, searchQuery, presetFilter, payeeFilter, categoryMeta]);

  const customRulesCount = useMemo(() => rules.filter((r) => !r.presetId).length, [rules]);
  const totalRulesCount = rules.length;

  return (
    <>
      <div className="space-y-6">
        <SpendingBackLink />
        <SettingsHeader
          heading={t("settings:spending.rules.heading")}
          text={t("settings:spending.rules.text")}
          backTo="/settings/spending"
        >
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={rerun.isPending || rules.length === 0}
                  />
                }
              >
                {rerun.isPending ? (
                  <Spinner className="me-2 h-3.5 w-3.5" />
                ) : (
                  <Icons.Refresh className="me-2 h-3.5 w-3.5" />
                )}
                {t("settings:spending.rules.rerun")}
                <Icons.ChevronDown className="ms-2 h-3.5 w-3.5 opacity-60" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72">
                <DropdownMenuItem
                  onClick={() => rerun.mutate(true)}
                  className="flex-col items-start gap-0.5"
                >
                  <span className="text-sm font-medium">
                    {t("settings:spending.rules.rerun_uncategorized")}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {t("settings:spending.rules.rerun_uncategorized_desc")}
                  </span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  closeOnClick={false}
                  onClick={() => {
                    setConfirmRerunAllOpen(true);
                  }}
                  className="flex-col items-start gap-0.5"
                >
                  <span className="text-sm font-medium">
                    {t("settings:spending.rules.recategorize_all")}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {t("settings:spending.rules.recategorize_all_desc")}
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              size="sm"
              className="sm:hidden"
              onClick={handleAddRule}
              aria-label={t("settings:spending.rules.add")}
            >
              <Icons.Plus className="h-3.5 w-3.5" />
            </Button>
            <Button size="sm" className="hidden sm:inline-flex" onClick={handleAddRule}>
              <Icons.Plus className="me-2 h-3.5 w-3.5" />
              {t("settings:spending.rules.add")}
            </Button>
          </div>
        </SettingsHeader>

        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : hasLoadError ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Icons.AlertTriangle />
              </EmptyMedia>
              <EmptyTitle>{t("settings:spending.rules.error_title")}</EmptyTitle>
              <EmptyDescription>{loadError}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : totalRulesCount === 0 ? (
          <div className="space-y-6">
            <div className="bg-muted/30 rounded-lg border p-4">
              <RulePresetPicker />
            </div>
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Icons.ListFilter />
                </EmptyMedia>
                <EmptyTitle>{t("settings:spending.rules.empty_title")}</EmptyTitle>
                <EmptyDescription>
                  {t("settings:spending.rules.empty_description")}
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button variant="outline" onClick={handleAddRule}>
                  <Icons.Plus className="me-2 h-4 w-4" />
                  {t("settings:spending.rules.add_manually")}
                </Button>
              </EmptyContent>
            </Empty>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="bg-muted/30 rounded-md border p-3">
              <RulePresetPicker compact />
            </div>

            {/* Search + preset filter chips */}
            <div className="space-y-2">
              <div className="relative">
                <Icons.Search className="text-muted-foreground/60 absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
                <Input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t("settings:spending.rules.search_placeholder")}
                  className="bg-muted/40 border-border/60 placeholder:text-muted-foreground/60 h-7 ps-8 text-xs"
                  aria-label={t("settings:spending.rules.search_aria")}
                />
              </div>

              {(installedPresets.length > 0 || customRulesCount > 0) && (
                <div className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-1">
                  <FilterChip
                    label={t("settings:spending.rules.filter_all")}
                    count={totalRulesCount}
                    active={presetFilter === null}
                    onClick={() => setPresetFilter(null)}
                  />
                  {installedPresets.map((p) => (
                    <FilterChip
                      key={p.presetId}
                      label={`${PRESET_FLAGS[p.presetId] ?? "🌐"} ${p.name}`}
                      count={rules.filter((r) => r.presetId === p.presetId).length}
                      active={presetFilter === p.presetId}
                      onClick={() => setPresetFilter(p.presetId)}
                    />
                  ))}
                  {customRulesCount > 0 && (
                    <FilterChip
                      label={t("settings:spending.rules.filter_custom")}
                      count={customRulesCount}
                      active={presetFilter === "custom"}
                      onClick={() => setPresetFilter("custom")}
                    />
                  )}
                </div>
              )}
            </div>

            {payeeFilter && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">
                  {t("settings:spending.rules.payee_filter", {
                    name:
                      categoryMeta[`${PAYEES_TAXONOMY_ID}:${payeeFilter}`]?.name ??
                      t("spending:rules.unknownPayee"),
                  })}
                </span>
                <Button variant="ghost" size="sm" className="h-6 px-2" onClick={clearPayeeFilter}>
                  <Icons.Close className="me-1 h-3 w-3" aria-hidden="true" />
                  {t("settings:spending.rules.payee_filter_clear")}
                </Button>
              </div>
            )}

            {filteredRules.length === 0 ? (
              <div className="text-muted-foreground rounded-md border border-dashed py-8 text-center text-sm">
                {searchQuery
                  ? t("settings:spending.rules.no_match_query", { query: searchQuery })
                  : t("settings:spending.rules.no_match_filter")}{" "}
                <button
                  type="button"
                  className="text-foreground underline-offset-2 hover:underline"
                  onClick={() => {
                    setSearchQuery("");
                    setPresetFilter(null);
                    if (payeeFilter) clearPayeeFilter();
                  }}
                >
                  {t("settings:spending.rules.clear_filters")}
                </button>
                .
              </div>
            ) : (
              <div className="divide-border divide-y rounded-md border">
                {filteredRules.map((rule) => (
                  <RuleItem
                    key={rule.id}
                    rule={rule}
                    categoryMeta={categoryMeta}
                    presetMeta={presetMeta}
                    accountMeta={accountMeta}
                    onEdit={handleEditRule}
                    onDelete={handleDeleteRule}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <RuleEditModal
        open={visibleModal}
        onClose={closeModal}
        rule={selectedRule}
        draft={selectedRule ? undefined : ruleDraft}
        categoryOptions={categoryOptions}
        accountOptions={accountOptions}
        onSave={handleSave}
        isLoading={create.isPending || update.isPending}
      />

      <AlertDialog open={confirmRerunAllOpen} onOpenChange={setConfirmRerunAllOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings:spending.rules.recategorize_confirm_title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings:spending.rules.recategorize_confirm_desc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => rerun.mutate(false)} variant="destructive">
              {t("settings:spending.rules.recategorize_all")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-foreground text-background border-foreground"
          : "border-border bg-card text-muted-foreground hover:text-foreground hover:bg-muted/50",
      )}
    >
      <span>{label}</span>
      <span
        className={cn("tabular-nums", active ? "text-background/60" : "text-muted-foreground/70")}
      >
        {count}
      </span>
    </button>
  );
}
