import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { render, screen } from "@/test/render";

import { TransactionsBulkBar } from "./transactions-bulk-bar";

vi.mock("./quick-categorize-popover", () => ({ QuickCategorizePopover: () => null }));
vi.mock("./quick-event-popover", () => ({ QuickEventPopover: () => null }));
vi.mock("./payee-field", () => ({ PayeeCommand: () => null }));

it("offers to run the rules on the selection", async () => {
  const onRunRules = vi.fn();
  const user = userEvent.setup();
  render(
    <TransactionsBulkBar
      selectedCount={2}
      categoryScope={null}
      onCategorize={vi.fn()}
      onTagEvent={vi.fn()}
      payees={[]}
      onSetPayee={vi.fn()}
      onRunRules={onRunRules}
      onDelete={vi.fn()}
      onClearSelection={vi.fn()}
    />,
  );

  await user.click(screen.getByRole("button", { name: "Run rules" }));

  expect(onRunRules).toHaveBeenCalledTimes(1);
});
