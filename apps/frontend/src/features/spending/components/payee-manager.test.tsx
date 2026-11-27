import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TaxonomyCategory } from "@/lib/types";
import { render, screen, within } from "@/test/render";

import { PayeeManager } from "./payee-manager";

const mocks = vi.hoisted(() => ({
  usage: vi.fn(),
  references: vi.fn(),
  merge: vi.fn(),
  ensure: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  rules: vi.fn(),
  listRules: vi.fn(),
}));
vi.mock("../hooks/use-categorization-rules", () => ({
  useCategorizationRules: () => ({ data: mocks.rules() }),
}));
vi.mock("../adapters/rules", () => ({ listCategorizationRules: mocks.listRules }));
vi.mock("../adapters/cash-activities", () => ({
  getPayeeUsage: mocks.usage,
  getPayeeReferences: mocks.references,
}));
vi.mock("../lib/payee-merge", () => ({ mergePayee: mocks.merge }));
vi.mock("../lib/payee", () => ({
  PAYEES_TAXONOMY_ID: "payees",
  ensurePayee: mocks.ensure,
  findPayee: (payees: TaxonomyCategory[], name: string) =>
    payees.find((p) => p.name.toLowerCase() === name.trim().toLowerCase()),
}));
vi.mock("@/hooks/use-taxonomies", async () => {
  const { useMutation } = await import("@tanstack/react-query");
  return {
    useUpdateCategory: () => useMutation({ mutationFn: mocks.update }),
    useDeleteCategory: () => useMutation({ mutationFn: mocks.remove }),
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const payee = (id: string, name: string) =>
  ({ id, name, taxonomyId: "payees" }) as TaxonomyCategory;
const water = payee("p-water", "City Water");
const bakery = payee("p-bakery", "Corner Bakery");

/** Where the router is, for the links and the navigation the list does. */
let location: ReturnType<typeof useLocation>;
function LocationProbe() {
  location = useLocation();
  return null;
}

function setup(payees = [water, bakery]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PayeeManager payees={payees} />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const rule = (overrides: object) =>
  ({ id: "r", isGlobal: true, matchType: "contains", pattern: "X", ...overrides }) as never;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.usage.mockResolvedValue({ "p-bakery": 3 });
  mocks.update.mockResolvedValue(undefined);
  mocks.remove.mockResolvedValue(undefined);
  mocks.ensure.mockResolvedValue(payee("p-new", "New Dentist"));
  mocks.rules.mockReturnValue([]);
  mocks.listRules.mockResolvedValue([]);
  mocks.merge.mockResolvedValue({ texts: [], distinct: 0 });
});

describe("list", () => {
  it("shows the payees by name, each with its transaction count", async () => {
    setup([bakery, water]);

    await screen.findByText("3");
    const rows = within(screen.getByTestId("payee-list")).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      "City Water0Create rule",
      "Corner Bakery3Create rule",
    ]);
  });

  it("shows how many rules name each payee, linked to those rules", async () => {
    mocks.rules.mockReturnValue([
      rule({ taxonomyId: "payees", categoryId: "p-bakery" }),
      rule({ taxonomyId: "spending_categories", categoryId: "c", payeeConditionId: "p-bakery" }),
      rule({ taxonomyId: "spending_categories", categoryId: "c", setPayeeId: "p-water" }),
      // A category rule that names no payee counts for none.
      rule({ taxonomyId: "spending_categories", categoryId: "p-water" }),
    ]);
    const user = setup();

    const bakeryRules = screen.getByRole("link", { name: "2 rules for Corner Bakery" });
    expect(bakeryRules).toHaveTextContent("2 rules");
    expect(screen.getByRole("link", { name: "1 rule for City Water" })).toHaveTextContent("1 rule");
    expect(screen.queryByRole("button", { name: /^Create rule for/ })).not.toBeInTheDocument();

    await user.click(bakeryRules);
    expect(location.pathname + location.search).toBe("/settings/spending/rules?payee=p-bakery");
  });

  it("offers to create a rule for a payee no rule names, started on that payee", async () => {
    const user = setup();

    await user.click(screen.getByRole("button", { name: "Create rule for City Water" }));

    expect(location.pathname).toBe("/settings/spending/rules");
    expect(location.state).toEqual({
      ruleDraft: { name: "City Water", payeeConditionId: "p-water" },
    });
  });

  it("shows neither a count nor the offer until the rules have loaded", () => {
    mocks.rules.mockReturnValue(undefined);
    setup();

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Create rule for/ })).not.toBeInTheDocument();
  });

  it("offers to add a payee even when there are none", async () => {
    const user = setup([]);

    await user.click(screen.getByRole("button", { name: "Add payee" }));
    await user.type(screen.getByLabelText("Name"), "New Dentist");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mocks.ensure).toHaveBeenCalledWith("New Dentist", []);
  });
});

describe("rename", () => {
  it("saves the new name", async () => {
    const user = setup();

    await user.click(screen.getByRole("button", { name: "Rename City Water" }));
    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Water Board");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: "p-water", name: "Water Board" }),
      expect.anything(),
    );
  });

  it("refuses a name another payee already has", async () => {
    const user = setup();

    await user.click(screen.getByRole("button", { name: "Rename City Water" }));
    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "corner bakery");

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});

