# Monthly category budgets — tasks

Implements [spec.md](spec.md). Ordered; each server task lands with its unit test.

1. **Schema + migration** — `budgets` (id, user_id, category_id, limit_minor, created_at, updated_at; unique user+category) and `budget_alerts` ledger (id, user_id, budget_id, month `YYYY-MM`, created_at; unique budget+month). `pnpm run db:generate`.
2. **Entitlements** — `maxBudgets` in `Entitlements`, env `BILLING_FREE_MAX_BUDGETS` (default 3). Update billing unit test.
3. **`budgets.server.ts`** — category subtree resolution, `getBudgetsOverview(userId, now)` (limit/spent/left/over + per-child breakdown), create/update/delete with ownership + plan gate (advisory lock per user), `evaluateBudgetAlerts(userId, now)` with ledger + email/log. Unit tests: AC-6..12, 14, 15, 19.
4. **`budgets.functions.ts`** — `getBudgets`, `createBudget`, `updateBudget`, `deleteBudget`.
5. **Hook evaluation** into every spending write path (transactions create/update, import confirm, receipt save, rule apply / re-categorize, category reassign) + maintenance loop (AC-20).
6. **Compliance** — export JSON + `budgets.csv`, `hardDeleteUser`, `deleteCategory` cleanup + cross-tenant fix (§8), privacy/account-deleted copy (AC-17..19).
7. **UI** — `/budgets` page (cards, dialogs, upgrade dialog, details modal with Recharts pie), sidebar item + counter, top alert bar in the authed layout, billing usage line. All copy in `messages/en.json`.
8. **E2E** — `tests/e2e/budgets.spec.ts`: CRUD, parent sum in modal, over state + alert bar + single email, free limit upsell, pro unlimited, billing usage (AC-1..5, 9, 10, 11, 13..16, 18).
9. **`pnpm run check`**, fix, commit, PR into the fork.
