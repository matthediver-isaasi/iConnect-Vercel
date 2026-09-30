import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Plus, Trash2, Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";

// Shared Budget panel for both event editors.
// - Stat cards: budgeted vs actual costs/revenue/profit
// - Budgeted costs/income inputs (owned by the parent editor, saved with the event)
// - Itemised actual cost lines (EventCostLine entity, saved immediately)
// - Actual revenue computed server-side from non-cancelled booking totals

const NO_TYPE = "__none__";

export function formatBudgetMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "£0.00";
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(n);
}

function StatCard({ label, value, tone = "neutral", testId }) {
  const toneClass =
    tone === "positive" ? "text-green-700" :
    tone === "negative" ? "text-red-600" :
    "text-slate-900";
  return (
    <div className="p-4 bg-slate-50 rounded-lg border border-slate-200" data-testid={testId}>
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">{label}</p>
      <p className={`text-xl font-semibold mt-1 ${toneClass}`}>{value}</p>
    </div>
  );
}

export default function EventBudgetPanel({
  eventId,
  eventKind, // 'simple' | 'complex'
  budgetedCosts,
  budgetedIncome,
  onBudgetedCostsChange,
  onBudgetedIncomeChange,
}) {
  const queryClient = useQueryClient();
  const [newLine, setNewLine] = useState({ description: "", cost_type: "", quantity: "1", unit_cost: "" });
  const [addingLine, setAddingLine] = useState(false);
  const [savingLineId, setSavingLineId] = useState(null);
  // Local draft edits for existing lines, keyed by line id, committed on blur.
  const [lineDrafts, setLineDrafts] = useState({});

  const linesQueryKey = ["event-cost-lines", eventKind, eventId];

  const { data: costLines = [], isLoading: loadingLines } = useQuery({
    queryKey: linesQueryKey,
    queryFn: () => base44.entities.EventCostLine.list({
      filter: { event_id: eventId, event_kind: eventKind },
      sort: { created_at: "asc" },
    }),
    enabled: !!eventId,
  });

  // Cost types from Event Settings (SystemSettings key: event_cost_types)
  const { data: systemSettings = [] } = useQuery({
    queryKey: ["/api/entities/SystemSettings"],
    queryFn: () => base44.entities.SystemSettings.list(),
  });
  const costTypes = useMemo(() => {
    const setting = systemSettings.find(s => s.setting_key === "event_cost_types");
    if (!setting?.setting_value) return [];
    try {
      const parsed = JSON.parse(setting.setting_value);
      return Array.isArray(parsed) ? parsed.filter(t => typeof t === "string") : [];
    } catch {
      return [];
    }
  }, [systemSettings]);

  // Actual revenue from ticket sales (server-computed, excludes cancelled bookings)
  const { data: revenueData, isLoading: loadingRevenue, isError: revenueError } = useQuery({
    queryKey: ["event-budget-revenue", eventKind, eventId],
    queryFn: async () => {
      const response = await fetch(
        `/api/events/budget-revenue?event_id=${encodeURIComponent(eventId)}&kind=${eventKind}`,
        { credentials: "include" }
      );
      if (!response.ok) throw new Error("Failed to fetch actual revenue");
      return response.json();
    },
    enabled: !!eventId,
  });

  const actualRevenue = Number(revenueData?.actual_revenue) || 0;
  const actualCosts = useMemo(
    () => costLines.reduce((sum, l) => sum + (Number(l.quantity) || 0) * (Number(l.unit_cost) || 0), 0),
    [costLines]
  );
  const bCosts = Number(budgetedCosts) || 0;
  const bIncome = Number(budgetedIncome) || 0;
  const budgetedProfit = bIncome - bCosts;
  const actualProfit = actualRevenue - actualCosts;

  const handleAddLine = async () => {
    if (!newLine.description.trim()) {
      toast.error("Please enter a description for the cost line");
      return;
    }
    setAddingLine(true);
    try {
      await base44.entities.EventCostLine.create({
        event_id: eventId,
        event_kind: eventKind,
        description: newLine.description.trim(),
        cost_type: newLine.cost_type || null,
        quantity: Number(newLine.quantity) || 0,
        unit_cost: Number(newLine.unit_cost) || 0,
      });
      setNewLine({ description: "", cost_type: "", quantity: "1", unit_cost: "" });
      queryClient.invalidateQueries({ queryKey: linesQueryKey });
    } catch (error) {
      toast.error("Failed to add cost line: " + (error.message || "Unknown error"));
    } finally {
      setAddingLine(false);
    }
  };

  const getLineValue = (line, field) => {
    const draft = lineDrafts[line.id];
    if (draft && Object.prototype.hasOwnProperty.call(draft, field)) return draft[field];
    return line[field] ?? "";
  };

  const setLineDraft = (lineId, field, value) => {
    setLineDrafts(prev => ({ ...prev, [lineId]: { ...(prev[lineId] || {}), [field]: value } }));
  };

  const commitLine = async (line, overrides = {}) => {
    const draft = { ...(lineDrafts[line.id] || {}), ...overrides };
    if (Object.keys(draft).length === 0) return;
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(draft, "description")) patch.description = draft.description;
    if (Object.prototype.hasOwnProperty.call(draft, "cost_type")) patch.cost_type = draft.cost_type || null;
    if (Object.prototype.hasOwnProperty.call(draft, "quantity")) patch.quantity = Number(draft.quantity) || 0;
    if (Object.prototype.hasOwnProperty.call(draft, "unit_cost")) patch.unit_cost = Number(draft.unit_cost) || 0;
    setSavingLineId(line.id);
    try {
      await base44.entities.EventCostLine.update(line.id, patch);
      setLineDrafts(prev => {
        const next = { ...prev };
        delete next[line.id];
        return next;
      });
      queryClient.invalidateQueries({ queryKey: linesQueryKey });
    } catch (error) {
      toast.error("Failed to save cost line: " + (error.message || "Unknown error"));
    } finally {
      setSavingLineId(null);
    }
  };

  const handleDeleteLine = async (lineId) => {
    try {
      await base44.entities.EventCostLine.delete(lineId);
      queryClient.invalidateQueries({ queryKey: linesQueryKey });
    } catch (error) {
      toast.error("Failed to delete cost line: " + (error.message || "Unknown error"));
    }
  };

  return (
    <div className="space-y-6" data-testid="event-budget-panel">
      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard label="Budgeted Costs" value={formatBudgetMoney(bCosts)} testId="stat-budgeted-costs" />
        <StatCard label="Budgeted Revenue" value={formatBudgetMoney(bIncome)} testId="stat-budgeted-revenue" />
        <StatCard label="Actual Costs" value={formatBudgetMoney(actualCosts)} testId="stat-actual-costs" />
        <StatCard
          label="Actual Revenue"
          value={revenueError ? "Unavailable" : loadingRevenue ? "…" : formatBudgetMoney(actualRevenue)}
          testId="stat-actual-revenue"
        />
        <StatCard
          label="Budgeted Profit"
          value={formatBudgetMoney(budgetedProfit)}
          tone={budgetedProfit >= 0 ? "positive" : "negative"}
          testId="stat-budgeted-profit"
        />
        <StatCard
          label="Actual Profit"
          value={revenueError ? "Unavailable" : loadingRevenue ? "…" : formatBudgetMoney(actualProfit)}
          tone={revenueError ? "neutral" : actualProfit >= 0 ? "positive" : "negative"}
          testId="stat-actual-profit"
        />
      </div>

      {/* Budgeted figures (saved with the event) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="budgeted-costs">Budgeted Costs (£)</Label>
          <Input
            id="budgeted-costs"
            type="number"
            min="0"
            step="0.01"
            placeholder="0.00"
            value={budgetedCosts}
            onChange={(e) => onBudgetedCostsChange(e.target.value)}
            data-testid="input-budgeted-costs"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="budgeted-income">Budgeted Income (£)</Label>
          <Input
            id="budgeted-income"
            type="number"
            min="0"
            step="0.01"
            placeholder="0.00"
            value={budgetedIncome}
            onChange={(e) => onBudgetedIncomeChange(e.target.value)}
            data-testid="input-budgeted-income"
          />
        </div>
      </div>
      <p className="text-xs text-slate-500">
        Budgeted figures are saved when you save the event. Cost line items below are saved immediately.
      </p>

      {/* Actual cost line items */}
      <div className="space-y-3">
        <h4 className="text-sm font-semibold text-slate-800">Actual Cost Line Items</h4>
        {!eventId ? (
          <p className="text-sm text-slate-500">Save the event first to add cost line items.</p>
        ) : (
          <>
            {loadingLines ? (
              <div className="flex items-center gap-2 text-sm text-slate-500 py-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading cost lines…
              </div>
            ) : costLines.length === 0 ? (
              <p className="text-sm text-slate-500">No cost lines yet. Add your first one below.</p>
            ) : (
              <div className="space-y-2">
                <div className="hidden md:grid md:grid-cols-[1fr_170px_90px_120px_100px_40px] gap-2 px-1 text-xs font-medium text-slate-500 uppercase tracking-wider">
                  <span>Description</span>
                  <span>Cost Type</span>
                  <span>Qty</span>
                  <span>Unit Cost (£)</span>
                  <span className="text-right">Line Total</span>
                  <span />
                </div>
                {costLines.map((line) => {
                  const qty = Number(getLineValue(line, "quantity")) || 0;
                  const unit = Number(getLineValue(line, "unit_cost")) || 0;
                  return (
                    <div
                      key={line.id}
                      className="grid grid-cols-2 md:grid-cols-[1fr_170px_90px_120px_100px_40px] gap-2 items-center p-2 bg-slate-50 rounded-lg border border-slate-200"
                      data-testid={`cost-line-${line.id}`}
                    >
                      <Input
                        className="col-span-2 md:col-span-1"
                        value={getLineValue(line, "description")}
                        onChange={(e) => setLineDraft(line.id, "description", e.target.value)}
                        onBlur={() => commitLine(line)}
                        placeholder="Description"
                        data-testid={`input-line-description-${line.id}`}
                      />
                      <Select
                        value={getLineValue(line, "cost_type") || NO_TYPE}
                        onValueChange={(v) => commitLine(line, { cost_type: v === NO_TYPE ? "" : v })}
                      >
                        <SelectTrigger data-testid={`select-line-cost-type-${line.id}`}>
                          <SelectValue placeholder="Cost type" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NO_TYPE}>No type</SelectItem>
                          {costTypes.map((t) => (
                            <SelectItem key={t} value={t}>{t}</SelectItem>
                          ))}
                          {line.cost_type && !costTypes.includes(line.cost_type) && (
                            <SelectItem value={line.cost_type}>{line.cost_type}</SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                      <Input
                        type="number"
                        min="0"
                        step="1"
                        value={getLineValue(line, "quantity")}
                        onChange={(e) => setLineDraft(line.id, "quantity", e.target.value)}
                        onBlur={() => commitLine(line)}
                        data-testid={`input-line-quantity-${line.id}`}
                      />
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={getLineValue(line, "unit_cost")}
                        onChange={(e) => setLineDraft(line.id, "unit_cost", e.target.value)}
                        onBlur={() => commitLine(line)}
                        data-testid={`input-line-unit-cost-${line.id}`}
                      />
                      <span className="text-sm font-medium text-slate-800 text-right" data-testid={`text-line-total-${line.id}`}>
                        {savingLineId === line.id ? "…" : formatBudgetMoney(qty * unit)}
                      </span>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="text-red-600 hover:text-red-700 hover:bg-red-50"
                        onClick={() => handleDeleteLine(line.id)}
                        data-testid={`button-delete-line-${line.id}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  );
                })}
                <div className="flex justify-end px-1">
                  <span className="text-sm font-semibold text-slate-900" data-testid="text-cost-lines-total">
                    Total actual costs: {formatBudgetMoney(actualCosts)}
                  </span>
                </div>
              </div>
            )}

            {/* Add new line */}
            <div className="p-3 bg-slate-50 rounded-lg border border-dashed border-slate-300 space-y-2">
              <Label className="text-sm font-medium">Add Cost Line</Label>
              <div className="grid grid-cols-2 md:grid-cols-[1fr_170px_90px_120px_auto] gap-2 items-center">
                <Input
                  className="col-span-2 md:col-span-1"
                  placeholder="Description (e.g. Venue deposit)"
                  value={newLine.description}
                  onChange={(e) => setNewLine({ ...newLine, description: e.target.value })}
                  data-testid="input-new-line-description"
                />
                <Select
                  value={newLine.cost_type || NO_TYPE}
                  onValueChange={(v) => setNewLine({ ...newLine, cost_type: v === NO_TYPE ? "" : v })}
                >
                  <SelectTrigger data-testid="select-new-line-cost-type">
                    <SelectValue placeholder="Cost type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_TYPE}>No type</SelectItem>
                    {costTypes.map((t) => (
                      <SelectItem key={t} value={t}>{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  type="number"
                  min="0"
                  step="1"
                  placeholder="Qty"
                  value={newLine.quantity}
                  onChange={(e) => setNewLine({ ...newLine, quantity: e.target.value })}
                  data-testid="input-new-line-quantity"
                />
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Unit cost"
                  value={newLine.unit_cost}
                  onChange={(e) => setNewLine({ ...newLine, unit_cost: e.target.value })}
                  data-testid="input-new-line-unit-cost"
                />
                <Button onClick={handleAddLine} disabled={addingLine} variant="outline" data-testid="button-add-cost-line">
                  {addingLine ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}
                  Add
                </Button>
              </div>
              {costTypes.length === 0 && (
                <p className="text-xs text-slate-500">
                  Tip: manage cost types (e.g. Venue hire, Catering) in Event Settings.
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
