import { ActivityType } from "@/lib/constants";
import type { ActivityBulkMutationRequest, Account, TaxonomyCategory } from "@/lib/types";
import { act, render } from "@/test/render";
import type { useDataGrid } from "@wealthfolio/ui";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SpendingGridRow } from "../lib/spending-grid";
import type { CashActivity } from "../types/cash-activity";
import { SpendingActivityDataGrid } from "./spending-activity-data-grid";

type GridOptions = Parameters<typeof useDataGrid<SpendingGridRow>>[0];

const harness = vi.hoisted(() => ({
  options: undefined as unknown as GridOptions,
  toolbar: undefined as unknown as {
    onSave: () => Promise<void>;
    onCancel: () => void;
    hasUnsavedChanges: boolean;
  },
  saveActivities: vi.fn(),
  bulkAssign: vi.fn(),
  unassign: vi.fn(),
  toast: vi.fn(),
  suggestAfterEdit: vi.fn(),
}));

vi.mock("@wealthfolio/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wealthfolio/ui")>();
  return {
    ...actual,
    DataGrid: () => null,
    useDataGrid: (options: GridOptions) => {
      harness.options = options;
      return actual.useDataGrid(options);
    },
  };
});
vi.mock("@wealthfolio/ui/components/ui/use-toast", () => ({ toast: harness.toast }));
vi.mock("@/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/adapters")>()),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));
vi.mock("@/pages/activity/components/activity-data-grid/activity-data-grid-toolbar", () => ({
  ActivityDataGridToolbar: (props: typeof harness.toolbar) => {
    harness.toolbar = props;
    return null;
  },
}));
vi.mock("@/pages/activity/hooks/use-activity-mutations", () => ({
  useActivityMutations: () => ({
    saveActivitiesMutation: { mutateAsync: harness.saveActivities, isPending: false },
  }),
}));
vi.mock("../hooks/use-cash-activities", () => ({
  useBulkAssignCategories: () => ({ mutateAsync: harness.bulkAssign }),
}));
vi.mock("../adapters/cash-activities", () => ({ unassignActivityCategory: harness.unassign }));
vi.mock("./rule-suggestion-provider", () => ({
  useRuleSuggestions: () => ({
    suggestAfterEdit: harness.suggestAfterEdit,
    createRuleFor: vi.fn(),
  }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "USD" } }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

const ACCOUNT = {
  id: "cash",
  name: "Checking",
  accountType: "CASH",
  currency: "USD",
  isActive: true,
} as Account;

function activity(overrides: Partial<CashActivity> = {}): CashActivity {
  return {
    id: "a1",
    accountId: "cash",
    activityType: "WITHDRAWAL",
    status: "POSTED",
    activityDate: "2026-10-01T12:00:00.000Z",
    amount: "25",
    currency: "USD",
    isUserModified: false,
    needsReview: false,
    createdAt: "2026-10-01T12:00:00.000Z",
    updatedAt: "2026-10-01T12:00:00.000Z",
    cashFlowBucket: "spending",
    assignments: [
      {
        id: "asg",
        activityId: "a1",
        taxonomyId: "spending_categories",
        categoryId: "food",
        weight: 1,
        source: "manual",
        createdAt: "",
        updatedAt: "",
      },
    ],
    splits: [],
    netAmount: -25,
    ...overrides,
  } as CashActivity;
}

const NOTHING_SAVED = { created: [], updated: [], deleted: [], createdMappings: [], errors: [] };

function renderGrid(items: CashActivity[], payees?: TaxonomyCategory[]) {
  return render(gridElement(items, payees));
}

function gridElement(items: CashActivity[], payees?: TaxonomyCategory[]) {
  return (
    <SpendingActivityDataGrid
      items={items}
      payees={payees}
      accounts={[ACCOUNT]}
      categories={new Map()}
      sorting={[{ id: "date", desc: true }]}
      onSortingChange={() => undefined}
      pageIndex={0}
      pageSize={50}
      pageCount={1}
      totalRowCount={items.length}
      isFetching={false}
      onPageChange={() => undefined}
      onPageSizeChange={() => undefined}
      onRefetch={() => Promise.resolve()}
      onEdit={() => undefined}
      onEditSplits={() => undefined}
      onMarkReimbursement={() => undefined}
      onDuplicateTransfer={() => undefined}
      onLinkTransfer={() => undefined}
      onUnlinkTransfer={() => undefined}
      onLoanPayment={() => undefined}
    />
  );
}

const rows = () => harness.options.data;

function edit(id: string, patch: Partial<SpendingGridRow>) {
  act(() => {
    harness.options.onDataChange?.(
      rows().map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  });
}

async function save() {
  await act(async () => {
    await harness.toolbar.onSave();
  });
}

describe("SpendingActivityDataGrid", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.saveActivities.mockResolvedValue(NOTHING_SAVED);
    harness.bulkAssign.mockResolvedValue([]);
  });

  it("saves a category-only edit as one category batch and no activity write", async () => {
    renderGrid([activity()]);
    edit("a1", { categoryId: "rent" });
    await save();

    expect(harness.saveActivities).not.toHaveBeenCalled();
    expect(harness.bulkAssign).toHaveBeenCalledWith([
      { activityId: "a1", taxonomyId: "spending_categories", categoryId: "rent" },
    ]);
  });

  it("offers a rule for the category the saved rows were all given", async () => {
    renderGrid([activity(), activity({ id: "a2" })]);
    edit("a1", { categoryId: "rent" });
    edit("a2", { categoryId: "rent" });
    await save();

    expect(harness.suggestAfterEdit).toHaveBeenCalledTimes(1);
    expect(harness.suggestAfterEdit).toHaveBeenCalledWith(["a1", "a2"], {
      category: { taxonomyId: "spending_categories", categoryId: "rent" },
    });
  });

  it("offers no rule when the saved rows were given different categories", async () => {
    renderGrid([activity(), activity({ id: "a2" })]);
    edit("a1", { categoryId: "rent" });
    edit("a2", { categoryId: "travel" });
    await save();

    expect(harness.bulkAssign).toHaveBeenCalledTimes(1);
    expect(harness.suggestAfterEdit).not.toHaveBeenCalled();
  });

  it("saves an amount edit through the shared activity save and writes no category", async () => {
    harness.saveActivities.mockResolvedValue({
      ...NOTHING_SAVED,
      updated: [{ id: "a1" }],
    });
    renderGrid([activity()]);
    edit("a1", { amount: "12.5" });
    await save();

    const request = harness.saveActivities.mock.calls[0][0] as ActivityBulkMutationRequest;
    expect(request.updates).toHaveLength(1);
    expect(request.updates?.[0]).toMatchObject({ id: "a1", amount: "12.5" });
    expect(harness.bulkAssign).not.toHaveBeenCalled();
  });

  it("shows the bank description in its own column and never saves it", async () => {
    harness.saveActivities.mockResolvedValue({ ...NOTHING_SAVED, updated: [{ id: "a1" }] });
    renderGrid([activity({ notes: "Weekly shop", importedDescription: "TESCO STORES 3301" })]);

    expect(rows()[0]).toMatchObject({
      comment: "Weekly shop",
      importedDescription: "TESCO STORES 3301",
    });
    const column = harness.options.columns.find((c) => c.id === "importedDescription");
    expect(column?.header).toBe("spending:transactions.bankDescription");
    // No cell variant: the grid has no editor for it.
    expect(column?.meta?.cell).toBeUndefined();

    edit("a1", { comment: "Groceries" });
    await save();

    const request = harness.saveActivities.mock.calls[0][0] as ActivityBulkMutationRequest;
    expect(request.updates?.[0]).toMatchObject({ id: "a1", notes: "Groceries" });
    expect(request.updates?.[0]).not.toHaveProperty("importedDescription");
  });

  it("turns a new credit on a cash account into an external reimbursement", async () => {
    harness.saveActivities.mockResolvedValue({ ...NOTHING_SAVED, updated: [{ id: "a1" }] });
    renderGrid([activity({ assignments: [] })]);
    edit("a1", { activityType: ActivityType.CREDIT });
    await save();

    const update = (harness.saveActivities.mock.calls[0][0] as ActivityBulkMutationRequest)
      .updates?.[0];
    expect(update?.subtype).toBe("REIMBURSEMENT");
    expect(JSON.parse(update?.metadata as string)).toEqual({ flow: { is_external: true } });
  });

  it("refuses a category edit on a split row and leaves the row unchanged", () => {
    renderGrid([activity({ splits: [{ id: "s1" }] as CashActivity["splits"] })]);
    edit("a1", { categoryId: "rent" });

    expect(harness.toast).toHaveBeenCalledWith({ description: "spending:split.categoryProtected" });
    expect(rows()[0].categoryId).toBe("");
  });

  it("refuses a type change while a category pick waits to be saved", () => {
    renderGrid([activity()]);
    edit("a1", { categoryId: "rent" });
    edit("a1", { activityType: ActivityType.FEE });

    expect(harness.toast).toHaveBeenLastCalledWith({
      description: "spending:grid.saveCategoryFirst",
    });
    expect(rows()[0]).toMatchObject({ activityType: "WITHDRAWAL", categoryId: "rent" });
  });

  it("does not write categories when the activity save fails", async () => {
    harness.saveActivities.mockRejectedValue(new Error("offline"));
    renderGrid([activity()]);
    edit("a1", { amount: "30" });
    edit("a1", { categoryId: "rent" });
    await save();

    expect(harness.saveActivities).toHaveBeenCalledTimes(1);
    expect(harness.bulkAssign).not.toHaveBeenCalled();
  });

  it("keeps a failed category pick staged so Save can retry it", async () => {
    harness.bulkAssign.mockRejectedValueOnce(new Error("conflict"));
    renderGrid([activity()]);
    edit("a1", { categoryId: "rent" });
    await save();

    expect(rows()[0].categoryId).toBe("rent");
    // A category that was not saved is not one to make a rule of.
    expect(harness.suggestAfterEdit).not.toHaveBeenCalled();
    expect(harness.toolbar.hasUnsavedChanges).toBe(true);

    await save();
    expect(harness.bulkAssign).toHaveBeenCalledTimes(2);
    expect(harness.toolbar.hasUnsavedChanges).toBe(false);
  });

  it("redraws a row's payee cell when its payee is renamed", () => {
    const filed = activity({
      assignments: [
        {
          id: "asg-payee",
          activityId: "a1",
          taxonomyId: "payees",
          categoryId: "p1",
          weight: 1,
          source: "manual",
          createdAt: "",
          updatedAt: "",
        },
      ],
    });
    const payee = (name: string) => [{ id: "p1", name } as TaxonomyCategory];
    const payeeRenderKey = () =>
      harness.options.columns.find((column) => column.id === "payee")?.meta?.getRenderKey;
    const view = renderGrid([filed], payee("Corner Bakery"));
    const before = payeeRenderKey()?.(rows()[0]);
    expect(before).toBeDefined();

    view.rerender(gridElement([filed], payee("The Corner Bakery")));

    expect(payeeRenderKey()?.(rows()[0])).not.toBe(before);
  });

  it("restores the saved rows on Cancel even when the data does not change", () => {
    const items = [activity(), activity({ id: "a2", notes: "second" })];
    renderGrid(items);
    edit("a1", { amount: "99" });
    act(() => {
      harness.options.onRowsDelete?.([rows()[1]], [1]);
    });
    expect(rows()).toHaveLength(1);

    act(() => harness.toolbar.onCancel());

    expect(rows().map((row) => [row.id, row.amount])).toEqual([
      ["a1", "25"],
      ["a2", "25"],
    ]);
    expect(harness.toolbar.hasUnsavedChanges).toBe(false);
  });
});
