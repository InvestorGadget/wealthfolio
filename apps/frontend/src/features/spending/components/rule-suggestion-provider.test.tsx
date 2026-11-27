import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { act, render, screen, waitFor, within } from "@/test/render";

import {
  readRuleSuggestionPreferences,
  RULE_SUGGESTION_SNOOZE_MS,
  updateRuleSuggestionPreferences,
} from "../lib/rule-suggestion-preferences";
import type { RulePrefill } from "../lib/rule-suggestion";
import type {
  ActivityRuleExplanation,
  CategorizationRule,
  CategorizationRunSummary,
} from "../types/rule";
import type { RuleFormValues } from "./rule-form";
import {
  RuleSuggestionProvider,
  useRuleSuggestions,
  type RuleSuggestions,
} from "./rule-suggestion-provider";

const mocks = vi.hoisted(() => ({
  explain: vi.fn<(ids: string[]) => Promise<unknown[]>>(),
  preview: vi.fn<(onlyUncategorized: boolean) => Promise<unknown>>(),
  save: vi.fn<(change: { rule: unknown; id?: string }) => Promise<void>>(),
  rerun: vi.fn<(onlyUncategorized: boolean, options?: { onSettled?: () => void }) => void>(),
  // The prompt sonner was last asked to show, and how it was asked.
  shown: null as null | ReactElement,
  shownTitle: null as null | string,
  toastOptions: null as null | { id?: string; duration?: number; closeButton?: boolean },
  dismissed: [] as unknown[],
  toastError: vi.fn(),
}));

vi.mock("sonner", () => {
  const toast = (title: string, options: { id?: string; description: ReactElement }) => {
    mocks.shownTitle = title;
    mocks.shown = options.description;
    mocks.toastOptions = options;
  };
  toast.dismiss = (id: unknown) => {
    mocks.dismissed.push(id);
    mocks.shown = null;
  };
  toast.error = mocks.toastError;
  toast.success = vi.fn();
  return { toast };
});
vi.mock("../adapters/rules", () => ({
  explainActivityRules: mocks.explain,
  previewCategorizationRulesRerun: mocks.preview,
}));
vi.mock("@/adapters", () => ({
  getTaxonomy: (id: string) =>
    Promise.resolve({
      taxonomy: { id },
      categories:
        id === "payees"
          ? [
              { id: "payee_tesco", name: "Tesco" },
              { id: "payee_asda", name: "Asda" },
            ]
          : [
              { id: "cat_groceries", name: "Groceries" },
              { id: "cat_dining", name: "Dining" },
            ],
    }),
}));
vi.mock("../hooks/use-categorization-rules", () => ({
  useCategorizationRuleMutations: () => ({
    rerun: { mutate: mocks.rerun, isPending: false },
  }),
  // The save that leaves applying the rule to the user's answer.
  useSaveRuleWithoutApplying: () => ({ mutateAsync: mocks.save, isPending: false }),
}));
vi.mock("../hooks/use-rule-form-options", () => ({
  useRuleFormOptions: () => ({ categoryOptions: [], accountOptions: [] }),
}));
const savedValues: RuleFormValues = {
  name: "Tesco",
  pattern: "",
  matchType: "contains",
  taxonomyId: "spending_categories",
  categoryId: "cat_groceries",
  amountOp: "",
  amountValue: "",
  amountValue2: "",
  priority: 0,
  accountId: null,
  payeeConditionId: "payee_tesco",
  setPayeeId: null,
};
// The modal's form, reduced to what it was opened with and its save.
vi.mock("./rule-edit-modal", () => ({
  RuleEditModal: ({
    rule,
    prefill,
    onSave,
    onClose,
  }: {
    rule?: CategorizationRule;
    prefill?: RulePrefill;
    onSave: (values: RuleFormValues) => void;
    onClose: () => void;
  }) => (
    <div role="dialog" aria-label="Rule form">
      <output data-testid="editing">{rule?.id ?? ""}</output>
      <output data-testid="prefill">{JSON.stringify(prefill ?? null)}</output>
      <button type="button" onClick={() => onSave(savedValues)}>
        Save rule
      </button>
      <button type="button" onClick={onClose}>
        Cancel
      </button>
    </div>
  ),
}));

const groceries = { taxonomyId: "spending_categories", categoryId: "cat_groceries" };
const withPayee: ActivityRuleExplanation = {
  activityId: "a1",
  bankText: "TESCO STORES 3301",
  payeeId: "payee_tesco",
};
const summary = (fields: Partial<CategorizationRunSummary>): CategorizationRunSummary => ({
  matched: 0,
  eligible: 0,
  changed: 0,
  protectedSplits: 0,
  protectedManual: 0,
  skippedExisting: 0,
  unchanged: 0,
  incompatible: 0,
  withoutTarget: 0,
  ...fields,
});

