import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { render, screen, waitFor, within } from "@/test/render";

import { RunRulesDialog } from "./run-rules-dialog";

const mocks = vi.hoisted(() => ({ preview: vi.fn(), run: vi.fn() }));
vi.mock("../adapters/rules", () => ({
  previewCategorizationRulesRerun: mocks.preview,
  rerunCategorizationRulesDetailed: mocks.run,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const summary = (overrides: object = {}) => ({
  matched: 0,
  eligible: 0,
  changed: 0,
  protectedSplits: 0,
  protectedManual: 0,
  skippedExisting: 0,
  unchanged: 0,
  incompatible: 0,
  withoutTarget: 0,
  changedActivities: 0,
  keptManualActivities: 0,
  keptManualCategories: 0,
  keptManualPayees: 0,
  replacedManualActivities: 0,
  ...overrides,
});

const ids = ["a1", "a2", "a3"];
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <RunRulesDialog activityIds={ids} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), onClose, invalidate };
}

const overrideBox = () =>
  screen.getByRole("checkbox", {
    name: "Also replace categories and payees I set by hand (2)",
  });
const runButton = () => screen.getByRole("button", { name: "Run rules" });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.preview.mockResolvedValue(summary({ changedActivities: 3, keptManualActivities: 2 }));
  mocks.run.mockResolvedValue(summary({ changedActivities: 3, keptManualActivities: 2 }));
});

describe("preview", () => {
  it("previews the selected transactions without the override and says what would change", async () => {
    setup();

    expect(
      await screen.findByText("Rules will change 3 transactions. 2 you set by hand are kept."),
    ).toBeInTheDocument();
    expect(mocks.preview).toHaveBeenCalledWith(false, { activityIds: ids });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("uses the singular for one transaction", async () => {
    mocks.preview.mockResolvedValue(summary({ changedActivities: 1, keptManualActivities: 1 }));
    setup();

    expect(
      await screen.findByText("Rules will change 1 transaction. 1 you set by hand is kept."),
    ).toBeInTheDocument();
  });

  it("offers no override when nothing set by hand would be kept", async () => {
    mocks.preview.mockResolvedValue(summary({ changedActivities: 3 }));
    setup();

    expect(await screen.findByText("Rules will change 3 transactions.")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(runButton()).toBeEnabled();
  });

  it("has nothing to run when no rule changes the selection", async () => {
    mocks.preview.mockResolvedValue(summary());
    setup();

    expect(await screen.findByText("No rule changes these transactions.")).toBeInTheDocument();
    expect(runButton()).toBeDisabled();
  });

  it("does not let the rules run when the preview failed", async () => {
    mocks.preview.mockRejectedValue(new Error("offline"));
    setup();

    expect(
      await screen.findByText("Couldn't check what the rules would change. Close and try again."),
    ).toBeInTheDocument();
    expect(runButton()).toBeDisabled();
  });
});

describe("run", () => {
  it("leaves the override unticked and runs without it", async () => {
    const { user, onClose, invalidate } = setup();
    await screen.findByText(/Rules will change 3 transactions/);

    expect(overrideBox()).not.toBeChecked();
    await user.click(runButton());

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.run).toHaveBeenCalledWith(false, { activityIds: ids, overrideManual: false });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(invalidate).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Rules changed 3 transactions.", {
      description: "Set by hand and kept: 2.",
    });
  });

  it("asks once more before a ticked override runs", async () => {
    mocks.run.mockResolvedValue(
      summary({ changedActivities: 5, replacedManualActivities: 2, protectedSplits: 1 }),
    );
    const { user, onClose } = setup();
    await screen.findByText(/Rules will change 3 transactions/);

    await user.click(overrideBox());
    await user.click(runButton());

    // Nothing has run yet: the confirmation stands between the box and the run.
    const confirmation = await screen.findByRole("alertdialog", {
      name: "Replace what you set by hand?",
    });
    expect(confirmation).toHaveTextContent("This cannot be undone.");
    expect(confirmation).toHaveTextContent("transactions affected: 2");
    expect(mocks.run).not.toHaveBeenCalled();

    await user.click(within(confirmation).getByRole("button", { name: "Replace and run" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.run).toHaveBeenCalledWith(false, { activityIds: ids, overrideManual: true });
    expect(toast.success).toHaveBeenCalledWith("Rules changed 5 transactions.", {
      description: "Set by hand and replaced: 2. Splits kept: 1.",
    });
  });

  it("runs nothing when the confirmation is cancelled", async () => {
    const { user, onClose } = setup();
    await screen.findByText(/Rules will change 3 transactions/);

    await user.click(overrideBox());
    await user.click(runButton());
    const confirmation = await screen.findByRole("alertdialog");
    await user.click(within(confirmation).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(mocks.run).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // The box keeps its tick, and the next run asks again.
    expect(overrideBox()).toBeChecked();
  });

  it("can run for the override alone when only hand-set values stand in the way", async () => {
    mocks.preview.mockResolvedValue(summary({ keptManualActivities: 2 }));
    const { user } = setup();
    await screen.findByText("Rules will change 0 transactions. 2 you set by hand are kept.");

    expect(runButton()).toBeDisabled();
    await user.click(overrideBox());
    expect(runButton()).toBeEnabled();
  });

  it("stays open and says so when the run fails", async () => {
    mocks.run.mockRejectedValue(new Error("offline"));
    const { user, onClose } = setup();
    await screen.findByText(/Rules will change 3 transactions/);

    await user.click(runButton());

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Failed to run the rules."));
    expect(onClose).not.toHaveBeenCalled();
  });
});
