# Monthly category budgets — spec

**Source:** [TASK.md](../../TASK.md) · **Branch:** `feat/monthly-budgets` · **Status:** draft for approval

## 1. Intent

Users can see what they spent but cannot plan against it. Budgets let a user set a monthly spending limit per category, see at a glance how much is left, and get told when they go over. Budgets are also a Pro upsell: the free plan is capped at 3.

**Demo priorities** (what the interviewers must see working):

1. The new **Budgets** page.
2. A budget on a **parent category summing its subcategories**, made visible through the details modal's pie chart.
3. A free user **hitting the 3-budget limit and being invited to upgrade to Pro**.

## 2. Goals

- New "Budgets" page in the main navigation.
- Create, edit (limit), and delete a budget for a category.
- Each budget shows its limit, the amount spent this month, the amount left, and a clear over-budget state.
- A parent-category budget includes spending in all of its descendants.
- Only spending counts: income and refunds never reduce the spent amount.
- Budgets reset every calendar month.
- Email when a budget goes over its limit: at most one email per budget per month.
- In-app red alert bar when any budget is over.
- Free plan: up to 3 budgets. Pro: unlimited.
- Same compliance guarantees as the rest of the user data (export, deletion, privacy notice).

## 3. Non-goals

- **History of previous months.** The transaction data exists, but a budget stores only its current limit, so past months would be judged against today's limit and could show "within budget" for a month that was actually over. Doing this correctly requires a per-month limit snapshot. Deferred (see §12).
- Warning thresholds before the limit (80% / 90%). These were considered and dropped because TASK.md specifies one email, sent on going over.
- Rolling unused budget into the next month.
- Currency conversion (see §11).
- Budgets for "uncategorized" spending, or per account.
- A "View transactions" link from the details modal.

## 4. Anti-goals (failure even if it "works")

- Any existing feature regresses (`pnpm run check` must stay green).
- The budget and the dashboard disagree on the same numbers: for a category without subcategories in a given month, "spent" must equal that category's expense total on the dashboard for the same month.
- A user can read or modify another user's budget, or another user's category through any path this feature touches.
- A user receives more than one over-budget email for the same budget in the same month.

## 5. Domain rules

### 5.1 Budget

