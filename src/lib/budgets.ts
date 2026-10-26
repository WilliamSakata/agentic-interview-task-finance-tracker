//
// Client-safe budget helpers shared by the Budgets page, the over-budget
// alert bar and the sidebar counter.

/** Shared TanStack Query key for the budgets overview. */
export const BUDGETS_QUERY_KEY = ["budgets"] as const;

/** "2026-10" → "October 2026" (the month is a UTC calendar month). */
export function formatBudgetMonth(month: string): string {
  const [year, mon] = month.split("-").map(Number);
  if (!year || !mon) return month;
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, mon - 1, 1)));
}
