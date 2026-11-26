import { render, screen } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  RuleForm,
  buildRuleFormSchema,
  ruleAmountPayload,
  type RuleFormState,
  type RuleFormValues,
} from "./rule-form";
import type { CategorizationRule } from "../types/rule";

vi.mock("@/hooks/use-taxonomies", () => {
  const categories = {
    spending_categories: [{ id: "cat_food", name: "Food", parentId: null, sortOrder: 0 }],
    income_sources: [{ id: "cat_salary", name: "Salary", parentId: null, sortOrder: 0 }],
    savings_categories: [
      {
        id: "cat_savings_investments",
        name: "Investment Contributions",
        parentId: null,
        sortOrder: 0,
      },
    ],
  };
  return {
    useTaxonomy: (id: keyof typeof categories) => ({ data: { categories: categories[id] } }),
  };
});

if (typeof ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
}
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => undefined;
}

const t = (key: string) => key;
const schema = buildRuleFormSchema(t);

const baseValues: RuleFormState = {
  name: "Coffee",
  pattern: "STARBUCKS",
  patternList: "",
  matchType: "contains",
  payeeConditionId: null,
  setPayeeId: null,
  taxonomyId: "",
  categoryId: "spending_categories:cat_food",
  activityType: "",
  amountOp: "",
  amountValue: "",
  amountValue2: "",
  priority: 0,
  accountId: null,
};

const errorPaths = (values: RuleFormState): string[][] => {
  const result = schema.safeParse(values);
  return result.success ? [] : result.error.issues.map((i) => i.path.map(String));
};

it("offers Savings categories when editing a categorization rule", async () => {
  const user = userEvent.setup();
  render(
    <RuleForm
      categoryOptions={[
        {
          value: "savings_categories:cat_savings_investments",
          label: "Investment Contributions",
          taxonomyId: "savings_categories",
          categoryId: "cat_savings_investments",
        },
      ]}
      accountOptions={[]}
      onSubmit={vi.fn()}
      onCancel={vi.fn()}
    />,
  );

  await user.click(screen.getByRole("button", { name: "Select category" }));
  await user.type(screen.getByPlaceholderText("Search categories..."), "Investment Contributions");
  expect(screen.getByText("Investment Contributions")).toBeInTheDocument();
  expect(screen.getByText(/Categories follow the transaction's cash flow/)).toBeInTheDocument();
});

describe("rule form priority validation", () => {
  it("asks for a whole number of 0 or more", () => {
    for (const priority of [-1, 1.5]) {
      const result = schema.safeParse({ ...baseValues, priority });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.message)).toContain(
          "spending:rules.priorityInvalid",
        );
      }
    }
  });
});

describe("rule form amount validation", () => {
  it("accepts 'Any amount' with blank value fields", () => {
    expect(schema.safeParse(baseValues).success).toBe(true);
  });

  it.each(["eq", "gt", "gte", "lt", "lte"] as const)("accepts %s with a single value", (op) => {
    expect(schema.safeParse({ ...baseValues, amountOp: op, amountValue: "10.50" }).success).toBe(
      true,
    );
  });

  it("accepts between with from < to and from == to", () => {
    expect(
      schema.safeParse({
        ...baseValues,
        amountOp: "between",
        amountValue: "45",
        amountValue2: "55",
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        ...baseValues,
        amountOp: "between",
        amountValue: "45",
        amountValue2: "45",
      }).success,
    ).toBe(true);
  });

  it("rejects an operator with a blank value", () => {
    expect(errorPaths({ ...baseValues, amountOp: "gt" })).toContainEqual(["amountValue"]);
  });

  it("rejects non-numeric and negative values", () => {
    expect(errorPaths({ ...baseValues, amountOp: "gt", amountValue: "abc" })).toContainEqual([
      "amountValue",
    ]);
    expect(errorPaths({ ...baseValues, amountOp: "gt", amountValue: "-5" })).toContainEqual([
      "amountValue",
    ]);
  });

  it("rejects between without an upper value and flags it on the 'to' field", () => {
    expect(errorPaths({ ...baseValues, amountOp: "between", amountValue: "45" })).toContainEqual([
      "amountValue2",
    ]);
  });

  it("rejects between with from > to and flags it on the 'to' field", () => {
    expect(
      errorPaths({
        ...baseValues,
        amountOp: "between",
        amountValue: "100",
        amountValue2: "25",
      }),
    ).toContainEqual(["amountValue2"]);
  });
});