- A budget belongs to one user and one category. **One budget per category per user.**
- A parent and its child can each have their own budget. A transaction in the child counts toward both.
- Any of the user's categories can be budgeted. Income categories are allowed; their "spent" will simply be 0.
- **Limit**: integer minor units, strictly greater than 0. Entered as a decimal string in the UI and parsed with `parseAmountToMinor`. Never stored as a float.
- On edit, only the limit can change. To budget a different category, the user deletes the budget and creates a new one. *(builder's call, see §13)*
- The budget is **not** tied to a month: it applies to every month until deleted.

### 5.2 Spent this month

`spent(budget, month)` = sum of `|amount_minor|` over the user's transactions where:

- `amount_minor < 0`: expenses only. Positive amounts (income, refunds) are ignored entirely; they never offset spending.
- `date` is within the calendar month in **UTC**, matching `monthStart` in `ai-usage.server.ts`. "This month" is derived from the server clock at request time.
- `category_id` is the budget's category **or any descendant at any depth**.
- Attribution uses the transaction's `category_id` only. Receipt-item categories are ignored, consistent with the dashboard's "top categories".
- Amounts from accounts in different currencies are summed as-is (see §11).

Derived values:

- `left = limit − spent`. It can be negative.
- **Over budget** ⇔ `spent > limit`. Exactly at the limit means "0 left", which is not over.
- "Reset every month" is achieved by always computing for the current month. No reset job exists or is needed.

### 5.3 Plan limit

- New entitlement `maxBudgets`: free = 3, configurable via env `BILLING_FREE_MAX_BUDGETS` (positive integer, default 3); pro = unlimited (`null`). It lives in `Entitlements` / `entitlementsForPlan` in `billing.server.ts`, the single source of truth.
- Enforced **on the server** at creation. The rejection carries `{ error, code: "budget_limit_reached", limit }` so the UI can localize it, following `checkAccountLimit`.
- Two concurrent create requests must not let a free user end up above the limit.
- **Downgrade** (pro → free): existing budgets are kept, even above 3. They stay visible, editable, and deletable. Only creating new budgets is blocked until the count is below the limit. This mirrors the existing account-limit behavior.

### 5.4 Over-budget email

- Sent when a budget **goes over** its limit in the current month, i.e. the first time in that month that `spent > limit` is observed for it.
- **At most one per budget per calendar month, on every plan.** This holds even if the user later deletes transactions, falls back under, raises the limit, and goes over again.
- Guaranteed through an idempotency ledger: a row per (budget, month) with a unique key, inserted with `ON CONFLICT DO NOTHING`, following the `stripe_events` pattern. Only the request that inserts the row sends the email.
- If the email send fails after the row is inserted, the failure is logged and not retried. Dedupe wins over delivery. *(builder's call)*
- **Content** (English, via Paraglide `m.*`): the category name, the limit, the amount spent this month, the amount over, and a link to `{APP_BASE_URL}/budgets`.
- **Recipient**: `users.email` if present **and verified**. If the user has no email (legacy accounts) or it is unverified, no email is sent. A `warn` log line records the skip with the user id and budget id only, never amounts or category names, per the logging rule in `compliance.server.ts`. The ledger row is still written, so the skip is not re-logged on every request. *(unverified → skip is the builder's call)*
- Sending is fire-and-forget (`void sendEmail(...).catch(log)`), like the existing account emails. A user-facing request never fails because of email.

**When it is evaluated.** After every server-side write that can increase a budget's spent amount:

- create and update of a transaction (`transactions.functions.ts`);
- confirming an import (`imports.functions.ts`);
- saving a scanned receipt that creates or updates a transaction (`receipts.functions.ts`);
- applying a rule to existing transactions, and AI or rule re-categorization (`categorization.functions.ts`);
- deleting a category with transaction reassignment (`categories.functions.ts`);
- creating a budget, or editing its limit, when spending is already above the new limit. This keeps the email consistent with the red alert bar; otherwise lowering a limit below current spending would never notify. *(builder's call)*

Evaluation runs for the affected user and checks all of that user's budgets. As a safety net, the hourly maintenance loop also evaluates all users that have budgets. *(builder's call)*

### 5.5 In-app alert

- A **red bar at the top of every signed-in page** whenever at least one budget is over this month.
- One over budget: "⚠ Entertainment is over budget: 620.00 of 500.00 PLN spent this month. View budgets →"
- Several: "⚠ 3 budgets are over this month: Entertainment, Fuel, Dining Out. View budgets →"
- The whole bar links to `/budgets`.
- It is computed live from current spending and is independent of the email ledger. If the user falls back under, the bar disappears.
- It refreshes after any mutation that can change spending (the client invalidates the budgets query) and on navigation. On the 1st of the month it disappears because spending restarts.
- A ✕ dismisses it **until a budget that was not over at dismissal time goes over**. Budgets falling back under do not re-show it. The dismissal is stored per browser (`localStorage`) as the month plus the set of budget ids that were over when dismissed. It is a convenience only, and the page must render correctly without storage.
- The sidebar "Budgets" item shows a red counter with the number of over budgets (hidden when 0).

## 6. UI

All copy in English, via Paraglide (`messages/en.json`). Amounts are formatted with `formatMinor` and the existing `m.analytics_currency()` label, as on the dashboard.

### 6.1 Budgets page (`/budgets`), layout A: cards

- Header: title "Budgets", current month (e.g. "October 2026"), "Resets every month", and a **"New budget"** button.
- Plan usage line: "2 of 3 budgets (Free plan)", or "5 budgets (Pro, unlimited)".
- One **card per budget**, containing:
  - the category color dot and name;
  - "Includes subcategories" when the category has children;
  - a progress bar, visually capped at 100% and in the category color, or red when over;
  - "1240.50 of 1500.00 PLN";
  - "259.50 left", or, when over, an "Over budget" badge and "120.00 over" in red with a red card border;
  - edit and delete actions.
- **Empty state**: a short explanation of budgets and a "Create your first budget" button.
- **Create dialog**: a category select listing only categories without a budget (subcategories indented under parents, as on the Categories page) and a monthly limit input. Validation errors are shown inline.
- **Edit dialog**: the limit only.
- **Delete**: a confirmation dialog (existing `alert-dialog`).
- **Free limit reached**: clicking "New budget" when usage is at the limit opens an **upgrade dialog** instead of the create dialog: "You've reached the Free plan limit. The Free plan includes up to 3 budgets. Upgrade to Pro for unlimited budgets." The buttons are "Not now" and "See Pro plan →" (navigates to `/billing`). The same dialog opens if the server rejects a create with `budget_limit_reached`, which covers a stale client.

### 6.2 Budget details modal

- Opens by clicking a budget card. The edit and delete actions do not open it.
- Header: category name and month, plus "X of Y PLN spent · Z left" or the over state.
- A **pie chart** (Recharts, already a dependency) of this month's spending split by:
  - one slice per **direct child** category, each including its own descendants;
  - one slice "\<Category\> (no subcategory)" for spending booked directly on the budget's category.
- Zero-amount slices are omitted. The slices sum exactly to the card's "spent".
- A **legend list** with the name, amount, and percentage of each slice. It is accessible and is what E2E tests assert on.
- A budget on a category **without children**: no pie. Show the total and the note "This category has no subcategories."
- **No spending yet** this month: show "No spending this month yet."

### 6.3 Elsewhere

- Sidebar: a "Budgets" item placed after "Categories", with the over-budget counter.
- Billing page: a new usage line, "2 of 3 budgets" on Free or "5 budgets (unlimited)" on Pro.
- Billing blurbs: mention budgets among the Pro benefits.

## 7. Compliance

- **Export**: `collectUserExport` and `buildExportZip` include budgets and the alert ledger in `export.json`, plus a `budgets.csv` (category, limit, created_at).
- **Account deletion**: `hardDeleteUser` deletes the alert ledger rows, then the budgets, **before** categories. There is no FK cascade.
- **Category deletion**: deleting a category (and its descendants) deletes their budgets and ledger rows.
- **Privacy notice**: `privacy_what_body` mentions budgets and budget-alert history. The account-deleted email body lists budgets among the deleted data.
- **Ownership**: the budgets table is registered in `OWNED_TABLES`. Every budget id received from the client is checked with `WHERE id = ? AND user_id = ?`, and a category id must belong to the user.

## 8. Security fix in scope: `deleteCategory`

`src/server/categories.functions.ts` `deleteCategory` does not verify that `data.id` belongs to the caller, and its final deletes (`categories`, `categorization_rules`, `receipt_items`) are not scoped by `user_id`. Fix:

- Return "Category not found" unless the category is owned by the caller. A foreign category must behave exactly like a missing one.
- Scope every write in the function by `user_id`.
- Cover it with a unit test (a cross-tenant delete is rejected and leaves the other user's data intact).

## 9. Acceptance criteria

Each item maps to at least one automated test: unit (U), E2E (E), or both.

| # | Criterion | Test |
|---|-----------|------|
| AC-1 | "Budgets" appears in the sidebar and opens `/budgets`. | E |
| AC-2 | The empty state shows when the user has no budgets. | E |
| AC-3 | The user creates a budget for a category with a limit; the card shows the limit, spent, and left. | E |
| AC-4 | The user edits the limit; the card updates. | E |
| AC-5 | The user deletes a budget after confirming; the card disappears. | E |
| AC-6 | Invalid limits (empty, 0, negative, non-numeric) are rejected with a visible error; nothing is saved. | E + U |
| AC-7 | A category that already has a budget is not offered and is rejected by the server. | E + U |
| AC-8 | Spent counts only negative amounts in the current UTC month; income, refunds, and other months are excluded. | U |
| AC-9 | A parent budget includes spending in children and grandchildren; the details pie slices sum to the card total. | U + E |
| AC-10 | When spent > limit, the card shows the over state (badge, red, "X over"); spent == limit is not over. | U + E |
| AC-11 | Going over sends exactly one email per budget per month, even after falling under and going over again or raising the limit; the next month can send again. | U + E |
| AC-12 | No email for users without a verified email; a warn log is written instead. | U |
| AC-13 | The red alert bar appears on signed-in pages when a budget is over, names it, and links to `/budgets`; ✕ hides it until another budget goes over. | E |
| AC-14 | A free user with 3 budgets clicking "New budget" sees the upgrade dialog; "See Pro plan" leads to `/billing`; the server rejects a 4th budget with `budget_limit_reached`. | E + U |
| AC-15 | A Pro user can create more than 3 budgets; after a downgrade, existing budgets remain editable and deletable, and creation is blocked. | E + U |
| AC-16 | The billing page shows budget usage for Free and Pro. | E |
| AC-17 | The data export contains the budgets; account hard-delete removes budgets and alert rows. | U |
| AC-18 | Deleting a category removes its budgets (and those of its descendants). | U + E |
| AC-19 | Cross-tenant: another user's budget id cannot be read, edited, or deleted; another user's category cannot be budgeted or deleted. | U |
| AC-20 | Spending changed through import, receipt save, or re-categorization triggers the over-budget evaluation. | U |
| AC-21 | `pnpm run check` passes (typecheck, lint, unit, E2E). | CI |

## 10. Constraints

- Follow CLAUDE.md:
  - routes import only `*.functions.ts`, and server logic lives in `*.server.ts`;
  - TanStack Query with module-level query keys;
  - Paraglide for every string;
  - money only through `money.ts`;
  - a Drizzle migration generated with `pnpm run db:generate`.
- Tests are written before or alongside the code. E2E uses the `signedInUser` fixture, `/test-set-plan`, and `/test-emails?to=`.
- No new runtime dependencies. Recharts, Radix, and date-fns are already present.

## 11. Known limitations

- **Mixed currencies**: amounts are summed across accounts without conversion and labeled with the app-wide currency label, the same as the dashboard.
- **UTC month**: a transaction dated on the last or first day of a month is attributed by its calendar date. "Now" uses the server's UTC clock, so near midnight a user in another timezone may briefly see the neighboring month.
- **Email delivery** is best-effort after the ledger insert: a provider failure loses that month's email for that budget. This is logged.

## 12. Future work

- **Budget history**: past months with the limit that applied at the time, which requires per-month limit snapshots.
- Warning thresholds (80% / 90%) as an opt-in.
- In-app notification center and history.
- Currency-aware budgets.

## 13. Decisions log

| Decision | By |
|----------|----|
| Cards layout (A) for the Budgets page | User |
| Details as a modal with a pie chart of the subcategory split | User |
| One email per budget per month on every plan, sent on going over, exactly as TASK.md states (80/90% thresholds and a 6/month cap were considered and dropped) | User |
| No email → no send + warn log; English content with a link to /budgets | User |
| Red top alert bar linking to /budgets, ✕ to dismiss, sidebar counter | User |
| History out of scope, recorded as future work | User |
| Fix the `deleteCategory` cross-tenant issue in this branch | User |
| Spending rules (§5.2), one budget per category, parent and child both allowed, downgrade keeps budgets, category delete removes budgets, Billing page usage, empty state | Proposed by Claude, confirmed by the user |
| Edit changes the limit only; the category is fixed | Claude (builder's call) |
| Unverified email is treated like no email | Claude (builder's call) |
| Ledger row written before sending; send failure is logged, not retried | Claude (builder's call) |
| Hourly maintenance loop also evaluates budgets as a safety net | Claude (builder's call) |
| Over budget means spent > limit, strictly | Claude (builder's call) |
| "Budgets" sidebar item placed after "Categories" | Claude (builder's call) |
| Creating a budget, or lowering its limit, below current spending counts as going over (email + bar) | Claude (builder's call) |
| ✕ re-shows the bar only when a budget not previously dismissed goes over | Claude (builder's call) |
