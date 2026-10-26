import { and, count, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db as defaultDb, schema } from "#/db";
import { formatMinor } from "#/lib/money";
import { m } from "#/paraglide/messages";
import { monthStart } from "#/server/ai-usage.server";
import { getEntitlements, type Plan } from "#/server/billing.server";
import { sendEmail } from "#/server/email";
import { env } from "#/server/env";
import { getLogger } from "#/server/logger";

//
// Monthly category budgets: spending aggregation, CRUD with the plan gate,
// and the over-budget email. "Spent" is computed live for the current
// calendar month (UTC), so budgets reset every month without a job. Log
// lines carry ids only, never amounts or category names.

type Db = typeof defaultDb;
// Drizzle transaction handle — same query API as Db for our purposes.
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface BudgetSlice {
  /** null = spending booked directly on the budget's own category. */
  categoryId: string | null;
  name: string;
  color: string;
  /** Integer minor units. */
  amountMinor: number;
}

export interface BudgetView {
  id: string;
  categoryId: string;
  categoryName: string;
  categoryColor: string;
  hasSubcategories: boolean;
  /** All amounts are integer minor units. */
  limitMinor: number;
  spentMinor: number;
  leftMinor: number;
  isOver: boolean;
  /** Split by direct child (each including its descendants) + the category
   * itself. Zero slices are omitted; slices sum to spentMinor. */
  breakdown: BudgetSlice[];
}

export interface BudgetsOverview {
  /** "YYYY-MM" (UTC). */
  month: string;
  budgets: BudgetView[];
  usage: { count: number; limit: number | null; plan: Plan };
}

export type BudgetErrorCode =
  | "category_not_found"
  | "budget_exists"
  | "budget_not_found"
  | "budget_limit_reached";

export type BudgetMutationResult =
  | { success: true; id: string }
  | { error: string; code: BudgetErrorCode; limit?: number };

const DEFAULT_COLOR = "#6b7280";

/** Calendar month key ("YYYY-MM") of `now` in UTC. */
export function monthKey(now: Date): string {
  return monthStart(now).toISOString().slice(0, 7);
}

/** [first day, first day of next month) of `now`'s UTC month, as dates. */
function monthBounds(now: Date): { from: string; to: string } {
  const start = monthStart(now);
  const next = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1),
  );
  return {
    from: start.toISOString().slice(0, 10),
    to: next.toISOString().slice(0, 10),
  };
}

type CategoryRow = {
  id: string;
  name: string;
  color: string | null;
  parent_id: string | null;
};

function childrenMap(categories: CategoryRow[]): Map<string, CategoryRow[]> {
  const map = new Map<string, CategoryRow[]>();
  for (const c of categories) {
    if (!c.parent_id) continue;
    const list = map.get(c.parent_id) ?? [];
    list.push(c);
    map.set(c.parent_id, list);
  }
  return map;
}

/** The category and every descendant at any depth (cycle-safe). */
export function subtreeIds(
  rootId: string,
  children: Map<string, CategoryRow[]>,
): Set<string> {
  const ids = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (ids.has(id)) continue;
    ids.add(id);
    for (const child of children.get(id) ?? []) stack.push(child.id);
  }
  return ids;
}

/**
 * Every budget of the user with this month's spending. Spending = absolute
 * value of negative transactions (income/refunds never offset it) dated in
 * the UTC month, attributed by transaction category to the budget's category
 * and all of its descendants.
 */
