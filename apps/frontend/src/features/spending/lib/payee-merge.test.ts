import { beforeEach, describe, expect, it, vi } from "vitest";

import { deleteCategory } from "@/adapters";

import { movePayeeActivities, searchCashActivities } from "../adapters/cash-activities";
import { listCategorizationRules, updateCategorizationRule } from "../adapters/rules";
import { mergePayee } from "./payee-merge";

vi.mock("@/adapters", () => ({ deleteCategory: vi.fn(() => Promise.resolve()) }));
vi.mock("../adapters/cash-activities", () => ({
  movePayeeActivities: vi.fn(() => Promise.resolve(3)),
  searchCashActivities: vi.fn(),
}));
vi.mock("../adapters/rules", () => ({
  listCategorizationRules: vi.fn(),
  updateCategorizationRule: vi.fn(() => Promise.resolve()),
}));

const rule = (id: string, taxonomyId: string, categoryId: string, payees: object = {}) =>
  ({ id, taxonomyId, categoryId, ...payees }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(searchCashActivities).mockResolvedValue({ items: [], totalCount: 0 } as never);
  vi.mocked(listCategorizationRules).mockResolvedValue([
    rule("r-old", "payees", "old"),
    rule("r-other-payee", "payees", "other"),
    // A category that happens to share the payee's id is not a payee rule.
    rule("r-category", "spending_categories", "old"),
  ]);
});

describe("mergePayee", () => {
  it("moves the transactions, then the rules, then deletes the payee", async () => {
    const steps: string[] = [];
    vi.mocked(movePayeeActivities).mockImplementationOnce(async () => {
      steps.push("transactions");
      return 3;
    });
    vi.mocked(updateCategorizationRule).mockImplementationOnce(async () => {
      steps.push("rules");
      return undefined as never;
    });
    vi.mocked(deleteCategory).mockImplementationOnce(async () => {
      steps.push("delete");
      return undefined as never;
    });

    await mergePayee("old", "new");

    // Not a search of the Spending accounts: a transaction outside them would
    // be left behind and the delete refused.
    expect(movePayeeActivities).toHaveBeenCalledWith("old", "new");
    expect(updateCategorizationRule).toHaveBeenCalledTimes(1);
    expect(updateCategorizationRule).toHaveBeenCalledWith("r-old", { categoryId: "new" });
    expect(deleteCategory).toHaveBeenCalledWith("payees", "old");
    expect(steps).toEqual(["transactions", "rules", "delete"]);
  });

  it("moves a rule that matches on the payee or also sets it", async () => {
    vi.mocked(listCategorizationRules).mockResolvedValue([
      rule("r-condition", "spending_categories", "cat", { payeeConditionId: "old" }),
      rule("r-also-sets", "spending_categories", "cat", { setPayeeId: "old" }),
      rule("r-other", "spending_categories", "cat", {
        payeeConditionId: "other",
        setPayeeId: null,
      }),
      rule("r-target", "payees", "old"),
    ]);

    await mergePayee("old", "new");

    expect(vi.mocked(updateCategorizationRule).mock.calls).toEqual([
      ["r-condition", { payeeConditionId: "new" }],
      ["r-also-sets", { setPayeeId: "new" }],
      ["r-target", { categoryId: "new" }],
    ]);
    expect(deleteCategory).toHaveBeenCalledWith("payees", "old");
  });

  it("reads the payee's bank texts before its transactions move", async () => {
    const steps: string[] = [];
    vi.mocked(searchCashActivities).mockImplementationOnce(async () => {
      steps.push("texts");
      return {
        items: [
          { importedDescription: "OLD SHOP 0042", notes: "lunch" },
          { notes: "old shop 0042" },
          { notes: "SQ *OLD SHOP" },
        ],
        totalCount: 3,
      } as never;
    });
    vi.mocked(movePayeeActivities).mockImplementationOnce(async () => {
      steps.push("move");
      return 3;
    });

    const bankTexts = await mergePayee("old", "new");

    // Once moved, nothing tells them from the destination's own transactions.
    expect(steps).toEqual(["texts", "move"]);
    expect(searchCashActivities).toHaveBeenCalledWith(
      expect.objectContaining({ payeeIds: ["old"] }),
    );
    expect(bankTexts).toEqual({ texts: ["OLD SHOP 0042", "SQ *OLD SHOP"], distinct: 2 });
  });

  it("still merges when the bank texts cannot be read, and then reports none", async () => {
    vi.mocked(searchCashActivities).mockRejectedValueOnce(new Error("offline"));

    expect(await mergePayee("old", "new")).toEqual({ texts: [], distinct: 0 });

    expect(movePayeeActivities).toHaveBeenCalledWith("old", "new");
    expect(deleteCategory).toHaveBeenCalledWith("payees", "old");
  });

  it("does not delete the payee when its transactions could not be moved", async () => {
    vi.mocked(movePayeeActivities).mockRejectedValueOnce(new Error("offline"));

    await expect(mergePayee("old", "new")).rejects.toThrow("offline");

    expect(updateCategorizationRule).not.toHaveBeenCalled();
    expect(deleteCategory).not.toHaveBeenCalled();
  });

  it("refuses to merge a payee into itself", async () => {
    await expect(mergePayee("old", "old")).rejects.toThrow();

    expect(movePayeeActivities).not.toHaveBeenCalled();
    expect(deleteCategory).not.toHaveBeenCalled();
  });
});