let api: RuleSuggestions;
function Capture() {
  const suggestions = useRuleSuggestions();
  if (suggestions) api = suggestions;
  return null;
}
/** Shows whatever prompt sonner currently holds, as the toaster would. */
function Toaster() {
  return mocks.shown;
}

function renderProvider() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <RuleSuggestionProvider>
        <Capture />
      </RuleSuggestionProvider>
    </QueryClientProvider>,
  );
  return view;
}
/** The prompt, once it has been worked out. */
async function prompt() {
  await waitFor(() => expect(mocks.shown).not.toBeNull());
  return render(<Toaster />);
}
/** Lets a suggestion that should not appear finish being worked out. */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

beforeEach(() => {
  localStorage.clear();
  mocks.shown = null;
  mocks.shownTitle = null;
  mocks.toastOptions = null;
  mocks.dismissed = [];
  mocks.explain.mockReset().mockResolvedValue([withPayee]);
  mocks.preview.mockReset().mockResolvedValue(summary({}));
  mocks.save.mockReset().mockResolvedValue(undefined);
  mocks.rerun.mockReset();
  mocks.toastError.mockReset();
});

describe("RuleSuggestionProvider", () => {
  it("offers a rule after a manual edit, as a prompt that does not block", async () => {
    renderProvider();
    act(() => api.suggestAfterEdit(["a1"], { category: groceries }));

    const view = await prompt();
    expect(mocks.explain).toHaveBeenCalledWith(["a1"]);
    const card = view.getByRole("group", {
      name: "Always do this for transactions like this?",
    });
    expect(card).toHaveAccessibleDescription("Set Groceries whenever the payee is Tesco.");
    // Every way out is a button with a name of its own.
    expect(mocks.shownTitle).toBe("Always do this for transactions like this?");
    for (const name of ["Create rule", "Not today", "Don't suggest for Tesco"]) {
      expect(within(card).getByRole("button", { name })).toBeInTheDocument();
    }
    expect(card).toHaveTextContent("You can turn suggestions off in Settings › Spending tracker.");
    // One prompt at a time, with the toaster's own close button to dismiss
    // this one, and it goes away by itself.
    expect(mocks.toastOptions).toMatchObject({
      id: "spending-rule-suggestion",
      closeButton: true,
    });
    expect(mocks.toastOptions?.duration).toBeGreaterThan(0);
    // Nothing has been saved, and no form is open, until a button is pressed.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("opens the rule form filled in, and saves nothing until the form is saved", async () => {
    const user = userEvent.setup();
    renderProvider();
    act(() => api.suggestAfterEdit(["a1"], { category: groceries }));
    const view = await prompt();

    await user.click(view.getByRole("button", { name: "Create rule" }));
    expect(mocks.dismissed).toEqual(["spending-rule-suggestion"]);
    expect(JSON.parse(screen.getByTestId("prefill").textContent ?? "")).toEqual({
      name: "Tesco",
      pattern: "",
      matchType: "contains",
      taxonomyId: "spending_categories",
      categoryId: "cat_groceries",
      payeeConditionId: "payee_tesco",
      setPayeeId: null,
    });
    expect(mocks.save).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it("names a rule on the bank text after that text", async () => {
    const user = userEvent.setup();
    mocks.explain.mockResolvedValue([{ activityId: "a1", bankText: "TESCO STORES 3301" }]);
    renderProvider();
    act(() => api.suggestAfterEdit(["a1"], { category: groceries }));
    const view = await prompt();

    expect(view.getByRole("group")).toHaveAccessibleDescription(
      "Set Groceries whenever the bank's text is “TESCO STORES 3301”.",
    );
    // No payee is involved, so there is none to silence.
    expect(view.queryByRole("button", { name: /Don't suggest for/ })).not.toBeInTheDocument();
    await user.click(view.getByRole("button", { name: "Create rule" }));
    expect(JSON.parse(screen.getByTestId("prefill").textContent ?? "")).toMatchObject({
      name: "TESCO STORES 3301",
      pattern: "TESCO STORES 3301",
      matchType: "exact",
    });
  });

  it("offers to update the rule that sets something else, and opens that rule", async () => {
    const user = userEvent.setup();
    const rule = { id: "r1", name: "Supermarkets" } as CategorizationRule;
    mocks.explain.mockResolvedValue([
      {
        ...withPayee,
        categoryRule: { rule, taxonomyId: "spending_categories", categoryId: "cat_dining" },
      },
    ]);
    renderProvider();
    act(() => api.suggestAfterEdit(["a1"], { category: groceries }));
    const view = await prompt();

    expect(view.getByRole("group", { name: "A rule sets Dining — update it?" })).toBeVisible();
    await user.click(view.getByRole("button", { name: "Update rule" }));
    expect(screen.getByTestId("editing")).toHaveTextContent("r1");

    await user.click(screen.getByRole("button", { name: "Save rule" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    // Saved over that rule, not as a new one.
    expect(mocks.save.mock.calls[0][0]).toMatchObject({
      id: "r1",
      rule: { categoryId: "cat_groceries", payeeConditionId: "payee_tesco" },
    });
  });

  it("does not offer a rule the rules already cover", async () => {
    mocks.explain.mockResolvedValue([
      {
        ...withPayee,
        categoryRule: {
          rule: { id: "r1", name: "Tesco" },
          taxonomyId: "spending_categories",
          categoryId: "cat_groceries",
        },
      },
    ]);
    renderProvider();
    act(() => api.suggestAfterEdit(["a1"], { category: groceries }));
    await settle();
    expect(mocks.explain).toHaveBeenCalledTimes(1);
    expect(mocks.shown).toBeNull();
  });

  it("does not ask the backend, or offer anything, for an edit that set nothing", async () => {
    renderProvider();
    act(() => api.suggestAfterEdit(["a1"], {}));
    act(() => api.suggestAfterEdit([], { category: groceries }));
    await settle();
    expect(mocks.explain).not.toHaveBeenCalled();
    expect(mocks.shown).toBeNull();
  });

  it("offers nothing when one of the edited transactions cannot be explained", async () => {
    mocks.explain.mockResolvedValue([withPayee]);
    renderProvider();
    act(() => api.suggestAfterEdit(["a1", "a2"], { category: groceries }));
    await settle();
    expect(mocks.shown).toBeNull();
  });

  it("stays quiet when the read fails: the edit is saved either way", async () => {
    mocks.explain.mockRejectedValue(new Error("offline"));
    renderProvider();
    act(() => api.suggestAfterEdit(["a1"], { category: groceries }));
    await settle();
    expect(mocks.shown).toBeNull();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  describe("what it remembers", () => {
    it("reads nothing while suggestions are switched off", async () => {
      updateRuleSuggestionPreferences((current) => ({ ...current, enabled: false }));
      renderProvider();
      act(() => api.suggestAfterEdit(["a1"], { category: groceries }));
      await settle();
      expect(mocks.explain).not.toHaveBeenCalled();
      expect(mocks.shown).toBeNull();
    });

    it("keeps suggesting after a suggestion was closed or left to expire", async () => {
      renderProvider();
      act(() => api.suggestAfterEdit(["a1"], { category: groceries }));
      await prompt();
      // Closing the toast is the toaster's doing: nothing is remembered.
      mocks.shown = null;
      expect(readRuleSuggestionPreferences()).toEqual({
        enabled: true,
        snoozedUntil: null,
        mutedPayeeIds: [],
      });
      act(() => api.suggestAfterEdit(["a1"], { category: groceries }));
      await waitFor(() => expect(mocks.shown).not.toBeNull());
    });

    it("snoozes every suggestion for a day on Not today", async () => {
      const user = userEvent.setup();
      renderProvider();
      act(() => api.suggestAfterEdit(["a1"], { category: groceries }));
      const view = await prompt();
      const before = Date.now();

      await user.click(view.getByRole("button", { name: "Not today" }));
      expect(mocks.dismissed).toEqual(["spending-rule-suggestion"]);
      const until = readRuleSuggestionPreferences().snoozedUntil ?? 0;
      expect(until).toBeGreaterThanOrEqual(before + RULE_SUGGESTION_SNOOZE_MS);

      mocks.explain.mockClear();
      act(() => api.suggestAfterEdit(["a2"], { category: groceries }));
      await settle();
      expect(mocks.explain).not.toHaveBeenCalled();
      expect(mocks.shown).toBeNull();
    });

    it("stops suggesting for one payee, and only for that one", async () => {
      const user = userEvent.setup();
      renderProvider();
      act(() => api.suggestAfterEdit(["a1"], { category: groceries }));
      const view = await prompt();

      await user.click(view.getByRole("button", { name: "Don't suggest for Tesco" }));
      expect(readRuleSuggestionPreferences().mutedPayeeIds).toEqual(["payee_tesco"]);

      act(() => api.suggestAfterEdit(["a1"], { category: groceries }));
      await settle();
      expect(mocks.shown).toBeNull();

      mocks.explain.mockResolvedValue([{ ...withPayee, payeeId: "payee_asda" }]);
      act(() => api.suggestAfterEdit(["a1"], { category: groceries }));
      await waitFor(() => expect(mocks.shown).not.toBeNull());
    });
  });

  describe("after the rule is saved", () => {
    async function saveSuggestedRule() {
      const user = userEvent.setup();
      renderProvider();
      act(() => api.suggestAfterEdit(["a1"], { category: groceries }));
      const view = await prompt();
      await user.click(view.getByRole("button", { name: "Create rule" }));
      await user.click(screen.getByRole("button", { name: "Save rule" }));
      await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
      return user;
    }

    it("offers to apply it to the uncategorized transactions it matches", async () => {
      mocks.preview.mockResolvedValue(summary({ eligible: 3, protectedManual: 2 }));
      const user = await saveSuggestedRule();

      const saved = mocks.save.mock.calls[0][0];
      expect(saved.id).toBeUndefined();
      expect(saved.rule).toMatchObject({
        name: "Tesco",
        categoryId: "cat_groceries",
        payeeConditionId: "payee_tesco",
        isGlobal: true,
      });
      const dialog = await screen.findByRole("alertdialog");
      // Only what has no category yet is ever previewed or run.
      expect(mocks.preview).toHaveBeenCalledWith(true);
      expect(dialog).toHaveTextContent("Apply to 3 matching uncategorized transactions?");
      expect(dialog).toHaveTextContent(
        "2 transactions you categorized by hand are kept as they are.",
      );
      expect(mocks.rerun).not.toHaveBeenCalled();

      await user.click(within(dialog).getByRole("button", { name: "Apply" }));
      expect(mocks.rerun).toHaveBeenCalledTimes(1);
      expect(mocks.rerun.mock.calls[0][0]).toBe(true);
    });

    it("runs nothing when the offer is declined", async () => {
      mocks.preview.mockResolvedValue(summary({ eligible: 1 }));
      const user = await saveSuggestedRule();

      const dialog = await screen.findByRole("alertdialog");
      expect(dialog).toHaveTextContent("Apply to 1 matching uncategorized transaction?");
      expect(dialog).toHaveTextContent(
        "Transactions you categorized by hand are kept as they are.",
      );
      await user.click(within(dialog).getByRole("button", { name: "Not now" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
      expect(mocks.rerun).not.toHaveBeenCalled();
    });

    it("does not ask when there is nothing to apply it to", async () => {
      mocks.preview.mockResolvedValue(summary({ eligible: 0, protectedManual: 4 }));
      await saveSuggestedRule();
      await waitFor(() => expect(mocks.preview).toHaveBeenCalledWith(true));
      await settle();
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    it("keeps the form open when the save fails", async () => {
      mocks.save.mockRejectedValue(new Error("refused"));
      await saveSuggestedRule();
      await settle();
      expect(screen.getByRole("dialog", { name: "Rule form" })).toBeInTheDocument();
      expect(mocks.preview).not.toHaveBeenCalled();
    });
  });

  describe("Create rule from a transaction's menu", () => {
    it("opens the form filled in for that transaction, without an edit or a prompt", async () => {
      renderProvider();
      act(() => api.createRuleFor("a1", groceries));

      await screen.findByRole("dialog", { name: "Rule form" });
      expect(mocks.explain).toHaveBeenCalledWith(["a1"]);
      expect(mocks.shown).toBeNull();
      expect(JSON.parse(screen.getByTestId("prefill").textContent ?? "")).toEqual({
        name: "Tesco",
        pattern: "",
        matchType: "contains",
        taxonomyId: "spending_categories",
        categoryId: "cat_groceries",
        payeeConditionId: "payee_tesco",
        setPayeeId: null,
      });
    });

    it("works while suggestions are switched off: it was asked for", async () => {
      updateRuleSuggestionPreferences((current) => ({ ...current, enabled: false }));
      mocks.explain.mockResolvedValue([{ activityId: "a1", bankText: "TESCO STORES 3301" }]);
      renderProvider();
      act(() => api.createRuleFor("a1", null));

      await screen.findByRole("dialog", { name: "Rule form" });
      expect(JSON.parse(screen.getByTestId("prefill").textContent ?? "")).toMatchObject({
        name: "TESCO STORES 3301",
        pattern: "TESCO STORES 3301",
        matchType: "exact",
        categoryId: null,
      });
    });

    it("says so when the transaction cannot be read", async () => {
      mocks.explain.mockResolvedValue([]);
      renderProvider();
      act(() => api.createRuleFor("gone", null));
      await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});
