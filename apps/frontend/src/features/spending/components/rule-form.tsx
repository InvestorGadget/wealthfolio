import { zodResolver } from "@hookform/resolvers/zod";
import { useId, useMemo, useState, type ComponentProps } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import * as z from "zod";

import {
  Button,
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Icons,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Textarea,
} from "@wealthfolio/ui";

import { findPayee, PAYEES_TAXONOMY_ID } from "../lib/payee";
import {
  isAnyOfMode,
  MAX_REGEX_PATTERN_LENGTH,
  storedTextCondition,
  textConditionDraft,
  type TextConditionMode,
} from "../lib/rule-conditions";
import type { RulePrefill } from "../lib/rule-suggestion";
import type {
  CategorizationRule,
  NewCategorizationRule,
  RuleAmountOp,
  RuleMatchType,
} from "../types/rule";
import { CategoryIconTile } from "./category-chips";
import { PayeeCommand } from "./payee-field";
import { QuickCategorizePopover } from "./quick-categorize-popover";

/** What the form hands back: the rule as it is saved. */
export interface RuleFormValues {
  name: string;
  /** The stored text condition. Empty when the rule matches on a payee alone. */
  pattern: string;
  matchType: RuleMatchType;
  taxonomyId?: string;
  categoryId?: string;
  activityType?: string;
  /** "" = no amount condition ("Any amount"). */
  amountOp: "" | RuleAmountOp;
  /** Raw input strings; converted to numbers by the save handler. */
  amountValue: string;
  amountValue2: string;
  priority: number;
  /** null applies the rule to every account; a value scopes it to that account. */
  accountId: string | null;
  /** The payee the rule matches on, or null for any. */
  payeeConditionId: string | null;
  /** The payee a category rule also sets, or null for none. */
  setPayeeId: string | null;
}

/**
 * The form's own state. The text condition is kept as it is edited: a match
 * type that can also be one of the two list modes, and the list's texts, one
 * per line. It is compiled to `pattern` and `matchType` when the form is
 * submitted (see `storedTextCondition`).
 */
export interface RuleFormState extends Omit<RuleFormValues, "matchType"> {
  matchType: TextConditionMode;
  patternList: string;
}

const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

/** Whether the composite `<taxonomyId>:<categoryId>` target is a payee. */
const targetsPayee = (target?: string): boolean => !!target?.startsWith(`${PAYEES_TAXONOMY_ID}:`);

const parseAmount = (raw: string): number | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
};

/** Map form amount values to the wire payload. "" ("Any amount") sends
 * explicit nulls so an existing condition is cleared on update. */
export function ruleAmountPayload(
  values: Pick<RuleFormValues, "amountOp" | "amountValue" | "amountValue2">,
): {
  amountOp: RuleAmountOp | null;
  amountValue: number | null;
  amountValue2: number | null;
} {
  const amountOp = values.amountOp || null;
  return {
    amountOp,
    amountValue: amountOp ? parseAmount(values.amountValue) : null,
    amountValue2: amountOp === "between" ? parseAmount(values.amountValue2) : null,
  };
}

