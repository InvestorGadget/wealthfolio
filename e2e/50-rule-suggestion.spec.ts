import { expect, test, type Page } from "./fixtures";
import {
  restoreSpendingSettings,
  updateSettings,
  useSpendingAccounts,
  type Settings,
  type SpendingSettings,
} from "./api";
import { BASE_URL } from "./helpers";

// What each test changed, put back after it for the next spec on this worker.
let previousSettings: Settings | undefined;
let previousSpending: SpendingSettings | undefined;
test.afterEach(async ({ page }) => {
  if (previousSpending) await restoreSpendingSettings(page, previousSpending);
  if (previousSettings) await updateSettings(page, previousSettings);
  previousSpending = undefined;
  previousSettings = undefined;
});

interface Rule {
  id: string;
  name: string;
  pattern: string;
  matchType: string;
  categoryId: string | null;
}
interface Assignment {
  taxonomyId: string;
  categoryId: string;
  source: string;
}

async function spendingSession(page: Page) {
  const state = await (
    await page.request.post(`${BASE_URL}/api/v1/profiles/get_profile_state`, { data: {} })
  ).json();
  const unlocked = await page.request.post(`${BASE_URL}/api/v1/profiles/unlock_profile`, {
    data: { profileId: state.profiles[0].id },
  });
  expect(unlocked.ok()).toBeTruthy();
  const session = await unlocked.json();
  const headers = { "x-wf-profile-scope": session.scopeId };
  const api = async (path: string, data?: unknown, method = "POST") => {
    const response = await page.request.fetch(`${BASE_URL}/api/v1/${path}`, {
      method,
      headers,
      data,
    });
    expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
    const body = await response.text();
    return body ? JSON.parse(body) : undefined;
  };
  previousSettings = await updateSettings(page, {
    baseCurrency: "USD",
    timezone: "UTC",
    onboardingCompleted: true,
    language: "en",
    theme: "light",
    syncEnabled: false,
    autoUpdateCheckEnabled: false,
  });
  return api;
}

/** A tracked cash account with two charges the bank described alike, and a category. */
async function seed(page: Page, tag: string) {
  const api = await spendingSession(page);
  const account = await api("accounts", {
    name: `Rule suggestion ${tag}`,
    accountType: "CASH",
    currency: "USD",
    isDefault: false,
    isActive: true,
    trackingMode: "TRANSACTIONS",
  });
  previousSpending = await useSpendingAccounts(page, [account.id]);
  const category = await api("taxonomies/categories", {
    taxonomyId: "spending_categories",
    name: `Suggested ${tag}`,
    key: `rule_suggestion_e2e_${tag}`,
    color: "#123456",
    sortOrder: 0,
  });
  const text = `RULESUGGEST ${tag.toUpperCase()} 0042`;
  const charge = (daysAgo: number, amount: string) =>
    api("activities", {
      accountId: account.id,
      activityType: "WITHDRAWAL",
      activityDate: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
      currency: "USD",
      amount,
      notes: text,
      needsReview: false,
    });
  const filed = await charge(0, "11");
  const other = await charge(1, "12");
  const assignments = (activityId: string): Promise<Assignment[]> =>
    api(`spending/activities/${activityId}/assignments`, undefined, "GET");
  return { api, category, text, filed, other, assignments };
}

const EXPLAIN = "/api/v1/spending/rules/explain";
/** Counts the reads the prompt makes: none may be made while it is off or snoozed. */
function countExplainReads(page: Page) {
  const reads = { count: 0 };
  page.on("request", (request) => {
    if (request.url().includes(EXPLAIN)) reads.count += 1;
  });
  return reads;
}

/** The toast that offers a rule. */
const suggestion = (page: Page) =>
  page.getByRole("group", { name: "Always do this for transactions like this?" });

