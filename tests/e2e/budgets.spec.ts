import { test, expect, type Page } from "./fixtures";

//
// Monthly category budgets (specs/budgets/spec.md). Spending is set up via
// the TEST_MODE /test-add-transaction route, which runs the same over-budget
// evaluation as the createTransaction server function. Fixture users are
// seeded with the default category tree (Groceries > Vegetables, Fruits, …)
// and a free plan.

async function addTransaction(
  page: Page,
  amountMinor: number,
  categoryName: string,
) {
  const res = await page.request.post("/test-add-transaction", {
    data: { amountMinor, categoryName },
  });
  expect(res.ok()).toBe(true);
}

async function createBudget(page: Page, category: string, limit: string) {
  await page.getByRole("button", { name: /New budget|Create your first budget/ }).first().click();
  await expect(page.getByRole("heading", { name: "New budget" })).toBeVisible();
  await page.getByLabel("Category").selectOption({ label: category });
  await page.getByLabel(/Monthly limit/).fill(limit);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: "New budget" })).toBeHidden();
}

const card = (page: Page, category: string) =>
  page.getByTestId("budget-card").filter({ hasText: category });

test.describe("Budgets", () => {
  test.beforeEach(async ({ page, signedInUser: _signedInUser }) => {
    await page.goto("/budgets");
  });

  test("is in the navigation and supports create, edit and delete", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "Budgets" })
      .click();
    await expect(page).toHaveURL("/budgets");
    await expect(page.getByText("No budgets yet")).toBeVisible();
    await expect(page.getByTestId("budgets-usage")).toHaveText(
      "0 of 3 budgets (Free plan)",
    );

    await createBudget(page, "Transport", "400");
    await expect(card(page, "Transport").getByTestId("budget-spent")).toHaveText(
      "0.00 of 400.00 PLN",
    );
    await expect(card(page, "Transport").getByTestId("budget-left")).toHaveText(
      "400.00 left",
    );

    await card(page, "Transport").getByTestId("budget-edit-btn").click();
    await page.getByLabel(/Monthly limit/).fill("650.50");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(card(page, "Transport").getByTestId("budget-spent")).toHaveText(
      "0.00 of 650.50 PLN",
    );

    await card(page, "Transport").getByTestId("budget-delete-btn").click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(card(page, "Transport")).toHaveCount(0);
    await expect(page.getByText("No budgets yet")).toBeVisible();
  });

  test("rejects invalid limits and already-budgeted categories", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "New budget" }).click();
    await page.getByLabel("Category").selectOption({ label: "Health" });
    for (const value of ["", "0", "-5", "abc"]) {
      await page.getByLabel(/Monthly limit/).fill(value);
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByRole("alert")).toHaveText(
        "Enter a limit greater than 0.",
      );
    }
    await page.getByLabel(/Monthly limit/).fill("100");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(card(page, "Health")).toBeVisible();

    // The budgeted category is no longer offered.
    await page.getByRole("button", { name: "New budget" }).click();
    await expect(
      page.getByLabel("Category").locator("option", { hasText: /^Health$/ }),
    ).toHaveCount(0);
  });

  test("a parent budget sums its subcategories, shown in the details pie", async ({
    page,
  }) => {
    await createBudget(page, "Groceries", "1000");
    await addTransaction(page, -10_000, "Groceries");
    await addTransaction(page, -3_000, "Vegetables");
    await addTransaction(page, -2_050, "Fruits");
    await addTransaction(page, 5_000, "Groceries"); // refund — ignored
    await page.reload();

    const groceries = card(page, "Groceries");
    await expect(groceries).toContainText("Includes subcategories");
    await expect(groceries.getByTestId("budget-spent")).toHaveText(
      "150.50 of 1000.00 PLN",
    );
    await expect(groceries.getByTestId("budget-left")).toHaveText("849.50 left");

    await page
      .getByRole("button", { name: "Show details for Groceries" })
      .click();
    await expect(
      page.getByRole("heading", { name: /^Groceries — / }),
    ).toBeVisible();
    const breakdown = page.getByTestId("budget-breakdown");
    await expect(breakdown.getByRole("listitem")).toHaveText([
      /Groceries \(no subcategory\)\s*100\.00 \(66%\)/,
      /Vegetables\s*30\.00 \(20%\)/,
      /Fruits\s*20\.50 \(14%\)/,
    ]);
  });

  test("going over shows the over state, the alert bar and sends one email", async ({
    page,
    signedInUser,
  }) => {
    await createBudget(page, "Entertainment", "50");
    await addTransaction(page, -6_000, "Entertainment");
    await addTransaction(page, -1_000, "Entertainment");
    await page.reload();

    const entertainment = card(page, "Entertainment");
    await expect(entertainment).toContainText("Over budget");
    await expect(entertainment.getByTestId("budget-left")).toHaveText(
      "20.00 over",
    );
    await expect(page.getByTestId("budgets-over-count")).toHaveText("1");

    // Alert bar on another page, linking back to Budgets.
    await page.goto("/transactions");
    const bar = page.getByTestId("budget-alert-bar");
    await expect(bar).toContainText(
      "Entertainment is over budget: 70.00 of 50.00 PLN spent this month.",
    );
    await bar.getByRole("link").click();
    await expect(page).toHaveURL("/budgets");

    // Exactly one email even though two transactions were over the limit.
    const emails = await page.request.get(
      `/test-emails?to=${signedInUser.username}@example.com`,
    );
    const { emails: sent } = (await emails.json()) as {
      emails: Array<{ subject: string; text: string }>;
    };
    const budgetEmails = sent.filter((e) => e.subject.includes("budget"));
    expect(budgetEmails).toHaveLength(1);
    expect(budgetEmails[0].subject).toContain("Entertainment");
    expect(budgetEmails[0].text).toContain("/budgets");

    // Dismiss hides the bar until another budget goes over.
    await page.getByRole("button", { name: "Dismiss budget alert" }).click();
    await expect(page.getByTestId("budget-alert-bar")).toBeHidden();
    await page.reload();
    await expect(page.getByTestId("budget-alert-bar")).toBeHidden();
    await createBudget(page, "Health", "10");
    await addTransaction(page, -2_000, "Health");
    await page.reload();
    await expect(page.getByTestId("budget-alert-bar")).toContainText(
      "2 budgets are over this month",
    );
  });

  test("free plan is limited to 3 budgets and invites to upgrade", async ({
    page,
  }) => {
    await createBudget(page, "Groceries", "100");
    await createBudget(page, "Housing", "100");
    await createBudget(page, "Transport", "100");
    await expect(page.getByTestId("budgets-usage")).toHaveText(
      "3 of 3 budgets (Free plan)",
    );

    await page.getByRole("button", { name: "New budget" }).click();
    await expect(
      page.getByRole("heading", { name: "You've reached the Free plan limit" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "New budget" })).toHaveCount(0);
    await page.getByRole("link", { name: /See Pro plan/ }).click();
    await expect(page).toHaveURL("/billing");
    await expect(page.getByTestId("billing-budgets-usage")).toHaveText(
      "3 of 3 budgets",
    );
  });

  test("pro plan has unlimited budgets", async ({ page }) => {
    const res = await page.request.post("/test-set-plan?plan=pro");
    expect(res.ok()).toBe(true);
    await page.goto("/budgets");

    for (const category of ["Groceries", "Housing", "Transport", "Health"]) {
      await createBudget(page, category, "100");
    }
    await expect(page.getByTestId("budget-card")).toHaveCount(4);
    await expect(page.getByTestId("budgets-usage")).toHaveText(
      "4 budgets (Pro, unlimited)",
    );

    await page.goto("/billing");
    await expect(page.getByTestId("billing-budgets-usage")).toHaveText(
      "4 budgets (unlimited)",
    );
  });
});
