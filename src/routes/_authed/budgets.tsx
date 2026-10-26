import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { Cell, Pie, PieChart, Tooltip } from "recharts";
import { m } from "#/paraglide/messages";
import { formatMinor, parseAmountToMinor, minorToInputValue } from "#/lib/money";
import { EditButton, DeleteButton } from "#/components/ui/action-buttons";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Select, SelectItem } from "#/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import { getCategories } from "#/server/categories.functions";
import {
  getBudgets,
  createBudget,
  updateBudget,
  deleteBudget,
} from "#/server/budgets.functions";
import { BUDGETS_QUERY_KEY, formatBudgetMonth } from "#/lib/budgets";

export const Route = createFileRoute("/_authed/budgets")({
  component: BudgetsPage,
});

const CATEGORIES_QUERY_KEY = ["categories"] as const;

type Overview = Awaited<ReturnType<typeof getBudgets>>;
type Budget = Overview["budgets"][number];
type MutationResult =
  | { success: true; id: string }
  | { error: string; code: string; limit?: number };

function errorMessage(result: { code: string; error: string }): string {
  switch (result.code) {
    case "budget_exists":
      return m.budgets_error_exists();
    case "category_not_found":
      return m.budgets_error_category();
    case "budget_not_found":
      return m.budgets_error_not_found();
    default:
      return result.error;
  }
}

// --- Budget card ---