test("a category set by hand offers a rule, which is created and applied only on confirmation", async ({
  page,
}) => {
  const { api, category, text, filed, other, assignments } = await seed(page, "ltr");
  await page.goto(`${BASE_URL}/activities?tab=spending&dir=ltr`);

  // File the newest charge by hand.
  await page.getByRole("button", { name: "Assign category", exact: true }).first().click();
  await page.getByPlaceholder("Search categories...").fill(category.name);
  await page.getByRole("option", { name: category.name }).click();

  // The offer is a toast: the list behind it stays usable and nothing is saved yet.
  const prompt = suggestion(page);
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText(`Set ${category.name} whenever the bank's text is`);
  await expect(prompt).toContainText("You can turn suggestions off in Settings");
  await expect(page.getByRole("button", { name: "Assign category", exact: true })).toBeEnabled();
  expect(
    ((await api("spending/rules", undefined, "GET")) as Rule[]).some((r) => r.name === text),
  ).toBe(false);

  // Reachable and operable from the keyboard.
  const createRule = prompt.getByRole("button", { name: "Create rule", exact: true });
  await createRule.focus();
  await expect(createRule).toBeFocused();
  await page.keyboard.press("Enter");

  // The existing rule form opens filled in; the user confirms it there.
  const form = page.getByRole("dialog", { name: "Add rule", exact: true });
  await expect(form).toBeVisible();
  await expect(form.getByLabel("Rule name")).toHaveValue(text);
  await expect(form.getByLabel("Pattern", { exact: true })).toHaveValue(text);
  await form.getByRole("button", { name: "Create rule", exact: true }).click();
  await expect(form).not.toBeVisible();

  const rules = (await api("spending/rules", undefined, "GET")) as Rule[];
  const rule = rules.find((r) => r.name === text);
  expect(rule).toMatchObject({ pattern: text, matchType: "exact", categoryId: category.id });

  // Then, and only on confirmation, the other charge the rule matches is filed.
  const apply = page.getByRole("alertdialog");
  await expect(apply).toContainText("Apply to 1 matching uncategorized transaction?");
  await expect(apply).toContainText("categorized by hand");
  // An ordinary rule save files what it matches in the background within
  // moments (checked at the end of this test). This one must not: give that
  // run every chance to happen before taking the empty result at its word.
  for (let waited = 0; waited < 4000; waited += 500) {
    expect(await assignments(other.id)).toEqual([]);
    await page.waitForTimeout(500);
  }
  await apply.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(apply).not.toBeVisible();

  await expect
    .poll(async () => (await assignments(other.id)).map((a) => [a.categoryId, a.source]))
    .toEqual([[category.id, "rule"]]);
  // What was filed by hand stays filed by hand.
  expect((await assignments(filed.id)).map((a) => [a.categoryId, a.source])).toEqual([
    [category.id, "manual"],
  ]);

  // A rule now covers it: setting the same category again offers nothing more.
  await api(`spending/activities/${other.id}/assignments/spending_categories`, undefined, "DELETE");
  await page.reload();
  const explained = page.waitForResponse((response) => response.url().includes(EXPLAIN));
  await page.getByRole("button", { name: "Assign category", exact: true }).first().click();
  await page.getByPlaceholder("Search categories...").fill(category.name);
  await page.getByRole("option", { name: category.name }).click();
  expect((await explained).ok()).toBe(true);
  await expect
    .poll(async () => (await assignments(other.id)).map((a) => a.source))
    .toEqual(["manual"]);
  await expect(suggestion(page)).toHaveCount(0);

  // A rule saved anywhere else still files what it matches by itself, as before.
  if (rule) await api(`spending/rules/${rule.id}`, undefined, "DELETE");
  await api(`spending/activities/${other.id}/assignments/spending_categories`, undefined, "DELETE");
  const plain = (await api("spending/rules", {
    name: `${text} plain`,
    pattern: text,
    matchType: "exact",
    taxonomyId: "spending_categories",
    categoryId: category.id,
  })) as Rule;
  await expect
    .poll(async () => (await assignments(other.id)).map((a) => [a.categoryId, a.source]))
    .toEqual([[category.id, "rule"]]);
  await api(`spending/rules/${plain.id}`, undefined, "DELETE");
});

test("the offer fits a phone read right to left, and Not today silences it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { category, text } = await seed(page, "rtl");
  await page.goto(`${BASE_URL}/activities?tab=spending&dir=rtl`);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

  const pick = async () => {
    await page.getByRole("button", { name: "Assign category", exact: true }).first().click();
    await page.getByPlaceholder("Search categories...").fill(category.name);
    await page.getByRole("option", { name: category.name }).click();
  };
  await pick();

  const prompt = suggestion(page);
  await expect(prompt).toBeVisible();
  // Inside the screen, with nothing cut off or pushed past either edge.
  const box = await prompt.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  for (const name of ["Create rule", "Not today"]) {
    const button = await prompt.getByRole("button", { name, exact: true }).boundingBox();
    expect(button!.x).toBeGreaterThanOrEqual(box!.x - 1);
    expect(button!.x + button!.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  await prompt.getByRole("button", { name: "Not today", exact: true }).click();
  await expect(prompt).toHaveCount(0);

  // The second charge like it: filed by hand again, and nothing is offered
  // or even looked up.
  const reads = countExplainReads(page);
  await expect(page.getByText(text).first()).toBeVisible();
  await pick();
  await expect(page.getByRole("button", { name: "Assign category", exact: true })).toHaveCount(0);
  await expect(suggestion(page)).toHaveCount(0);
  expect(reads.count).toBe(0);
});

test("Create rule in a transaction's menu opens the form for it, and the setting switches the offer off", async ({
  page,
}) => {
  const { category, text } = await seed(page, "menu");

  // Switched off in Spending settings: filing by hand offers nothing.
  await page.goto(`${BASE_URL}/settings/spending`);
  const toggle = page.getByRole("switch", { name: "Suggest rules after I categorize" });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();

  await page.goto(`${BASE_URL}/activities?tab=spending`);
  const reads = countExplainReads(page);
  await page.getByRole("button", { name: "Assign category", exact: true }).first().click();
  await page.getByPlaceholder("Search categories...").fill(category.name);
  await page.getByRole("option", { name: category.name }).click();
  await expect(
    page.getByRole("button", { name: `Change category (${category.name})`, exact: true }),
  ).toBeVisible();
  await expect(suggestion(page)).toHaveCount(0);
  expect(reads.count).toBe(0);

  // The menu entry is asked for, so it works all the same.
  await page.getByRole("button", { name: "Row actions", exact: true }).first().click();
  await page.getByRole("menuitem", { name: "Create rule", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Add rule", exact: true });
  await expect(form).toBeVisible();
  await expect(form.getByLabel("Rule name")).toHaveValue(text);
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(form).not.toBeVisible();

  // Put the device preference back for the specs that follow in this browser.
  await page.goto(`${BASE_URL}/settings/spending`);
  await page.getByRole("switch", { name: "Suggest rules after I categorize" }).click();
});
