import { useEffect, useState } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { m } from "#/paraglide/messages";
import { formatMinor } from "#/lib/money";
import { BUDGETS_QUERY_KEY } from "#/lib/budgets";
import { getBudgets } from "#/server/budgets.functions";

//
// Red over-budget bar shown on every signed-in page. Computed live from the
// budgets overview (independent of the email ledger). Any successful
// mutation anywhere in the app can change spending, so the bar refetches
// after every mutation and on navigation.

const DISMISS_KEY = "budget-alert-dismissed";

type Dismissed = { month: string; ids: string[] };

function readDismissed(): Dismissed | null {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    return raw ? (JSON.parse(raw) as Dismissed) : null;
  } catch {
    return null;
  }
}

function writeDismissed(value: Dismissed) {
  try {
    localStorage.setItem(DISMISS_KEY, JSON.stringify(value));
  } catch {
    // Storage unavailable — dismissal just won't persist.
  }
}

export function useBudgetsOverview() {
  const getBudgetsFn = useServerFn(getBudgets);
  return useQuery({
    queryKey: BUDGETS_QUERY_KEY,
    queryFn: () => getBudgetsFn(),
    staleTime: 0,
  });
}

export function BudgetAlertBar() {
  const queryClient = useQueryClient();
  const pathname = useLocation().pathname;
  const { data } = useBudgetsOverview();
  const [dismissed, setDismissed] = useState<Dismissed | null>(null);

  useEffect(() => setDismissed(readDismissed()), []);

  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: BUDGETS_QUERY_KEY });
  }, [pathname, queryClient]);

  useEffect(
    () =>
      queryClient.getMutationCache().subscribe((event) => {
        if (event.type === "updated" && event.action.type === "success") {
          void queryClient.invalidateQueries({ queryKey: BUDGETS_QUERY_KEY });
        }
      }),
    [queryClient],
  );

  const over = data?.budgets.filter((b) => b.isOver) ?? [];
  if (!data || over.length === 0) return null;

  // Hidden only while every over budget was already over when dismissed.
  const isDismissed =
    dismissed?.month === data.month &&
    over.every((b) => dismissed.ids.includes(b.id));
  if (isDismissed) return null;

  const text =
    over.length === 1
      ? m.budget_alert_single({
          category: over[0].categoryName,
          spent: formatMinor(over[0].spentMinor),
          limit: formatMinor(over[0].limitMinor),
          currency: m.analytics_currency(),
        })
      : m.budget_alert_multiple({
          count: over.length,
          names: over.map((b) => b.categoryName).join(", "),
        });

  return (
    <div
      role="alert"
      data-testid="budget-alert-bar"
      className="bg-red-600 text-white border-b border-red-700"
    >
      <div className="page-wrap py-2 flex items-center gap-3 text-sm">
        <Link to="/budgets" className="flex-1 hover:underline">
          ⚠ {text} <span className="font-medium underline">{m.budget_alert_view()} →</span>
        </Link>
        <button
          type="button"
          onClick={() => {
            const value = { month: data.month, ids: over.map((b) => b.id) };
            writeDismissed(value);
            setDismissed(value);
          }}
          aria-label={m.budget_alert_dismiss()}
          className="h-7 w-7 flex items-center justify-center rounded hover:bg-white/20"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