describe("delete", () => {
  it("deletes a payee nothing uses", async () => {
    mocks.references.mockResolvedValue({ transactions: 0, rules: 0 });
    const user = setup();

    await user.click(screen.getByRole("button", { name: "Delete City Water" }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));

    expect(mocks.remove).toHaveBeenCalledWith(
      { taxonomyId: "payees", categoryId: "p-water" },
      expect.anything(),
    );
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it("asks where a payee in use should go before it can be deleted", async () => {
    mocks.references.mockResolvedValue({ transactions: 4, rules: 1 });
    const user = setup();

    await user.click(screen.getByRole("button", { name: "Delete Corner Bakery" }));

    const confirm = await screen.findByRole("button", { name: "Merge and delete" });
    expect(screen.getByText(/transactions: 4, rules: 1/)).toBeInTheDocument();
    expect(confirm).toBeDisabled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("merges a payee whose only transactions are on accounts outside Spending", async () => {
    // The list counts the Spending accounts only: none there, two elsewhere.
    mocks.references.mockResolvedValue({ transactions: 2, rules: 0 });
    const user = setup();

    await user.click(screen.getByRole("button", { name: "Delete City Water" }));
    expect(await screen.findByText(/transactions: 2, rules: 0/)).toBeInTheDocument();
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Corner Bakery" }));
    await user.click(screen.getByRole("button", { name: "Merge and delete" }));

    expect(mocks.merge).toHaveBeenCalledWith("p-water", "p-bakery");
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});

describe("rule offered after a merge", () => {
  const texts = ["CITY WATER 0042", "WATER BOARD DD"];
  const mergeWater = async (user: ReturnType<typeof setup>) => {
    mocks.references.mockResolvedValue({ transactions: 2, rules: 0 });
    await user.click(screen.getByRole("button", { name: "Delete City Water" }));
    await screen.findByText(/transactions: 2, rules: 0/);
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Corner Bakery" }));
    await user.click(screen.getByRole("button", { name: "Merge and delete" }));
  };
  const offerTitle =
    'Also file future transactions like those of "City Water" under "Corner Bakery"?';

  it("offers a rule for the merged payee's bank texts, filed under the destination", async () => {
    mocks.merge.mockResolvedValue({ texts, distinct: 2 });
    const user = setup();

    await mergeWater(user);

    const dialog = await screen.findByRole("alertdialog", { name: offerTitle });
    expect(dialog).toHaveTextContent("bank descriptions: 2");
    expect(dialog).not.toHaveTextContent("most frequent");
    await user.click(within(dialog).getByRole("button", { name: "Create rule" }));

    expect(location.pathname).toBe("/settings/spending/rules");
    expect(location.state).toEqual({
      ruleDraft: {
        name: "Corner Bakery",
        pattern: "(?i)^(?:CITY WATER 0042|WATER BOARD DD)$",
        matchType: "regex",
        taxonomyId: "payees",
        categoryId: "p-bakery",
      },
    });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("says so when the rule holds only the most frequent texts", async () => {
    mocks.merge.mockResolvedValue({ texts, distinct: 31 });
    const user = setup();

    await mergeWater(user);

    expect(await screen.findByRole("alertdialog", { name: offerTitle })).toHaveTextContent(
      "Only the 2 most frequent of 31 bank descriptions fit in the rule.",
    );
  });

  it("can be declined, which creates nothing", async () => {
    mocks.merge.mockResolvedValue({ texts, distinct: 2 });
    const user = setup();

    await mergeWater(user);
    await user.click(await screen.findByRole("button", { name: "Not now" }));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(location.pathname).toBe("/");
  });

  it("is skipped when the merged payee had no transactions with a bank text", async () => {
    const user = setup();

    await mergeWater(user);

    await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(mocks.merge).toHaveBeenCalledWith("p-water", "p-bakery");
    expect(mocks.listRules).not.toHaveBeenCalled();
  });

  it("stays busy until the offer is decided, so the merge cannot be confirmed twice", async () => {
    mocks.merge.mockResolvedValue({ texts, distinct: 2 });
    let finish: (rules: object[]) => void = () => undefined;
    mocks.listRules.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const user = setup();

    await mergeWater(user);

    await vi.waitFor(() => expect(mocks.listRules).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Merge and delete" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(mocks.merge).toHaveBeenCalledTimes(1);

    finish([]);
    expect(await screen.findByRole("alertdialog", { name: offerTitle })).toBeInTheDocument();
  });

  it("is skipped when a rule for the destination already lists every text", async () => {
    mocks.merge.mockResolvedValue({ texts, distinct: 2 });
    // Read after the merge, which moved the merged payee's rule to the destination.
    mocks.listRules.mockResolvedValue([
      rule({
        taxonomyId: "payees",
        categoryId: "p-bakery",
        matchType: "regex",
        pattern: "(?i)^(?:WATER BOARD DD|CITY WATER 0042|ELSE)$",
      }),
    ]);
    const user = setup();

    await mergeWater(user);

    await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(mocks.listRules).toHaveBeenCalled();
    expect(location.pathname).toBe("/");
  });
});
