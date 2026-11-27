import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { useAccounts } from "@/hooks/use-accounts";
import { useNameComparator } from "@/hooks/use-name-comparator";
import { useTaxonomy } from "@/hooks/use-taxonomies";
import { getCategoryLabel } from "@/lib/taxonomy-labels";
import type { TaxonomyCategory } from "@/lib/types";

import type { RuleFormAccountOption, RuleFormCategoryOption } from "../components/rule-form";
import { isSpendingAccountType } from "../lib/constants";
import { PAYEES_TAXONOMY_ID } from "../lib/payee";
import { useSpendingSettings } from "./use-spending-settings";

const SPENDING_TAXONOMY = "spending_categories";
const INCOME_TAXONOMY = "income_sources";
const SAVINGS_TAXONOMY = "savings_categories";

/**
 * What the rule form offers: every category a rule can set, the payees, and
 * the accounts a rule can be scoped to.
 */
export function useRuleFormOptions(): {
  categoryOptions: RuleFormCategoryOption[];
  accountOptions: RuleFormAccountOption[];
} {
  const { t } = useTranslation();
  const compareNames = useNameComparator();
  const { accountIds } = useSpendingSettings();
  const { accounts } = useAccounts({ filterActive: false });
  const spending = useTaxonomy(SPENDING_TAXONOMY);
  const income = useTaxonomy(INCOME_TAXONOMY);
  const savings = useTaxonomy(SAVINGS_TAXONOMY);
  const payees = useTaxonomy(PAYEES_TAXONOMY_ID);

  const categoryOptions = useMemo(() => {
    const buildOptions = (taxonomyId: string, cats: TaxonomyCategory[]) => {
      const byId = new Map(cats.map((c) => [c.id, c]));
      return cats
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((c) => {
          const parent = c.parentId ? byId.get(c.parentId) : null;
          return {
            value: `${taxonomyId}:${c.id}`,
            label: getCategoryLabel(t, taxonomyId, c.id, c.name),
            taxonomyId,
            categoryId: c.id,
            color: c.color,
            icon: c.icon ?? null,
            parentName: parent ? getCategoryLabel(t, taxonomyId, parent.id, parent.name) : null,
          } satisfies RuleFormCategoryOption;
        });
    };
    return [
      ...buildOptions(SPENDING_TAXONOMY, spending.data?.categories ?? []),
      ...buildOptions(INCOME_TAXONOMY, income.data?.categories ?? []),
      ...buildOptions(SAVINGS_TAXONOMY, savings.data?.categories ?? []),
      ...buildOptions(PAYEES_TAXONOMY_ID, payees.data?.categories ?? []),
    ];
  }, [
    spending.data?.categories,
    income.data?.categories,
    savings.data?.categories,
    payees.data?.categories,
    t,
  ]);

  const accountOptions = useMemo(() => {
    // Only tracked spending accounts are offered: a rerun walks just those
    // accounts, so a rule scoped anywhere else could never fire.
    const tracked = new Set(accountIds);
    return accounts
      .filter((a) => isSpendingAccountType(a.accountType) && tracked.has(a.id))
      .map((a) => ({ id: a.id, name: a.name }))
      .sort((a, b) => compareNames(a.name, b.name));
  }, [accounts, accountIds, compareNames]);

  return { categoryOptions, accountOptions };
}