function BudgetCard({
  budget,
  onOpen,
  onEdit,
  onDelete,
}: {
  budget: Budget;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const percent =
    budget.limitMinor > 0
      ? Math.min(100, (budget.spentMinor / budget.limitMinor) * 100)
      : 0;
  const barColor = budget.isOver ? "#e53935" : budget.categoryColor;

  return (
    <li
      data-testid="budget-card"
      className={`rounded-lg border p-4 ${
        budget.isOver
          ? "border-destructive bg-destructive/5"
          : "border-border bg-card"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={onOpen}
          className="text-left flex-1 min-w-0"
          aria-label={m.budgets_open_details_aria({
            category: budget.categoryName,
          })}
        >
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className="size-3 rounded-full shrink-0"
              style={{ backgroundColor: budget.categoryColor }}
            />
            <span className="font-medium">{budget.categoryName}</span>
            {budget.hasSubcategories && (
              <span className="text-xs text-muted-foreground">
                {m.budgets_includes_subcategories()}
              </span>
            )}
            {budget.isOver && (
              <span className="text-xs font-medium rounded px-1.5 py-0.5 bg-destructive text-white">
                {m.budgets_over_badge()}
              </span>
            )}
          </div>
        </button>
        <div className="flex gap-1 shrink-0">
          <EditButton onClick={onEdit} data-testid="budget-edit-btn" />
          <DeleteButton onClick={onDelete} data-testid="budget-delete-btn" />
        </div>
      </div>

      <button
        type="button"
        onClick={onOpen}
        tabIndex={-1}
        className="w-full text-left"
      >
        <div
          className="h-2 rounded-full bg-muted my-3 overflow-hidden"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
        >
          <div
            className="h-2 rounded-full"
            style={{ width: `${percent}%`, backgroundColor: barColor }}
          />
        </div>
        <div className="flex justify-between text-sm">
          <span data-testid="budget-spent">
            {m.budgets_spent_of({
              spent: formatMinor(budget.spentMinor),
              limit: formatMinor(budget.limitMinor),
              currency: m.analytics_currency(),
            })}
          </span>
          {budget.isOver ? (
            <span
              data-testid="budget-left"
              className="text-destructive font-medium"
            >
              {m.budgets_over_by({ amount: formatMinor(-budget.leftMinor) })}
            </span>
          ) : (
            <span data-testid="budget-left">
              {m.budgets_left({ amount: formatMinor(budget.leftMinor) })}
            </span>
          )}
        </div>
      </button>
    </li>
  );
}

// --- Create / edit form ---

function BudgetForm({
  isOpen,
  editing,
  categoryOptions,
  onClose,
  onSubmit,
  error,
  submitting,
}: {
  isOpen: boolean;
  editing: Budget | null;
  categoryOptions: Array<{ id: string; label: string }>;
  onClose: () => void;
  onSubmit: (data: { categoryId: string; limitMinor: number }) => void;
  error: string | null;
  submitting: boolean;
}) {
  const [categoryId, setCategoryId] = useState("");
  const [limit, setLimit] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setCategoryId(editing?.categoryId ?? "");
      setLimit(editing ? String(minorToInputValue(editing.limitMinor)) : "");
      setValidationError(null);
    }
  }, [isOpen, editing]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing && !categoryId) {
      setValidationError(m.budgets_category_required());
      return;
    }
    const limitMinor = parseAmountToMinor(limit);
    if (limitMinor === null || limitMinor <= 0) {
      setValidationError(m.budgets_invalid_limit());
      return;
    }
    setValidationError(null);
    onSubmit({ categoryId, limitMinor });
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editing
              ? m.budgets_form_edit_title({ category: editing.categoryName })
              : m.budgets_form_create_title()}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {!editing && (
            <div>
              <Label htmlFor="budget-category" className="mb-1">
                {m.budgets_category_label()}
              </Label>
              <Select
                id="budget-category"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
              >
                <SelectItem value="">{m.budgets_category_placeholder()}</SelectItem>
                {categoryOptions.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.label}
                  </SelectItem>
                ))}
              </Select>
            </div>
          )}
          <div>
            <Label htmlFor="budget-limit" className="mb-1">
              {m.budgets_limit_label()} ({m.analytics_currency()})
            </Label>
            <Input
              id="budget-limit"
              type="text"
              inputMode="decimal"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder="1500.00"
              autoFocus={Boolean(editing)}
            />
          </div>
          {(validationError || error) && (
            <div className="text-destructive text-sm" role="alert">
              {validationError ?? error}
            </div>
          )}
          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={submitting}
            >
              {m.budgets_cancel()}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? m.budgets_saving() : m.budgets_save()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Upgrade (plan limit) dialog ---

function UpgradeDialog({
  isOpen,
  limit,
  onClose,
}: {
  isOpen: boolean;
  limit: number;
  onClose: () => void;
}) {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{m.budgets_upgrade_title()}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {m.budgets_upgrade_body({ limit })}
        </p>
        <DialogFooter className="pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {m.budgets_upgrade_not_now()}
          </Button>
          <Button asChild>
            <Link to="/billing">{m.budgets_upgrade_see_pro()} →</Link>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- Details modal (pie chart) ---

function BudgetDetails({
  budget,
  month,
  onClose,
}: {
  budget: Budget | null;
  month: string;
  onClose: () => void;
}) {
  const slices =
    budget?.breakdown.map((s) => ({
      ...s,
      label:
        s.categoryId === null && budget.hasSubcategories
          ? m.budgets_details_direct({ category: s.name })
          : s.name,
    })) ?? [];

  return (
    <Dialog open={budget !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {budget && (
          <>
            <DialogHeader>
              <DialogTitle>
                {m.budgets_details_title({
                  category: budget.categoryName,
                  month: formatBudgetMonth(month),
                })}
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              {m.budgets_spent_of({
                spent: formatMinor(budget.spentMinor),
                limit: formatMinor(budget.limitMinor),
                currency: m.analytics_currency(),
              })}{" "}
              ·{" "}
              {budget.isOver ? (
                <span className="text-destructive font-medium">
                  {m.budgets_over_by({ amount: formatMinor(-budget.leftMinor) })}
                </span>
              ) : (
                m.budgets_left({ amount: formatMinor(budget.leftMinor) })
              )}
            </p>

            {budget.spentMinor === 0 ? (
              <p className="text-sm py-4">{m.budgets_no_spending()}</p>
            ) : !budget.hasSubcategories ? (
              <p className="text-sm py-4">{m.budgets_no_subcategories()}</p>
            ) : (
              <div className="flex flex-col sm:flex-row items-center gap-4">
                <PieChart width={200} height={200}>
                  <Pie
                    data={slices}
                    dataKey="amountMinor"
                    nameKey="label"
                    innerRadius={45}
                    outerRadius={90}
                    isAnimationActive={false}
                  >
                    {slices.map((s) => (
                      <Cell key={s.categoryId ?? "direct"} fill={s.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value) =>
                      `${formatMinor(Number(value))} ${m.analytics_currency()}`
                    }
                  />
                </PieChart>
                <div className="flex-1 w-full">
                  <h3 className="text-sm font-medium mb-2">
                    {m.budgets_details_breakdown()}
                  </h3>
                  <ul className="space-y-1 text-sm" data-testid="budget-breakdown">
                    {slices.map((s) => (
                      <li
                        key={s.categoryId ?? "direct"}
                        className="flex justify-between gap-3"
                      >
                        <span className="flex items-center gap-2">
                          <span
                            className="size-2.5 rounded-sm"
                            style={{ backgroundColor: s.color }}
                          />
                          {s.label}
                        </span>
                        <span className="tabular-nums">
                          {formatMinor(s.amountMinor)} (
                          {Math.round((s.amountMinor / budget.spentMinor) * 100)}
                          %)
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// --- Page ---

function BudgetsPage() {
  const queryClient = useQueryClient();
  const getBudgetsFn = useServerFn(getBudgets);
  const getCategoriesFn = useServerFn(getCategories);
  const createBudgetFn = useServerFn(createBudget);
  const updateBudgetFn = useServerFn(updateBudget);
  const deleteBudgetFn = useServerFn(deleteBudget);

  const { data: overview, isLoading } = useQuery({
    queryKey: BUDGETS_QUERY_KEY,
    queryFn: () => getBudgetsFn(),
    staleTime: 0,
  });
  const { data: categories = [] } = useQuery({
    queryKey: CATEGORIES_QUERY_KEY,
    queryFn: () => getCategoriesFn(),
  });

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Budget | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Budget | null>(null);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [upgradeLimit, setUpgradeLimit] = useState<number | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: BUDGETS_QUERY_KEY });

  const saveMutation = useMutation({
    mutationFn: (data: { categoryId: string; limitMinor: number }) =>
      (editing
        ? updateBudgetFn({ data: { id: editing.id, limitMinor: data.limitMinor } })
        : createBudgetFn({ data })) as Promise<MutationResult>,
    onSuccess: (result) => {
      if ("error" in result) {
        if (result.code === "budget_limit_reached") {
          setFormOpen(false);
          setUpgradeLimit(result.limit ?? usage?.limit ?? 0);
        } else {
          setFormError(errorMessage(result));
        }
        invalidate();
        return;
      }
      setFormOpen(false);
      invalidate();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      deleteBudgetFn({ data: { id } }) as Promise<MutationResult>,
    onSuccess: () => {
      setDeleting(null);
      invalidate();
    },
  });

  const budgets = overview?.budgets ?? [];
  const usage = overview?.usage;
  const month = overview?.month ?? "";
  const details = budgets.find((b) => b.id === detailsId) ?? null;

  // Category select: only categories without a budget, children indented
  // under their parent like on the Categories page.
  const budgeted = new Set(budgets.map((b) => b.categoryId));
  const categoryOptions: Array<{ id: string; label: string }> = [];
  const byParent = new Map<string | null, typeof categories>();
  for (const c of categories) {
    const list = byParent.get(c.parent_id) ?? [];
    list.push(c);
    byParent.set(c.parent_id, list);
  }
  const walk = (parentId: string | null, depth: number) => {
    for (const c of byParent.get(parentId) ?? []) {
      if (!budgeted.has(c.id)) {
        categoryOptions.push({
          id: c.id,
          label: `${"  ".repeat(depth)}${c.name}`,
        });
      }
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);

  const openCreate = () => {
    if (usage && usage.limit !== null && usage.count >= usage.limit) {
      setUpgradeLimit(usage.limit);
      return;
    }
    setEditing(null);
    setFormError(null);
    setFormOpen(true);
  };

  const openEdit = (budget: Budget) => {
    setEditing(budget);
    setFormError(null);
    setFormOpen(true);
  };

  return (
    <main className="page-wrap px-4 py-8">
      <div className="flex items-start justify-between gap-4 mb-2">
        <div>
          <h1 className="text-2xl font-semibold">{m.budgets_title()}</h1>
          {month && (
            <p className="text-sm text-muted-foreground">
              {m.budgets_subtitle({ month: formatBudgetMonth(month) })}
            </p>
          )}
        </div>
        <Button onClick={openCreate}>+ {m.budgets_new()}</Button>
      </div>
      {usage && (
        <p className="text-sm text-muted-foreground mb-6" data-testid="budgets-usage">
          {usage.limit === null
            ? m.budgets_usage_unlimited({ used: usage.count })
            : m.budgets_usage_free({ used: usage.count, limit: usage.limit })}
        </p>
      )}

      {isLoading ? null : budgets.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <h2 className="font-medium mb-1">{m.budgets_empty_title()}</h2>
          <p className="text-sm text-muted-foreground mb-4">
            {m.budgets_empty_body()}
          </p>
          <Button onClick={openCreate}>{m.budgets_create_first()}</Button>
        </div>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {budgets.map((budget) => (
            <BudgetCard
              key={budget.id}
              budget={budget}
              onOpen={() => setDetailsId(budget.id)}
              onEdit={() => openEdit(budget)}
              onDelete={() => setDeleting(budget)}
            />
          ))}
        </ul>
      )}

      <BudgetForm
        isOpen={formOpen}
        editing={editing}
        categoryOptions={categoryOptions}
        onClose={() => setFormOpen(false)}
        onSubmit={(data) => {
          setFormError(null);
          saveMutation.mutate(data);
        }}
        error={formError}
        submitting={saveMutation.isPending}
      />

      <UpgradeDialog
        isOpen={upgradeLimit !== null}
        limit={upgradeLimit ?? 0}
        onClose={() => setUpgradeLimit(null)}
      />

      <BudgetDetails
        budget={details}
        month={month}
        onClose={() => setDetailsId(null)}
      />

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.budgets_delete_title()}</AlertDialogTitle>
            <AlertDialogDescription>
              {m.budgets_delete_description({
                category: deleting?.categoryName ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{m.budgets_cancel()}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (deleting) deleteMutation.mutate(deleting.id);
              }}
            >
              {m.budgets_delete_confirm()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
