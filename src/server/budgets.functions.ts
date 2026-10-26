import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireUserId } from "#/server/session";
import {
  createBudget as createBudgetInternal,
  deleteBudget as deleteBudgetInternal,
  getBudgetsOverview,
  updateBudgetLimit,
} from "#/server/budgets.server";

//
// Client-callable budgets surface. Logic (aggregation, plan gate, alerts)
// lives in budgets.server.ts; these wrappers only validate and resolve the
// session user.

// Integer minor units (grosze/cents); capped to the Postgres integer range.
const limitMinorSchema = z.number().int().positive().max(2_147_483_647);

export const getBudgets = createServerFn({ method: "GET" }).handler(
  async () => {
    const userId = await requireUserId();
    return getBudgetsOverview(userId);
  },
);

export const createBudget = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({ categoryId: z.string().min(1), limitMinor: limitMinorSchema }),
  )
  .handler(async ({ data }) => {
    const userId = await requireUserId();
    return createBudgetInternal(userId, data);
  });

export const updateBudget = createServerFn({ method: "POST" })
  .inputValidator(z.object({ id: z.string().min(1), limitMinor: limitMinorSchema }))
  .handler(async ({ data }) => {
    const userId = await requireUserId();
    return updateBudgetLimit(userId, data);
  });

export const deleteBudget = createServerFn({ method: "POST" })
  .inputValidator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data }) => {
    const userId = await requireUserId();
    return deleteBudgetInternal(userId, data.id);
  });
