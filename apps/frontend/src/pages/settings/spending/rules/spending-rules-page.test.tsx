import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import { Activity } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { RuleFormValues } from "@/features/spending/components/rule-form";
import SpendingRulesPage from "./spending-rules-page";

const loaded = { data: { categories: [] }, isLoading: false, isError: false };
const mocks = vi.hoisted(() => ({
  create: vi.fn<() => Promise<void>>(),
  // What `useTaxonomy` returns for a taxonomy id, where a test sets it.
  taxonomies: {} as Record<string, object>,
  // The stored rules, where a test sets them.
  rules: [] as object[],
  // The draft the rule modal was last opened with.
  modalDraft: vi.fn(),
}));

vi.mock("@/features/spending/hooks/use-spending-settings", () => ({
  useSpendingSettings: () => ({ isEnabled: true, isLoading: false, accountIds: [] }),
}));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ accounts: [] }) }));
vi.mock("@/hooks/use-taxonomies", () => ({
  useTaxonomy: (id: string) => mocks.taxonomies[id] ?? loaded,
}));
vi.mock("@/features/spending/hooks/use-categorization-rules", () => ({
  useCategorizationRules: () => ({ data: mocks.rules, isLoading: false, isError: false }),
  useRulePresets: () => ({ data: [], isError: false }),
  useCategorizationRuleMutations: () => ({
    create: useMutation({ mutationFn: mocks.create }),
    update: { mutateAsync: vi.fn(), isPending: false },
    remove: { mutate: vi.fn() },
    rerun: { mutate: vi.fn(), isPending: false },
  }),
}));
vi.mock("@/features/spending/components/rule-preset-picker", () => ({
  RulePresetPicker: () => null,
}));
const values: RuleFormValues = {
  name: "Coffee",
  pattern: "STARBUCKS",
  matchType: "contains",
  amountOp: "",
  amountValue: "",
  amountValue2: "",
  priority: 0,
  accountId: null,
  payeeConditionId: "payee-1",
  setPayeeId: null,
};
// The modal's form, reduced to its save.
vi.mock("@/features/spending/components/rule-edit-modal", () => ({
  RuleEditModal: ({
    open,
    draft,
    onSave,
    onClose,
  }: {
    open: boolean;
    draft?: object;
    onSave: (v: RuleFormValues) => void;
    onClose: () => void;
  }) => {
    if (!open) return null;
    mocks.modalDraft(draft);
    return (
      <div role="dialog">
        <button type="button" onClick={() => onSave(values)}>
          Save rule
        </button>
        <button type="button" onClick={onClose}>
          Close rule
        </button>
      </div>
    );
  },
}));
// Each rule, reduced to its name.
vi.mock("@/features/spending/components/rule-item", () => ({
  RuleItem: ({ rule }: { rule: { name: string } }) => <div data-testid="rule">{rule.name}</div>,
}));

afterEach(() => {
  mocks.rules = [];
  mocks.modalDraft.mockReset();
  delete mocks.taxonomies.payees;
});

/** Where the router is, and the state it carries. */
let location: ReturnType<typeof useLocation>;
function LocationProbe() {
  location = useLocation();
  return null;
}
const renderAt = (entry: string | { pathname: string; state: object }) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <SpendingRulesPage />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
const shownRules = () => screen.queryAllByTestId("rule").map((rule) => rule.textContent);
const storedRule = (name: string, overrides: object = {}) => ({
  id: name,
  name,
  pattern: name,
  matchType: "contains",
  taxonomyId: "spending_categories",
  categoryId: "cat",
  priority: 0,
  isGlobal: true,
  ...overrides,
});

it("narrows the list to the rules that name the payee in the address", () => {
  mocks.taxonomies.payees = {
    ...loaded,
    data: { categories: [{ id: "p1", name: "Corner Bakery", sortOrder: 0 }] },
  };
  mocks.rules = [
    storedRule("targets", { taxonomyId: "payees", categoryId: "p1" }),
    storedRule("matches on", { payeeConditionId: "p1" }),
    storedRule("also sets", { setPayeeId: "p1" }),
    storedRule("other payee", { taxonomyId: "payees", categoryId: "p2" }),
    storedRule("no payee"),
  ];

  renderAt("/settings/spending/rules?payee=p1");

  expect(shownRules().sort()).toEqual(["also sets", "matches on", "targets"]);
  expect(screen.getByText("Rules for payee: Corner Bakery")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Show all rules" }));

  expect(shownRules()).toHaveLength(5);
  expect(location.search).toBe("");
  expect(screen.queryByText(/^Rules for payee/)).not.toBeInTheDocument();
});

it("shows every rule without a payee in the address", () => {
  mocks.rules = [storedRule("a", { setPayeeId: "p1" }), storedRule("b")];

  renderAt("/settings/spending/rules");

  expect(shownRules()).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "Show all rules" })).not.toBeInTheDocument();
});

it("opens a new rule on the draft another screen proposed, once", () => {
  const ruleDraft = { name: "Corner Bakery", payeeConditionId: "p1" };

  renderAt({ pathname: "/settings/spending/rules", state: { ruleDraft } });

  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(mocks.modalDraft).toHaveBeenLastCalledWith(ruleDraft);

  fireEvent.click(screen.getByRole("button", { name: "Close rule" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  // Dropped from the history entry, so coming back does not reopen it.
  expect(location.state).toBeNull();

  // "Add rule" afterwards starts from nothing.
  fireEvent.click(screen.getAllByRole("button", { name: "Add rule" })[0]);
  expect(mocks.modalDraft).toHaveBeenLastCalledWith(undefined);
});

it("closes the new rule once its save ends while the screen is out of sight", async () => {
  // On a phone, a screen kept under another one is a hidden <Activity>; a save
  // left open there would be saved again from the same form.
  let finish: () => void = () => undefined;
  mocks.create.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
  const client = new QueryClient();
  const page = (hidden: boolean) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Activity mode={hidden ? "hidden" : "visible"}>
          <SpendingRulesPage />
        </Activity>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const saveStatus = () => client.getMutationCache().getAll()[0]?.state.status;
  const { rerender } = render(page(false));
  fireEvent.click(screen.getAllByRole("button", { name: "Add rule" })[0]);
  fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
  await waitFor(() => expect(saveStatus()).toBe("pending"));
  // The payee fields go with the rest of the rule, null included.
  expect((mocks.create.mock.calls[0] as unknown[])[0]).toMatchObject({
    pattern: "STARBUCKS",
    payeeConditionId: "payee-1",
    setPayeeId: null,
  });

  rerender(page(true));
  act(() => finish());
  await waitFor(() => expect(saveStatus()).toBe("success"));
  rerender(page(false));

  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

it("waits for the payees, and says so when they fail to load", () => {
  const client = new QueryClient();
  const page = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SpendingRulesPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
  try {
    mocks.taxonomies.payees = { data: undefined, isLoading: true, isError: false };
    const { rerender } = render(page());
    // Neither the rules nor their empty state: a payee rule would show an id.
    expect(screen.queryByText("No rules yet")).not.toBeInTheDocument();

    mocks.taxonomies.payees = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("payees are unreachable"),
    };
    rerender(page());

    expect(screen.getByText("payees are unreachable")).toBeInTheDocument();
  } finally {
    delete mocks.taxonomies.payees;
  }
});
