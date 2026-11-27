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
  const onRan = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <RunRulesDialog activityIds={ids} onClose={onClose} onRan={onRan} />
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), onClose, onRan, invalidate };
}

/** The preview of the protected run, and of the run that replaces hand-set values. */
function previews(protectedRun: object, overriding: object = protectedRun) {
  mocks.preview.mockImplementation(
    async (_onlyUncategorized: boolean, scope: { overrideManual?: boolean }) =>
      summary(scope.overrideManual ? overriding : protectedRun),
  );
}
const PROTECTED = "Rules will change 3 transactions. 2 transactions you set by hand are kept.";
const OVERRIDING = "Rules will change 5 transactions. 2 transactions you set by hand are replaced.";

const overrideBox = () =>
  screen.getByRole("checkbox", {
    name: "Also replace categories and payees I set by hand (2)",
  });
const runButton = () => screen.getByRole("button", { name: "Run rules" });

beforeEach(() => {
  vi.resetAllMocks();
  previews(
    { changedActivities: 3, keptManualActivities: 2 },
    { changedActivities: 5, replacedManualActivities: 2 },
  );
  mocks.run.mockResolvedValue(summary({ changedActivities: 3, keptManualActivities: 2 }));
});

describe("preview", () => {
  it("previews the protected run on the selection and says what would change", async () => {
    setup();

    const status = await screen.findByText(PROTECTED);
    // Announced when it arrives.
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(mocks.preview).toHaveBeenCalledTimes(1);
    expect(mocks.preview).toHaveBeenCalledWith(false, { activityIds: ids, overrideManual: false });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("previews again with the override when the box is ticked, and shows those numbers", async () => {
    const { user } = setup();
    await screen.findByText(PROTECTED);

    await user.click(overrideBox());

    expect(await screen.findByText(OVERRIDING)).toBeInTheDocument();
    expect(screen.queryByText(PROTECTED)).not.toBeInTheDocument();
    expect(mocks.preview).toHaveBeenLastCalledWith(false, {
      activityIds: ids,
      overrideManual: true,
    });
    // The box keeps naming what the protected run would keep.
    expect(overrideBox()).toBeChecked();

    await user.click(overrideBox());
    expect(await screen.findByText(PROTECTED)).toBeInTheDocument();
  });

  it("uses the singular for one transaction", async () => {
    previews({ changedActivities: 1, keptManualActivities: 1 });
    setup();

    expect(
      await screen.findByText(
        "Rules will change 1 transaction. 1 transaction you set by hand is kept.",
      ),
    ).toBeInTheDocument();
  });

  it("offers no override when nothing set by hand would be kept", async () => {
    previews({ changedActivities: 3 });
    setup();

    expect(await screen.findByText("Rules will change 3 transactions.")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(runButton()).toBeEnabled();
  });

  it("has nothing to run when no rule changes the selection", async () => {
    previews({});
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
    const { user, onClose, onRan, invalidate } = setup();
    await screen.findByText(PROTECTED);

    expect(overrideBox()).not.toBeChecked();
    await user.click(runButton());

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.run).toHaveBeenCalledWith(false, { activityIds: ids, overrideManual: false });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(invalidate).toHaveBeenCalled();
    // The selection is done with, as after the other bulk actions.
    expect(onRan).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith("Rules changed 3 transactions.", {
      description: "Set by hand and kept: 2.",
    });
  });

  it("asks once more before a ticked override runs", async () => {
    mocks.run.mockResolvedValue(
      summary({ changedActivities: 5, replacedManualActivities: 2, protectedSplits: 1 }),
    );
    const { user, onClose } = setup();
    await screen.findByText(PROTECTED);

    await user.click(overrideBox());
    await screen.findByText(OVERRIDING);
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
    const { user, onClose, onRan } = setup();
    await screen.findByText(PROTECTED);

    await user.click(overrideBox());
    await screen.findByText(OVERRIDING);
    await user.click(runButton());
    const confirmation = await screen.findByRole("alertdialog");
    await user.click(within(confirmation).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(mocks.run).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onRan).not.toHaveBeenCalled();
    // The box keeps its tick, and the next run asks again.
    expect(overrideBox()).toBeChecked();
  });

  it("can run for the override alone when only hand-set values stand in the way", async () => {
    previews({ keptManualActivities: 2 }, { changedActivities: 2, replacedManualActivities: 2 });
    mocks.run.mockResolvedValue(summary({ changedActivities: 2, replacedManualActivities: 2 }));
    const { user, onClose } = setup();
    await screen.findByText(
      "Rules will change 0 transactions. 2 transactions you set by hand are kept.",
    );

    expect(runButton()).toBeDisabled();
    await user.click(overrideBox());
    await screen.findByText(
      "Rules will change 2 transactions. 2 transactions you set by hand are replaced.",
    );
    await user.click(runButton());
    const confirmation = await screen.findByRole("alertdialog");
    await user.click(within(confirmation).getByRole("button", { name: "Replace and run" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.run).toHaveBeenCalledWith(false, { activityIds: ids, overrideManual: true });
    expect(toast.success).toHaveBeenCalledWith("Rules changed 2 transactions.", {
      description: "Set by hand and replaced: 2.",
    });
  });

  it("does not run while the override's preview is still loading", async () => {
    let finish: (value: object) => void = () => undefined;
    mocks.preview.mockImplementation((_: boolean, scope: { overrideManual?: boolean }) =>
      scope.overrideManual
        ? new Promise((resolve) => (finish = resolve))
        : Promise.resolve(summary({ changedActivities: 3, keptManualActivities: 2 })),
    );
    const { user } = setup();
    await screen.findByText(PROTECTED);

    await user.click(overrideBox());

    expect(await screen.findByText("Checking what the rules would change…")).toBeInTheDocument();
    expect(runButton()).toBeDisabled();
    finish(summary({ changedActivities: 5, replacedManualActivities: 2 }));
    expect(await screen.findByText(OVERRIDING)).toBeInTheDocument();
    expect(runButton()).toBeEnabled();
  });

  it("stays open and says so when the run fails", async () => {
    mocks.run.mockRejectedValue(new Error("offline"));
    const { user, onClose, onRan } = setup();
    await screen.findByText(PROTECTED);

    await user.click(runButton());

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Failed to run the rules."));
    expect(onClose).not.toHaveBeenCalled();
    expect(onRan).not.toHaveBeenCalled();
  });
});
