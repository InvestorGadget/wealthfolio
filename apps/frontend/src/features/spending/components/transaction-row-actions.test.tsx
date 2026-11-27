import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Account } from "@/lib/types";
import { render, screen } from "@/test/render";
import type { TransactionRowVM } from "../lib/transactions-helpers";
import { TransactionRowActions } from "./transaction-row-actions";

const ruleSuggestions = vi.hoisted(() => ({
  provided: false,
  createRuleFor: vi.fn(),
}));
vi.mock("./rule-suggestion-provider", () => ({
  useRuleSuggestions: () =>
    ruleSuggestions.provided
      ? { createRuleFor: ruleSuggestions.createRuleFor, suggestAfterEdit: vi.fn() }
      : null,
}));

function renderMenu(accountType: string, overrides: Partial<TransactionRowVM> = {}) {
  const row = {
    activity: {
      id: "credit-1",
      accountId: "acct",
      activityType: "CREDIT",
      amount: "450",
      currency: "CAD",
    },
    category: null,
    splitCount: 0,
    needsReview: false,
    ...overrides,
  } as unknown as TransactionRowVM;
  const handler = vi.fn();
  return render(
    <TransactionRowActions
      row={row}
      account={{ id: "acct", accountType, currency: "CAD" } as Account}
      onMarkReimbursement={handler}
      onEditSplits={handler}
      onEdit={handler}
      onDuplicate={handler}
      onDelete={handler}
      onLinkTransfer={handler}
    />,
  );
}

describe("TransactionRowActions", () => {
  // A payment saved as a card's refund/credit becomes the card's payment (#2740).
  it.each([
    ["CREDIT_CARD", true],
    ["CASH", false],
  ])("offers a %s account's credit Make it a transfer: %s", async (accountType, offered) => {
    const user = userEvent.setup();
    renderMenu(accountType);
    await user.click(screen.getByRole("button", { name: /actions/i }));
    await screen.findByRole("menuitem", { name: /edit/i });

    expect(!!screen.queryByRole("menuitem", { name: /Make it a transfer/ })).toBe(offered);
  });

  describe("Create rule", () => {
    const expense = {
      id: "exp-1",
      accountId: "acct",
      activityType: "WITHDRAWAL",
      amount: "12",
      currency: "CAD",
      cashFlowBucket: "spending",
    };
    const open = async () => {
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /actions/i }));
      await screen.findByRole("menuitem", { name: /edit/i });
      return user;
    };

    it("opens the rule form for the row, with the category it has", async () => {
      ruleSuggestions.provided = true;
      ruleSuggestions.createRuleFor.mockReset();
      renderMenu("CASH", {
        activity: expense,
        category: { taxonomyId: "spending_categories", id: "cat_groceries" },
      } as unknown as Partial<TransactionRowVM>);
      const user = await open();

      await user.click(screen.getByRole("menuitem", { name: "Create rule" }));
      expect(ruleSuggestions.createRuleFor).toHaveBeenCalledWith("exp-1", {
        taxonomyId: "spending_categories",
        categoryId: "cat_groceries",
      });
    });

    it("is offered for an uncategorized row too, and leaves the target to choose", async () => {
      ruleSuggestions.provided = true;
      ruleSuggestions.createRuleFor.mockReset();
      renderMenu("CASH", { activity: expense } as unknown as Partial<TransactionRowVM>);
      const user = await open();

      await user.click(screen.getByRole("menuitem", { name: "Create rule" }));
      expect(ruleSuggestions.createRuleFor).toHaveBeenCalledWith("exp-1", null);
    });

    it("is left out for a transfer, which takes no category, and where nothing provides it", async () => {
      ruleSuggestions.provided = true;
      const view = renderMenu("CASH", {
        activity: { ...expense, activityType: "TRANSFER_OUT", cashFlowBucket: "neutral" },
      } as unknown as Partial<TransactionRowVM>);
      await open();
      expect(screen.queryByRole("menuitem", { name: "Create rule" })).not.toBeInTheDocument();
      view.unmount();

      ruleSuggestions.provided = false;
      renderMenu("CASH", { activity: expense } as unknown as Partial<TransactionRowVM>);
      await open();
      expect(screen.queryByRole("menuitem", { name: "Create rule" })).not.toBeInTheDocument();
    });
  });
});