describe("rule form conditions", () => {
  const messages = (values: RuleFormState): string[] => {
    const result = schema.safeParse(values);
    return result.success ? [] : result.error.issues.map((issue) => issue.message);
  };

  it("asks for a text or a payee, and takes either alone", () => {
    expect(errorPaths({ ...baseValues, pattern: "  " })).toContainEqual(["pattern"]);
    expect(messages({ ...baseValues, pattern: "" })).toContain("spending:rules.conditionRequired");
    expect(schema.safeParse({ ...baseValues, pattern: "", payeeConditionId: "p1" }).success).toBe(
      true,
    );
  });

  it("asks for at least one text of a list, on the list field", () => {
    expect(
      errorPaths({ ...baseValues, matchType: "any_contains", patternList: " \n " }),
    ).toContainEqual(["patternList"]);
    // The single-text field is not what a list rule matches on.
    expect(
      errorPaths({ ...baseValues, matchType: "any_exact", pattern: "LEFTOVER", patternList: "" }),
    ).toContainEqual(["patternList"]);
    expect(
      schema.safeParse({ ...baseValues, matchType: "any_exact", patternList: "A\nB" }).success,
    ).toBe(true);
  });

  it("refuses a list that compiles past the stored pattern limit", () => {
    const patternList = Array.from({ length: 80 }, (_, i) => `MERCHANT ${i}`).join("\n");
    expect(messages({ ...baseValues, matchType: "any_contains", patternList })).toContain(
      "spending:rules.patternListTooLong",
    );
  });

  it("lets a catch-all an earlier version saved keep its empty pattern", () => {
    const legacy = buildRuleFormSchema(t, { keepsEmptyPattern: true });
    expect(legacy.safeParse({ ...baseValues, pattern: "" }).success).toBe(true);
    // A new rule may not have one.
    expect(messages({ ...baseValues, pattern: "" })).toContain("spending:rules.conditionRequired");
  });

  it("refuses a payee condition on a rule that sets a payee as its target", () => {
    const values = { ...baseValues, categoryId: "payees:p2", payeeConditionId: "p1" };
    expect(errorPaths(values)).toContainEqual(["categoryId"]);
    expect(messages(values)).toContain("spending:rules.payeeConditionWithPayeeTarget");
  });
});