/** The rule a filled-in form creates. */
export function newRuleFromFormValues(values: RuleFormValues): NewCategorizationRule {
  return {
    name: values.name,
    pattern: values.pattern,
    matchType: values.matchType,
    taxonomyId: values.taxonomyId || null,
    categoryId: values.categoryId || null,
    activityType: values.activityType || null,
    ...ruleAmountPayload(values),
    payeeConditionId: values.payeeConditionId,
    setPayeeId: values.setPayeeId,
    priority: values.priority,
    isGlobal: values.accountId === null,
    accountId: values.accountId,
  };
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

interface RuleFormSchemaOptions {
  /**
   * The rule being edited is a catch-all an earlier version saved with an
   * empty pattern. It may keep it; a new rule needs a text or a payee.
   */
  keepsEmptyPattern?: boolean;
}

export const buildRuleFormSchema = (
  t: Translate,
  { keepsEmptyPattern = false }: RuleFormSchemaOptions = {},
) =>
  z
    .object({
      name: z.string().min(1, t("spending:rules.nameRequired")),
      pattern: z.string(),
      patternList: z.string(),
      matchType: z.enum(["contains", "starts_with", "exact", "regex", "any_contains", "any_exact"]),
      taxonomyId: z.string().optional(),
      categoryId: z.string().optional(),
      activityType: z.string().optional(),
      amountOp: z.enum(["", "eq", "gt", "gte", "lt", "lte", "between"]),
      amountValue: z.string(),
      amountValue2: z.string(),
      priority: z.coerce
        .number()
        .int(t("spending:rules.priorityInvalid"))
        .min(0, t("spending:rules.priorityInvalid")),
      accountId: z.string().nullable(),
      payeeConditionId: z.string().nullable(),
      setPayeeId: z.string().nullable(),
    })
    .refine((data) => data.categoryId || data.activityType, {
      message: t("spending:rules.categoryOrTypeRequired"),
      path: ["categoryId"],
    })
    .superRefine((data, ctx) => {
      // A rule matches on a text, on a payee, or on both: never on neither.
      const listMode = isAnyOfMode(data.matchType);
      const textPath = [listMode ? "patternList" : "pattern"];
      const stored = storedTextCondition({
        mode: data.matchType,
        pattern: data.pattern,
        list: data.patternList,
      });
      if (!stored.pattern.trim() && !data.payeeConditionId && !keepsEmptyPattern) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t("spending:rules.conditionRequired"),
          path: textPath,
        });
      } else if (listMode && utf8Length(stored.pattern) > MAX_REGEX_PATTERN_LENGTH) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t("spending:rules.patternListTooLong"),
          path: textPath,
        });
      }
      // A rule that matches on a payee runs after the payees are set, so it
      // cannot set one itself.
      if (data.payeeConditionId && targetsPayee(data.categoryId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t("spending:rules.payeeConditionWithPayeeTarget"),
          path: ["categoryId"],
        });
      }
    })
    .superRefine((data, ctx) => {
      if (!data.amountOp) return;
      const value = parseAmount(data.amountValue);
      if (value === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t("spending:rules.amountValueRequired"),
          path: ["amountValue"],
        });
      } else if (value < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t("spending:rules.amountValueInvalid"),
          path: ["amountValue"],
        });
      }
      if (data.amountOp !== "between") return;
      const value2 = parseAmount(data.amountValue2);
      if (value2 === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t("spending:rules.amountValueRequired"),
          path: ["amountValue2"],
        });
      } else if (value2 < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t("spending:rules.amountValueInvalid"),
          path: ["amountValue2"],
        });
      } else if (value !== null && value >= 0 && value > value2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t("spending:rules.amountFromToError"),
          path: ["amountValue2"],
        });
      }
    });

export interface RuleFormCategoryOption {
  /** Composite "<taxonomyId>:<categoryId>" so the form can encode both. */
  value: string;
  label: string;
  taxonomyId: string;
  categoryId: string;
  color?: string | null;
  icon?: string | null;
  parentName?: string | null;
}

export interface RuleFormAccountOption {
  id: string;
  name: string;
}

interface RuleFormProps {
  rule?: CategorizationRule;
  /** What a new rule's form opens with. Ignored when `rule` is being edited. */
  prefill?: RulePrefill;
  /** Flat list of what a rule can set: spending, income and savings categories, and payees. */
  categoryOptions: RuleFormCategoryOption[];
  /** Tracked spending accounts the rule can be scoped to. */
  accountOptions: RuleFormAccountOption[];
  onSubmit: (values: RuleFormValues) => void;
  onCancel: () => void;
  isLoading?: boolean;
}

const NONE = "__none__";
const ALL_ACCOUNTS = "__all__";

const composite = (rule?: Pick<CategorizationRule, "taxonomyId" | "categoryId">): string => {
  if (rule?.taxonomyId && rule?.categoryId) return `${rule.taxonomyId}:${rule.categoryId}`;
  return "";
};

interface RulePayeeOption {
  id: string;
  name: string;
}

interface RulePayeePickerProps {
  /** The picked payee's id, or null for none. */
  value: string | null;
  onChange: (payeeId: string | null) => void;
  payees: RulePayeeOption[];
  placeholder: string;
  labelId: string;
}