export async function getBudgetsOverview(
  userId: string,
  db: Db = defaultDb,
  now: Date = new Date(),
): Promise<BudgetsOverview> {
  const { from, to } = monthBounds(now);

  const [categories, budgetRows, spendRows, entitlements] = await Promise.all([
    db
      .select({
        id: schema.categories.id,
        name: schema.categories.name,
        color: schema.categories.color,
        parent_id: schema.categories.parent_id,
      })
      .from(schema.categories)
      .where(eq(schema.categories.user_id, userId)),
    db
      .select()
      .from(schema.budgets)
      .where(eq(schema.budgets.user_id, userId))
      .orderBy(schema.budgets.created_at, schema.budgets.id),
    db
      .select({
        categoryId: schema.transactions.category_id,
        // SUM over integers is bigint in Postgres — map back to number.
        spent: sql<number>`COALESCE(SUM(-${schema.transactions.amount_minor}), 0)`.mapWith(Number),
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.user_id, userId),
          gte(schema.transactions.date, from),
          lt(schema.transactions.date, to),
          lt(schema.transactions.amount_minor, 0),
          isNotNull(schema.transactions.category_id),
        ),
      )
      .groupBy(schema.transactions.category_id),
    getEntitlements(userId, db),
  ]);

  const byId = new Map(categories.map((c) => [c.id, c]));
  const children = childrenMap(categories);
  const spentByCategory = new Map<string, number>();
  for (const row of spendRows) {
    if (row.categoryId) spentByCategory.set(row.categoryId, row.spent);
  }
  const sumOf = (ids: Set<string>) => {
    let total = 0;
    for (const id of ids) total += spentByCategory.get(id) ?? 0;
    return total;
  };

  const budgets: BudgetView[] = [];
  for (const b of budgetRows) {
    const category = byId.get(b.category_id);
    if (!category) continue;
    const directChildren = children.get(category.id) ?? [];
    const breakdown: BudgetSlice[] = [];
    const direct = spentByCategory.get(category.id) ?? 0;
    if (direct > 0) {
      breakdown.push({
        categoryId: null,
        name: category.name,
        color: category.color ?? DEFAULT_COLOR,
        amountMinor: direct,
      });
    }
    for (const child of directChildren) {
      const amount = sumOf(subtreeIds(child.id, children));
      if (amount > 0) {
        breakdown.push({
          categoryId: child.id,
          name: child.name,
          color: child.color ?? DEFAULT_COLOR,
          amountMinor: amount,
        });
      }
    }
    breakdown.sort((a, b) => b.amountMinor - a.amountMinor);
    const spentMinor = sumOf(subtreeIds(category.id, children));
    budgets.push({
      id: b.id,
      categoryId: category.id,
      categoryName: category.name,
      categoryColor: category.color ?? DEFAULT_COLOR,
      hasSubcategories: directChildren.length > 0,
      limitMinor: b.limit_minor,
      spentMinor,
      leftMinor: b.limit_minor - spentMinor,
      isOver: spentMinor > b.limit_minor,
      breakdown,
    });
  }

  return {
    month: monthKey(now),
    budgets,
    usage: {
      count: budgetRows.length,
      limit: entitlements.maxBudgets,
      plan: entitlements.plan,
    },
  };
}

/**
 * Create a budget. Ownership of the category, uniqueness per category, and
 * the plan limit are checked inside one transaction holding a per-user
 * advisory lock, so concurrent creates cannot exceed the free limit.
 */
