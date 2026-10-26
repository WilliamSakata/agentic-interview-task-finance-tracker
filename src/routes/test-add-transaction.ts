import { createFileRoute } from "@tanstack/react-router";
import { and, eq } from "drizzle-orm";
import { db, schema } from "#/db";
import { evaluateBudgetAlerts } from "#/server/budgets.server";
import { useAppSession } from "#/server/session";

// Test-only endpoint: inserts a transaction for the current session user on
// their first account and runs the over-budget evaluation, exactly like the
// createTransaction server function does. Lets the budgets E2E spec set up
// spending without driving the transactions form.
//
// Body: { amountMinor, categoryName?, date? (YYYY-MM-DD, default today UTC) }
//
// Only enabled when TEST_MODE=1 (same runtime flag as /test-create-user).
export const Route = createFileRoute("/test-add-transaction")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (process.env.TEST_MODE !== "1") {
          return new Response("Not available", { status: 404 });
        }

        const session = await useAppSession();
        const userId = session.data.userId;
        if (!userId) {
          return new Response("Not signed in", { status: 401 });
        }

        const body = (await request.json()) as {
          amountMinor?: number;
          categoryName?: string;
          date?: string;
        };
        if (!Number.isInteger(body.amountMinor)) {
          return new Response("Missing amountMinor", { status: 400 });
        }

        const [account] = await db
          .select({ id: schema.accounts.id })
          .from(schema.accounts)
          .where(eq(schema.accounts.user_id, userId))
          .limit(1);
        if (!account) return new Response("No account", { status: 400 });

        let categoryId: string | null = null;
        if (body.categoryName) {
          const [category] = await db
            .select({ id: schema.categories.id })
            .from(schema.categories)
            .where(
              and(
                eq(schema.categories.user_id, userId),
                eq(schema.categories.name, body.categoryName),
              ),
            )
            .limit(1);
          if (!category) {
            return new Response(`Category "${body.categoryName}" not found`, {
              status: 404,
            });
          }
          categoryId = category.id;
        }

        const id = crypto.randomUUID();
        await db.insert(schema.transactions).values({
          id,
          user_id: userId,
          account_id: account.id,
          date: body.date ?? new Date().toISOString().slice(0, 10),
          amount_minor: body.amountMinor!,
          description: "E2E test transaction",
          category_id: categoryId,
        });
        await evaluateBudgetAlerts(userId);

        return Response.json({ id });
      },
    },
  },
});