/**
 * Picks one existing payee, by the searchable list the transaction form uses.
 * Rendered inside `FormControl`, which hands the trigger its id (for the
 * label), `aria-describedby` (hint and error) and `aria-invalid`. Its name is
 * the label followed by the picked payee.
 */
function RulePayeePicker({
  value,
  onChange,
  payees,
  placeholder,
  labelId,
  ...controlProps
}: RulePayeePickerProps &
  Pick<ComponentProps<"button">, "id" | "ref" | "aria-describedby" | "aria-invalid">) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const valueId = useId();
  // A rule can name a payee that has since been deleted on another device.
  // It keeps its place so the id survives a save untouched.
  const name = value
    ? (payees.find((payee) => payee.id === value)?.name ?? t("spending:rules.unknownPayee"))
    : "";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            {...controlProps}
            type="button"
            variant="field"
            aria-labelledby={`${labelId} ${valueId}`}
            className="w-full justify-between"
          />
        }
      >
        <span
          id={valueId}
          className={name ? "min-w-0 truncate" : "text-muted-foreground min-w-0 truncate"}
        >
          {name || placeholder}
        </span>
        <Icons.ChevronDown className="ms-2 h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent className="w-70 p-0" align="start">
        <PayeeCommand
          value={name}
          payees={payees}
          allowAdd={false}
          onPick={(picked) => {
            onChange(picked ? (findPayee(payees, picked)?.id ?? null) : null);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

export function RuleForm({
  rule,
  prefill,
  categoryOptions,
  accountOptions,
  onSubmit,
  onCancel,
  isLoading,
}: RuleFormProps) {
  const { t } = useTranslation();

  // A catch-all an earlier version saved (an empty pattern, no payee) can be
  // edited without giving it a text.
  const keepsEmptyPattern = !!rule && rule.pattern.trim() === "" && !rule.payeeConditionId;
  const ruleFormSchema = useMemo(
    () => buildRuleFormSchema(t, { keepsEmptyPattern }),
    [t, keepsEmptyPattern],
  );

  const AMOUNT_OP_OPTIONS = useMemo<{ value: RuleAmountOp; label: string }[]>(
    () => [
      { value: "eq", label: t("spending:rules.amountExactly") },
      { value: "gt", label: t("spending:rules.amountGreaterThan") },
      { value: "gte", label: t("spending:rules.amountGreaterOrEqual") },
      { value: "lt", label: t("spending:rules.amountLessThan") },
      { value: "lte", label: t("spending:rules.amountLessOrEqual") },
      { value: "between", label: t("spending:rules.amountBetween") },
    ],
    [t],
  );

  const ACTIVITY_TYPE_OPTIONS = useMemo(
    () => [
      { value: "DEPOSIT", label: t("spending:rules.activityDeposit") },
      { value: "WITHDRAWAL", label: t("spending:rules.activityWithdrawal") },
      { value: "CREDIT", label: t("spending:rules.activityCredit") },
      { value: "INTEREST", label: t("spending:rules.activityInterest") },
      { value: "DIVIDEND", label: t("spending:rules.activityDividend") },
      { value: "FEE", label: t("spending:rules.activityFee") },
      { value: "TAX", label: t("spending:rules.activityTax") },
      { value: "TRANSFER_IN", label: t("spending:rules.activityTransferIn") },
      { value: "TRANSFER_OUT", label: t("spending:rules.activityTransferOut") },
    ],
    [t],
  );

  const MATCH_TYPE_OPTIONS = useMemo<{ value: TextConditionMode; label: string }[]>(
    () => [
      { value: "contains", label: t("spending:rules.matchContainsLabel") },
      { value: "starts_with", label: t("spending:rules.matchStartsWithLabel") },
      { value: "exact", label: t("spending:rules.matchExactLabel") },
      { value: "any_contains", label: t("spending:rules.matchAnyContainsLabel") },
      { value: "any_exact", label: t("spending:rules.matchAnyExactLabel") },
      { value: "regex", label: t("spending:rules.matchRegexLabel") },
    ],
    [t],
  );

  const payeeOptions = useMemo<RulePayeeOption[]>(
    () =>
      categoryOptions
        .filter((option) => option.taxonomyId === PAYEES_TAXONOMY_ID)
        .map((option) => ({ id: option.categoryId, name: option.label })),
    [categoryOptions],
  );
  const payeeConditionLabelId = useId();
  const setPayeeLabelId = useId();

  // The stored text condition as the form edits it: a payee-only rule shows
  // an empty text, never its placeholder, and a compiled list shows the list.
  // A new rule can open filled in; the user still reviews and saves it.
  const seed = rule ?? prefill;
  const initialText = useMemo(() => textConditionDraft(seed), [seed]);

  const form = useForm<RuleFormState>({
    resolver: zodResolver(ruleFormSchema) as never,
    defaultValues: {
      name: seed?.name ?? "",
      pattern: initialText.pattern,
      patternList: initialText.list,
      matchType: initialText.mode,
      payeeConditionId: seed?.payeeConditionId ?? null,
      setPayeeId: seed?.setPayeeId ?? null,
      taxonomyId: seed?.taxonomyId ?? "",
      categoryId: composite(seed), // we encode taxonomyId:categoryId in this single field
      activityType: rule?.activityType ?? "",
      amountOp: rule?.amountOp ?? "",
      amountValue: rule?.amountValue != null ? String(rule.amountValue) : "",
      amountValue2: rule?.amountValue2 != null ? String(rule.amountValue2) : "",
      priority: rule?.priority ?? 0,
      accountId: rule && !rule.isGlobal ? (rule.accountId ?? null) : null,
    },
  });

  const amountOp = form.watch("amountOp");
  const matchMode = form.watch("matchType");
  const payeeConditionId = form.watch("payeeConditionId");
  const target = form.watch("categoryId");
  // Only a rule that sets a category can also set a payee, and not one that
  // matches on a payee.
  const canAlsoSetPayee = !!target && !targetsPayee(target) && !payeeConditionId;

  // A rule can reference an account that is no longer tracked (or is archived and
  // so absent from accountOptions). Keep it in the list so the trigger isn't blank
  // and the id survives a save untouched.
  const scopeOptions = useMemo(() => {
    const scopedId = rule && !rule.isGlobal ? rule.accountId : null;
    if (!scopedId || accountOptions.some((account) => account.id === scopedId)) {
      return accountOptions;
    }
    return [...accountOptions, { id: scopedId, name: t("spending:rules.unknownAccount") }];
  }, [accountOptions, rule, t]);

  const handleSubmit = ({ patternList, ...values }: RuleFormState) => {
    // Decode composite categoryId back into taxonomyId + categoryId
    let taxonomyId = "";
    let categoryId = "";
    if (values.categoryId?.includes(":")) {
      const [tax, cat] = values.categoryId.split(":");
      taxonomyId = tax;
      categoryId = cat;
    }
    const alsoSetsPayee =
      !!categoryId && taxonomyId !== PAYEES_TAXONOMY_ID && !values.payeeConditionId;
    onSubmit({
      ...values,
      ...storedTextCondition({
        mode: values.matchType,
        pattern: values.pattern,
        list: patternList,
      }),
      taxonomyId,
      categoryId,
      // Dropped with the field when the rule can no longer set one.
      setPayeeId: alsoSetsPayee ? values.setPayeeId : null,
    });
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit as never)} className="space-y-4">
        <FormField
          control={form.control as never}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("spending:rules.ruleName")}</FormLabel>
              <FormControl>
                <Input placeholder={t("spending:rules.ruleNamePlaceholder")} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control as never}
          name="matchType"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("spending:rules.matchType")}</FormLabel>
              <Select
                items={MATCH_TYPE_OPTIONS}
                onValueChange={field.onChange}
                defaultValue={field.value}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder={t("spending:rules.selectMatchType")} />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {MATCH_TYPE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        {isAnyOfMode(matchMode) ? (
          <FormField
            control={form.control as never}
            name="patternList"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("spending:rules.patternList")}</FormLabel>
                <FormControl>
                  <Textarea
                    rows={4}
                    placeholder={t("spending:rules.patternListPlaceholder")}
                    {...field}
                  />
                </FormControl>
                <FormDescription>
                  {matchMode === "any_exact"
                    ? t("spending:rules.patternListExactHint")
                    : t("spending:rules.patternListContainsHint")}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        ) : (
          <FormField
            control={form.control as never}
            name="pattern"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("spending:rules.pattern")}</FormLabel>
                <FormControl>
                  <Input
                    placeholder={
                      matchMode === "regex"
                        ? t("spending:rules.patternPlaceholderRegex")
                        : t("spending:rules.patternPlaceholder")
                    }
                    {...field}
                  />
                </FormControl>
                {matchMode === "regex" && (
                  <FormDescription>{t("spending:rules.patternRegexHint")}</FormDescription>
                )}
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        <FormField
          control={form.control as never}
          name="payeeConditionId"
          render={({ field }) => (
            <FormItem>
              <div className="flex items-baseline gap-1.5">
                <FormLabel id={payeeConditionLabelId}>
                  {t("spending:rules.payeeCondition")}
                </FormLabel>
                <span className="text-muted-foreground text-xs">
                  {t("spending:rules.amountOptional")}
                </span>
              </div>
              <FormControl>
                <RulePayeePicker
                  value={(field.value as string | null) ?? null}
                  onChange={field.onChange}
                  payees={payeeOptions}
                  placeholder={t("spending:rules.payeeConditionAny")}
                  labelId={payeeConditionLabelId}
                />
              </FormControl>
              <FormDescription>{t("spending:rules.payeeConditionHint")}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control as never}
            name="activityType"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("spending:rules.activityType")}</FormLabel>
                <Select
                  items={[
                    { value: NONE, label: t("spending:rules.none") },
                    ...ACTIVITY_TYPE_OPTIONS,
                  ]}
                  onValueChange={(val) => field.onChange(val === NONE ? "" : val)}
                  value={field.value || ""}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder={t("spending:rules.selectActivityType")} />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value={NONE}>
                      <span className="text-muted-foreground">{t("spending:rules.none")}</span>
                    </SelectItem>
                    {ACTIVITY_TYPE_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control as never}
            name="categoryId"
            render={({ field }) => {
              const fieldValue = (field.value as string | undefined) ?? "";
              const [, currentCatId] = fieldValue.split(":");
              const currentOption = currentCatId
                ? categoryOptions.find((opt) => opt.categoryId === currentCatId)
                : undefined;
              const payeeTarget = targetsPayee(fieldValue);
              return (
                <FormItem>
                  <FormLabel>{t("spending:rules.categoryOrPayee")}</FormLabel>
                  <QuickCategorizePopover
                    scope="all"
                    includePayees
                    selectedCategoryId={currentCatId ?? null}
                    onSelect={(tax, catId) => field.onChange(`${tax}:${catId}`)}
                    onClear={() => field.onChange("")}
                    trigger={
                      <FormControl>
                        <button
                          type="button"
                          className="border-input bg-input-bg dark:bg-input/30 hover:bg-accent/30 ring-offset-background focus:ring-ring h-input-height flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm transition-colors focus:ring-2 focus:ring-offset-2 focus:outline-none"
                          aria-label={
                            currentOption
                              ? t("spending:transactions.changeCategory", {
                                  name: currentOption.label,
                                })
                              : t("spending:rules.selectCategory")
                          }
                        >
                          {currentOption ? (
                            <span className="flex min-w-0 items-center gap-2">
                              <CategoryIconTile
                                icon={currentOption.icon ?? null}
                                color={currentOption.color ?? null}
                                className="h-5 w-5"
                                iconClassName="h-3 w-3"
                              />
                              <span className="truncate">
                                {currentOption.parentName ? `${currentOption.parentName} / ` : ""}
                                {currentOption.label}
                              </span>
                            </span>
                          ) : (
                            <span className="text-muted-foreground">
                              {t("spending:rules.selectCategory")}
                            </span>
                          )}
                          <Icons.ChevronDown
                            className="ms-2 h-4 w-4 shrink-0 opacity-50"
                            aria-hidden="true"
                          />
                        </button>
                      </FormControl>
                    }
                  />
                  <FormDescription>
                    {payeeTarget
                      ? t("spending:rules.payeeRuleHint")
                      : t("spending:rules.categoryCompatibilityHint")}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              );
            }}
          />
        </div>

        {canAlsoSetPayee && (
          <FormField
            control={form.control as never}
            name="setPayeeId"
            render={({ field }) => (
              <FormItem>
                <div className="flex items-baseline gap-1.5">
                  <FormLabel id={setPayeeLabelId}>{t("spending:rules.setPayee")}</FormLabel>
                  <span className="text-muted-foreground text-xs">
                    {t("spending:rules.amountOptional")}
                  </span>
                </div>
                <FormControl>
                  <RulePayeePicker
                    value={(field.value as string | null) ?? null}
                    onChange={field.onChange}
                    payees={payeeOptions}
                    placeholder={t("spending:rules.setPayeeNone")}
                    labelId={setPayeeLabelId}
                  />
                </FormControl>
                <FormDescription>{t("spending:rules.setPayeeHint")}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        <div className="space-y-2">
          <div className="flex items-baseline gap-1.5">
            <FormLabel>{t("spending:rules.amountLabel")}</FormLabel>
            <span className="text-muted-foreground text-xs">
              {t("spending:rules.amountOptional")}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control as never}
              name="amountOp"
              render={({ field }) => (
                <FormItem>
                  <Select
                    items={[
                      { value: NONE, label: t("spending:rules.amountAnyAmount") },
                      ...AMOUNT_OP_OPTIONS,
                    ]}
                    onValueChange={(val) => field.onChange(val === NONE ? "" : val)}
                    value={field.value || NONE}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={NONE}>{t("spending:rules.amountAnyAmount")}</SelectItem>
                      {AMOUNT_OP_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            {amountOp && amountOp !== "between" && (
              <FormField
                control={form.control as never}
                name="amountValue"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <Input type="number" min={0} step="any" inputMode="decimal" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
          </div>
          {amountOp === "between" && (
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control as never}
                name="amountValue"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-muted-foreground text-xs font-normal">
                      {t("spending:rules.amountFrom")}
                    </FormLabel>
                    <FormControl>
                      <Input type="number" min={0} step="any" inputMode="decimal" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control as never}
                name="amountValue2"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-muted-foreground text-xs font-normal">
                      {t("spending:rules.amountTo")}
                    </FormLabel>
                    <FormControl>
                      <Input type="number" min={0} step="any" inputMode="decimal" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          )}
          {amountOp && (
            <FormDescription>
              {t("spending:rules.amountHint")}
              {amountOp === "between" ? ` ${t("spending:rules.amountBetweenHint")}` : ""}
            </FormDescription>
          )}
        </div>

        <FormField
          control={form.control as never}
          name="accountId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("spending:rules.scopeLabel")}</FormLabel>
              <Select
                items={[
                  { value: ALL_ACCOUNTS, label: t("common:component.all_accounts") },
                  ...scopeOptions.map((account) => ({ value: account.id, label: account.name })),
                ]}
                onValueChange={(val) => field.onChange(val === ALL_ACCOUNTS ? null : val)}
                value={(field.value as string | null) ?? ALL_ACCOUNTS}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value={ALL_ACCOUNTS}>{t("common:component.all_accounts")}</SelectItem>
                  {scopeOptions.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {account.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormDescription>{t("spending:rules.scopeHint")}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control as never}
          name="priority"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("spending:rules.priorityLabel")}</FormLabel>
              <FormControl>
                <Input type="number" min={0} {...field} />
              </FormControl>
              <FormDescription>{t("spending:rules.priorityHint")}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex justify-end gap-2 pt-4">
          <Button type="button" variant="outline" onClick={onCancel}>
            {t("common:cancel")}
          </Button>
          <Button type="submit" disabled={isLoading}>
            {isLoading ? (
              <>
                <Spinner className="me-2 h-4 w-4" />
                {t("spending:common.saving")}
              </>
            ) : rule ? (
              t("spending:rules.updateRule")
            ) : (
              t("spending:rules.createRule")
            )}
          </Button>
        </div>
      </form>
    </Form>
  );
}
