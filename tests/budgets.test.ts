// @vitest-environment node
// Required: TanStack Start's import protection mocks server modules in jsdom (client) environment.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import {
  createBudget,
  deleteBudget,
  deleteBudgetsForCategories,
  evaluateBudgetAlerts,
  getBudgetsOverview,
  updateBudgetLimit,
} from "../src/server/budgets.server.ts";
import { collectUserExport, hardDeleteUser } from "../src/server/compliance.server.ts";
import { getCapturedEmails } from "../src/server/email.ts";

// Fixed "now" in October 2026 (UTC) so month boundaries are deterministic.
const NOW = new Date("2026-10-15T12:00:00Z");
const NEXT_MONTH = new Date("2026-11-03T12:00:00Z");

describe("monthly category budgets", () => {
  const userId = "budget-test-user";
  const otherId = "budget-test-other";
  const email = "budget-test-user@example.com";
  const ACCOUNT = "budget-acc";
  // Category tree: Groceries > Vegetables > Organic, Groceries > Fruits; Fuel.
  const GROCERIES = "budget-cat-groceries";
  const VEGETABLES = "budget-cat-vegetables";
  const ORGANIC = "budget-cat-organic";
  const FRUITS = "budget-cat-fruits";
  const FUEL = "budget-cat-fuel";
  const FOREIGN = "budget-cat-foreign";

  let txnSeq = 0;
  const addTxn = (amountMinor: number, categoryId: string | null, date = "2026-10-10") =>
    db.insert(schema.transactions).values({
      id: `budget-txn-${++txnSeq}`,
      user_id: userId,
      account_id: ACCOUNT,
      date,
      amount_minor: amountMinor,
      category_id: categoryId,
    });

  const setPlan = (plan: "free" | "pro", status = "active") =>
    db
      .insert(schema.subscriptions)
      .values({ user_id: userId, plan, status })
      .onConflictDoUpdate({
        target: schema.subscriptions.user_id,
        set: { plan, status },
      });

  // The test email capture buffer is process-wide: count only emails sent
  // during the current test.
  let emailBaseline = 0;
  const budgetEmails = () =>
    getCapturedEmails(email).filter((e) => e.subject.includes("budget"));
  const emailsForUser = () => budgetEmails().slice(emailBaseline);

  beforeEach(async () => {
    emailBaseline = budgetEmails().length;
    await db.insert(schema.users).values([
      {
        id: userId,
        username: userId,
        email,
        email_verified_at: new Date(),
        password_hash: "x",
      },
      { id: otherId, username: otherId, password_hash: "x" },
    ]);
    await db
      .insert(schema.accounts)
      .values({ id: ACCOUNT, user_id: userId, name: "Main" });
    await db.insert(schema.categories).values([
      { id: GROCERIES, user_id: userId, name: "Groceries", parent_id: null },
      { id: VEGETABLES, user_id: userId, name: "Vegetables", parent_id: GROCERIES },
      { id: ORGANIC, user_id: userId, name: "Organic", parent_id: VEGETABLES },
      { id: FRUITS, user_id: userId, name: "Fruits", parent_id: GROCERIES },
      { id: FUEL, user_id: userId, name: "Fuel", parent_id: null },
      { id: FOREIGN, user_id: otherId, name: "Foreign", parent_id: null },
    ]);
  });

  afterEach(async () => {
    for (const id of [userId, otherId]) {
      await db.delete(schema.budget_alerts).where(eq(schema.budget_alerts.user_id, id));
      await db.delete(schema.budgets).where(eq(schema.budgets.user_id, id));
      await db.delete(schema.transactions).where(eq(schema.transactions.user_id, id));
      await db.delete(schema.subscriptions).where(eq(schema.subscriptions.user_id, id));
      await db.delete(schema.accounts).where(eq(schema.accounts.user_id, id));
      await db.delete(schema.categories).where(eq(schema.categories.user_id, id));
      await db.delete(schema.users).where(eq(schema.users.id, id));
    }
  });

  const create = async (categoryId: string, limitMinor: number) => {
    const result = await createBudget(userId, { categoryId, limitMinor }, db, NOW);
    if (!("success" in result)) throw new Error(result.error);
    return result.id;
  };

  it("counts only this month's expenses, across the whole category subtree", async () => {
    await create(GROCERIES, 100_000);
    await addTxn(-10_000, GROCERIES); // direct
    await addTxn(-2_000, VEGETABLES); // child
    await addTxn(-500, ORGANIC); // grandchild
    await addTxn(-1_500, FRUITS);
    await addTxn(5_000, GROCERIES); // refund — ignored, never offsets spending
    await addTxn(-9_999, GROCERIES, "2026-09-30"); // previous month
    await addTxn(-9_999, GROCERIES, "2026-11-01"); // next month
    await addTxn(-7_000, FUEL); // other category

    const { budgets, month } = await getBudgetsOverview(userId, db, NOW);
    expect(month).toBe("2026-10");
    expect(budgets).toHaveLength(1);
    const [b] = budgets;
    expect(b.spentMinor).toBe(14_000);
    expect(b.leftMinor).toBe(86_000);
    expect(b.isOver).toBe(false);
    expect(b.hasSubcategories).toBe(true);
    // Pie slices: direct + one per direct child (child includes grandchild).
    expect(b.breakdown).toEqual([
      expect.objectContaining({ categoryId: null, amountMinor: 10_000 }),
      expect.objectContaining({ categoryId: VEGETABLES, amountMinor: 2_500 }),
      expect.objectContaining({ categoryId: FRUITS, amountMinor: 1_500 }),
    ]);
    const sliceTotal = b.breakdown.reduce((sum, s) => sum + s.amountMinor, 0);
    expect(sliceTotal).toBe(b.spentMinor);
  });

  it("is over only when spent exceeds the limit, and resets next month", async () => {
    await create(FUEL, 5_000);
    await addTxn(-5_000, FUEL);
    let [b] = (await getBudgetsOverview(userId, db, NOW)).budgets;
    expect(b.isOver).toBe(false);
    expect(b.leftMinor).toBe(0);

    await addTxn(-1, FUEL);
    [b] = (await getBudgetsOverview(userId, db, NOW)).budgets;
    expect(b.isOver).toBe(true);
    expect(b.leftMinor).toBe(-1);

    [b] = (await getBudgetsOverview(userId, db, NEXT_MONTH)).budgets;
    expect(b.spentMinor).toBe(0);
    expect(b.isOver).toBe(false);
  });

  it("rejects duplicates, foreign categories and unknown budgets", async () => {
    await create(FUEL, 5_000);
    expect(await createBudget(userId, { categoryId: FUEL, limitMinor: 1 }, db, NOW)).toMatchObject({
      code: "budget_exists",
    });
    expect(await createBudget(userId, { categoryId: FOREIGN, limitMinor: 1 }, db, NOW)).toMatchObject({
      code: "category_not_found",
    });
    const id = (await getBudgetsOverview(userId, db, NOW)).budgets[0].id;
    // Another user can neither edit nor delete it.
    expect(await updateBudgetLimit(otherId, { id, limitMinor: 1 }, db, NOW)).toMatchObject({
      code: "budget_not_found",
    });
    expect(await deleteBudget(otherId, id, db)).toMatchObject({ code: "budget_not_found" });
    expect((await getBudgetsOverview(userId, db, NOW)).budgets[0].limitMinor).toBe(5_000);
  });

  it("edits the limit and deletes the budget", async () => {
    const id = await create(FUEL, 5_000);
    expect(await updateBudgetLimit(userId, { id, limitMinor: 9_000 }, db, NOW)).toEqual({
      success: true,
      id,
    });
    expect((await getBudgetsOverview(userId, db, NOW)).budgets[0].limitMinor).toBe(9_000);
    expect(await deleteBudget(userId, id, db)).toEqual({ success: true, id });
    expect((await getBudgetsOverview(userId, db, NOW)).budgets).toHaveLength(0);
  });

  it("limits free users to 3 budgets, Pro is unlimited, downgrade keeps existing", async () => {
    await create(GROCERIES, 1);
    await create(VEGETABLES, 1);
    await create(FRUITS, 1);
    expect(await createBudget(userId, { categoryId: FUEL, limitMinor: 1 }, db, NOW)).toMatchObject({
      code: "budget_limit_reached",
      limit: 3,
    });

    await setPlan("pro");
    await create(FUEL, 1);
    await create(ORGANIC, 1);
    expect((await getBudgetsOverview(userId, db, NOW)).usage).toEqual({
      count: 5,
      limit: null,
      plan: "pro",
    });

    // Downgrade: all 5 kept and editable, creation blocked.
    await setPlan("free", "canceled");
    const overview = await getBudgetsOverview(userId, db, NOW);
    expect(overview.budgets).toHaveLength(5);
    expect(
      await updateBudgetLimit(userId, { id: overview.budgets[0].id, limitMinor: 2 }, db, NOW),
    ).toMatchObject({ success: true });
    await db.delete(schema.budgets).where(eq(schema.budgets.category_id, ORGANIC));
    expect(await createBudget(userId, { categoryId: ORGANIC, limitMinor: 1 }, db, NOW)).toMatchObject({
      code: "budget_limit_reached",
    });
  });

  it("never lets concurrent creates exceed the free limit", async () => {
    const results = await Promise.all(
      [GROCERIES, VEGETABLES, ORGANIC, FRUITS, FUEL].map((categoryId) =>
        createBudget(userId, { categoryId, limitMinor: 1 }, db, NOW),
      ),
    );
    expect(results.filter((r) => "success" in r)).toHaveLength(3);
    expect((await getBudgetsOverview(userId, db, NOW)).usage.count).toBe(3);
  });

  it("sends at most one over-budget email per budget per month", async () => {
    const id = await create(FUEL, 5_000);
    await addTxn(-6_000, FUEL);
    expect(await evaluateBudgetAlerts(userId, db, NOW)).toBe(1);
    expect(emailsForUser()).toHaveLength(1);
    expect(emailsForUser()[0].text).toContain("Fuel");
    expect(emailsForUser()[0].text).toContain("/budgets");

    // Falls back under, raises the limit, goes over again — still one email.
    await updateBudgetLimit(userId, { id, limitMinor: 10_000 }, db, NOW);
    await addTxn(-5_000, FUEL);
    expect(await evaluateBudgetAlerts(userId, db, NOW)).toBe(0);
    expect(emailsForUser()).toHaveLength(1);

    // Next month the budget can alert again.
    await addTxn(-20_000, FUEL, "2026-11-02");
    expect(await evaluateBudgetAlerts(userId, db, NEXT_MONTH)).toBe(1);
    expect(emailsForUser()).toHaveLength(2);
  });

  it("creating a budget below current spending counts as going over", async () => {
    await addTxn(-6_000, FUEL);
    await create(FUEL, 5_000);
    expect(emailsForUser()).toHaveLength(1);
  });

  it("skips the email without a verified address but records the alert", async () => {
    await db
      .update(schema.users)
      .set({ email_verified_at: null })
      .where(eq(schema.users.id, userId));
    await create(FUEL, 1_000);
    await addTxn(-2_000, FUEL);
    expect(await evaluateBudgetAlerts(userId, db, NOW)).toBe(1);
    expect(emailsForUser()).toHaveLength(0);
    // Ledger written, so the skip is not repeated.
    expect(await evaluateBudgetAlerts(userId, db, NOW)).toBe(0);
  });

  it("removes budgets with their categories, exports and hard-deletes them", async () => {
    await create(VEGETABLES, 1_000);
    await create(FUEL, 1_000);
    await addTxn(-2_000, FUEL);
    await evaluateBudgetAlerts(userId, db, NOW);

    const exported = await collectUserExport(userId);
    expect(exported.budgets).toHaveLength(2);
    expect(exported.budgetAlerts).toHaveLength(1);

    await deleteBudgetsForCategories(userId, [VEGETABLES, ORGANIC]);
    expect((await getBudgetsOverview(userId, db, NOW)).budgets.map((b) => b.categoryId)).toEqual([
      FUEL,
    ]);

    await hardDeleteUser(userId);
    expect(await db.select().from(schema.budgets).where(eq(schema.budgets.user_id, userId))).toHaveLength(0);
    expect(
      await db.select().from(schema.budget_alerts).where(eq(schema.budget_alerts.user_id, userId)),
    ).toHaveLength(0);
  });
});