describe("rule form payee fields", () => {
  const options = [
    {
      value: "spending_categories:cat_food",
      label: "Food",
      taxonomyId: "spending_categories",
      categoryId: "cat_food",
    },
    { value: "payees:p1", label: "Corner Bakery", taxonomyId: "payees", categoryId: "p1" },
    { value: "payees:p2", label: "Amazon", taxonomyId: "payees", categoryId: "p2" },
  ];
  const storedRule = (overrides: Partial<CategorizationRule>): CategorizationRule => ({
    id: "r1",
    name: "Rule",
    pattern: "BAKERY",
    matchType: "contains",
    taxonomyId: "spending_categories",
    categoryId: "cat_food",
    priority: 0,
    isGlobal: true,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  });
  const renderForm = (rule?: CategorizationRule) => {
    const onSubmit = vi.fn<(values: RuleFormValues) => void>();
    render(
      <RuleForm
        rule={rule}
        categoryOptions={options}
        accountOptions={[]}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    return onSubmit;
  };
  const submitted = async (onSubmit: ReturnType<typeof renderForm>) => {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Update rule" }));
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());
    return onSubmit.mock.calls[0][0];
  };

  it("shows a payee-only rule with an empty pattern and saves it as one", async () => {
    const onSubmit = renderForm(
      storedRule({ pattern: "(?!)", matchType: "regex", payeeConditionId: "p1" }),
    );

    // The placeholder the rule is stored with is never shown.
    expect(screen.getByLabelText("Pattern")).toHaveValue("");
    expect(screen.queryByDisplayValue("(?!)")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Payee is/ })).toHaveTextContent("Corner Bakery");
    // A rule that matches on a payee does not offer to set one.
    expect(screen.queryByRole("button", { name: /^Also set payee/ })).not.toBeInTheDocument();

    const values = await submitted(onSubmit);
    expect(values).toMatchObject({
      pattern: "",
      matchType: "contains",
      payeeConditionId: "p1",
      setPayeeId: null,
    });
    expect(values).not.toHaveProperty("patternList");
  });

  it("names a payee picker by its label and its payee, and links its hint", () => {
    renderForm(storedRule({ payeeConditionId: "p1" }));

    const picker = screen.getByRole("button", { name: "Payee is Corner Bakery" });
    expect(screen.getByLabelText(/^Payee is/)).toBe(picker);
    expect(picker).toHaveAccessibleDescription(
      "Only matches transactions filed under this payee, by you or by another rule. With a payee, the pattern can be left empty.",
    );
    expect(picker).toHaveAttribute("aria-invalid", "false");
  });

  it("names an empty payee picker by what it means", () => {
    renderForm(storedRule({}));

    expect(screen.getByRole("button", { name: "Payee is Any payee" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Also set payee No payee" })).toBeInTheDocument();
  });

  it("saves a catch-all an earlier version saved with its empty pattern", async () => {
    const onSubmit = renderForm(storedRule({ pattern: "", matchType: "exact" }));

    expect(screen.getByLabelText("Pattern")).toHaveValue("");
    expect(await submitted(onSubmit)).toMatchObject({ pattern: "", matchType: "exact" });
  });

  it("picks and clears the payee a rule matches on", async () => {
    const user = userEvent.setup();
    const onSubmit = renderForm(storedRule({}));

    await user.click(screen.getByRole("button", { name: /^Payee is/ }));
    await user.click(await screen.findByRole("option", { name: "Amazon" }));
    expect(screen.getByRole("button", { name: /^Payee is/ })).toHaveTextContent("Amazon");
    // Only an existing payee can be picked here: no row to add a new one.
    await user.click(screen.getByRole("button", { name: /^Payee is/ }));
    await user.type(screen.getByPlaceholderText("Search or add a payee"), "Nobody");
    expect(screen.queryByText(/Add "Nobody"/)).not.toBeInTheDocument();
    await user.keyboard("{Escape}");

    expect(await submitted(onSubmit)).toMatchObject({ pattern: "BAKERY", payeeConditionId: "p2" });
  });

  it("shows the payee a category rule also sets and saves it", async () => {
    const onSubmit = renderForm(storedRule({ setPayeeId: "p2" }));

    expect(screen.getByRole("button", { name: /^Also set payee/ })).toHaveTextContent("Amazon");
    expect(await submitted(onSubmit)).toMatchObject({ setPayeeId: "p2", payeeConditionId: null });
  });

  it("keeps a payee that no longer exists, under a name that says so", async () => {
    const onSubmit = renderForm(storedRule({ payeeConditionId: "gone" }));

    expect(screen.getByRole("button", { name: /^Payee is/ })).toHaveTextContent("Unknown payee");
    expect(await submitted(onSubmit)).toMatchObject({ payeeConditionId: "gone" });
  });

  it("does not offer to also set a payee on a payee rule, and drops the one it had", async () => {
    const onSubmit = renderForm(
      storedRule({ taxonomyId: "payees", categoryId: "p1", setPayeeId: "p2" }),
    );

    expect(screen.queryByRole("button", { name: /^Also set payee/ })).not.toBeInTheDocument();
    expect(await submitted(onSubmit)).toMatchObject({ setPayeeId: null });
  });

  it("shows a compiled list as its texts and compiles it again on save", async () => {
    const user = userEvent.setup();
    const onSubmit = renderForm(
      storedRule({ pattern: "(?i)^(?:AT\\&T|Disney\\+)$", matchType: "regex" }),
    );

    const list = screen.getByLabelText("Texts");
    expect(list).toHaveValue("AT&T\nDisney+");
    expect(screen.queryByLabelText("Pattern")).not.toBeInTheDocument();
    await user.type(list, "{Enter}C.O.D.");

    expect(await submitted(onSubmit)).toMatchObject({
      pattern: "(?i)^(?:AT\\&T|Disney\\+|C\\.O\\.D\\.)$",
      matchType: "regex",
    });
  });
});

describe("ruleAmountPayload", () => {
  it("maps 'Any amount' to explicit nulls so updates clear the condition", () => {
    expect(ruleAmountPayload({ amountOp: "", amountValue: "50", amountValue2: "60" })).toEqual({
      amountOp: null,
      amountValue: null,
      amountValue2: null,
    });
  });

  it("maps single-value operators and drops the stale upper value", () => {
    expect(
      ruleAmountPayload({ amountOp: "gt", amountValue: "1000", amountValue2: "9999" }),
    ).toEqual({ amountOp: "gt", amountValue: 1000, amountValue2: null });
  });

  it("keeps both values for between and parses decimals", () => {
    expect(
      ruleAmountPayload({ amountOp: "between", amountValue: "45.5", amountValue2: "55" }),
    ).toEqual({ amountOp: "between", amountValue: 45.5, amountValue2: 55 });
  });
});

// The amount condition and the account scope are independent; neither should
// constrain the other in the schema.
describe("amount condition combined with account scope", () => {
  it("accepts an amount condition on an account-scoped rule", () => {
    expect(
      schema.safeParse({
        ...baseValues,
        accountId: "acct-1",
        amountOp: "between",
        amountValue: "10",
        amountValue2: "50",
      }).success,
    ).toBe(true);
  });

  it("still rejects a bad amount range on an account-scoped rule", () => {
    expect(
      errorPaths({
        ...baseValues,
        accountId: "acct-1",
        amountOp: "between",
        amountValue: "50",
        amountValue2: "10",
      }),
    ).toContainEqual(["amountValue2"]);
  });

  it("accepts a scoped rule with no amount condition", () => {
    expect(schema.safeParse({ ...baseValues, accountId: "acct-1" }).success).toBe(true);
  });
});