export async function createBudget(
  userId: string,
  input: { categoryId: string; limitMinor: number },
  db: Db = defaultDb,
  now: Date = new Date(),
): Promise<BudgetMutationResult> {
  const result = await db.transaction(
    async (tx): Promise<BudgetMutationResult> => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`budgets:${userId}`}))`,
      );

      const category = await tx
        .select({ id: schema.categories.id })
        .from(schema.categories)
        .where(
          and(
            eq(schema.categories.id, input.categoryId),
            eq(schema.categories.user_id, userId),
          ),
        )
        .limit(1);
      if (category.length === 0) {
        return { error: "Category does not exist", code: "category_not_found" };
      }

      const existing = await tx
        .select({ id: schema.budgets.id })
        .from(schema.budgets)
        .where(
          and(
            eq(schema.budgets.user_id, userId),
            eq(schema.budgets.category_id, input.categoryId),
          ),
        )
        .limit(1);
      if (existing.length > 0) {
        return {
          error: "This category already has a budget",
          code: "budget_exists",
        };
      }

      const entitlements = await getEntitlements(userId, tx as unknown as Db);
      if (entitlements.maxBudgets !== null) {
        const rows = await tx
          .select({ count: count() })
          .from(schema.budgets)
          .where(eq(schema.budgets.user_id, userId));
        if ((rows[0]?.count ?? 0) >= entitlements.maxBudgets) {
          return {
            error: `Free plan is limited to ${entitlements.maxBudgets} budgets. Upgrade to Pro for unlimited budgets.`,
            code: "budget_limit_reached",
            limit: entitlements.maxBudgets,
          };
        }
      }

      const id = crypto.randomUUID();
      await tx.insert(schema.budgets).values({
        id,
        user_id: userId,
        category_id: input.categoryId,
        limit_minor: input.limitMinor,
      });
      return { success: true, id };
    },
  );

  if ("success" in result) await evaluateBudgetAlerts(userId, db, now);
  return result;
}

/** Change a budget's monthly limit (the category is fixed). */
export async function updateBudgetLimit(
  userId: string,
  input: { id: string; limitMinor: number },
  db: Db = defaultDb,
  now: Date = new Date(),
): Promise<BudgetMutationResult> {
  const updated = await db
    .update(schema.budgets)
    .set({ limit_minor: input.limitMinor, updated_at: new Date() })
    .where(
      and(eq(schema.budgets.id, input.id), eq(schema.budgets.user_id, userId)),
    )
    .returning({ id: schema.budgets.id });
  if (updated.length === 0) {
    return { error: "Budget not found", code: "budget_not_found" };
  }
  await evaluateBudgetAlerts(userId, db, now);
  return { success: true, id: input.id };
}

export async function deleteBudget(
  userId: string,
  id: string,
  db: Db = defaultDb,
): Promise<BudgetMutationResult> {
  return db.transaction(async (tx): Promise<BudgetMutationResult> => {
    await tx
      .delete(schema.budget_alerts)
      .where(
        and(
          eq(schema.budget_alerts.budget_id, id),
          eq(schema.budget_alerts.user_id, userId),
        ),
      );
    const deleted = await tx
      .delete(schema.budgets)
      .where(and(eq(schema.budgets.id, id), eq(schema.budgets.user_id, userId)))
      .returning({ id: schema.budgets.id });
    if (deleted.length === 0) {
      return { error: "Budget not found", code: "budget_not_found" };
    }
    return { success: true, id };
  });
}

/** Remove the budgets (and their alert ledger rows) of the given categories.
 * Called when categories are deleted — there is no FK cascade. */
export async function deleteBudgetsForCategories(
  userId: string,
  categoryIds: string[],
  db: Db | Tx = defaultDb,
): Promise<void> {
  if (categoryIds.length === 0) return;
  const budgetIds = db
    .select({ id: schema.budgets.id })
    .from(schema.budgets)
    .where(
      and(
        eq(schema.budgets.user_id, userId),
        inArray(schema.budgets.category_id, categoryIds),
      ),
    );
  await db
    .delete(schema.budget_alerts)
    .where(inArray(schema.budget_alerts.budget_id, budgetIds));
  await db
    .delete(schema.budgets)
    .where(
      and(
        eq(schema.budgets.user_id, userId),
        inArray(schema.budgets.category_id, categoryIds),
      ),
    );
}

/**
 * Send the over-budget email for every budget of the user that is over this
 * month and has not been alerted this month yet. The ledger row is inserted
 * first (ON CONFLICT DO NOTHING), so at most one email per budget per month
 * is ever sent, whatever the plan. Returns the number of budgets newly
 * alerted. Never throws on email failure — callers are user-facing writes.
 */
export async function evaluateBudgetAlerts(
  userId: string,
  db: Db = defaultDb,
  now: Date = new Date(),
): Promise<number> {
  const log = getLogger();
  try {
    const overview = await getBudgetsOverview(userId, db, now);
    const over = overview.budgets.filter((b) => b.isOver);
    if (over.length === 0) return 0;

    const [user] = await db
      .select({
        email: schema.users.email,
        email_verified_at: schema.users.email_verified_at,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    let alerted = 0;
    for (const budget of over) {
      const inserted = await db
        .insert(schema.budget_alerts)
        .values({
          id: crypto.randomUUID(),
          user_id: userId,
          budget_id: budget.id,
          month: overview.month,
        })
        .onConflictDoNothing()
        .returning({ id: schema.budget_alerts.id });
      if (inserted.length === 0) continue;
      alerted++;

      if (!user?.email || !user.email_verified_at) {
        log.warn(
          { userId, budgetId: budget.id },
          "over-budget email skipped: no verified email address",
        );
        continue;
      }
      void sendEmail({
        to: user.email,
        subject: m.email_budget_over_subject({ category: budget.categoryName }),
        text: m.email_budget_over_body({
          category: budget.categoryName,
          limit: formatMinor(budget.limitMinor),
          spent: formatMinor(budget.spentMinor),
          over: formatMinor(-budget.leftMinor),
          currency: m.analytics_currency(),
          link: `${env.email.baseUrl}/budgets`,
        }),
      }).catch((error) =>
        log.error(
          { err: error, userId, budgetId: budget.id },
          "failed to send over-budget email",
        ),
      );
    }
    return alerted;
  } catch (error) {
    log.error({ err: error, userId }, "budget alert evaluation failed");
    return 0;
  }
}

/** Safety net for the maintenance loop: evaluate every user with budgets. */
export async function evaluateAllBudgetAlerts(
  now: Date = new Date(),
  db: Db = defaultDb,
): Promise<number> {
  const users = await db
    .selectDistinct({ userId: schema.budgets.user_id })
    .from(schema.budgets);
  let alerted = 0;
  for (const { userId } of users) {
    alerted += await evaluateBudgetAlerts(userId, db, now);
  }
  return alerted;
}
