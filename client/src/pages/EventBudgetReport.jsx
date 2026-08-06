import { useState, useMemo, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Download, Calendar, Loader2, Receipt, Banknote, Ticket, Users, Building2, PoundSterling, Plus, Trash2 } from "lucide-react";
import { format, parseISO } from "date-fns";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { toast } from "sonner";

function money(v) {
  if (v === null || v === undefined) return "—";
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(Number(v) || 0);
}

function diffClass(v) {
  const n = Number(v) || 0;
  if (n > 0) return "text-green-700";
  if (n < 0) return "text-red-600";
  return "text-slate-700";
}

function SummaryCard({ label, value, icon: Icon, tone, testId }) {
  return (
    <Card data-testid={testId}>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-xs font-medium text-slate-500 uppercase tracking-wider">
          {Icon && <Icon className="w-3.5 h-3.5" />}
          {label}
        </div>
        <p className={`text-xl font-semibold mt-1 ${tone || "text-slate-900"}`}>{value}</p>
      </CardContent>
    </Card>
  );
}

// Inline dialog to view/add actual cost lines for an event (event_cost_line entity),
// so ad-hoc actuals like venue hire can be captured straight from the report.
function CostLinesDialog({ target, onClose, onChanged }) {
  const queryClient = useQueryClient();
  const [newLine, setNewLine] = useState({ description: "", cost_type: "", quantity: "1", unit_cost: "" });
  const [saving, setSaving] = useState(false);
  const eventId = target?.event_id;
  const eventKind = target?.event_kind;
  const linesQueryKey = ["event-cost-lines", eventKind, eventId];

  const { data: costLines = [], isLoading } = useQuery({
    queryKey: linesQueryKey,
    queryFn: async () => {
      const params = new URLSearchParams({ event_id: eventId, event_kind: eventKind });
      const response = await fetch(`/api/reports/event-budget-report-cost-lines?${params.toString()}`, { credentials: "include" });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to load cost lines");
      }
      const data = await response.json();
      return data.costLines || [];
    },
    enabled: !!eventId,
  });

  const total = useMemo(
    () => costLines.reduce((sum, l) => sum + (Number(l.quantity) || 0) * (Number(l.unit_cost) || 0), 0),
    [costLines]
  );

  const addLine = async () => {
    if (!newLine.description.trim()) {
      toast.error("Please enter a description for the cost line");
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(`/api/reports/event-budget-report-cost-lines`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          event_id: eventId,
          event_kind: eventKind,
          description: newLine.description.trim(),
          cost_type: newLine.cost_type.trim() || null,
          quantity: Number(newLine.quantity) || 0,
          unit_cost: Number(newLine.unit_cost) || 0,
        }),
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to add cost line");
      }
      setNewLine({ description: "", cost_type: "", quantity: "1", unit_cost: "" });
      await queryClient.invalidateQueries({ queryKey: linesQueryKey });
      onChanged?.();
      toast.success("Cost line added");
    } catch (error) {
      toast.error("Failed to add cost line: " + (error.message || "Unknown error"));
    } finally {
      setSaving(false);
    }
  };

  const deleteLine = async (lineId) => {
    try {
      const response = await fetch(`/api/reports/event-budget-report-cost-lines?id=${encodeURIComponent(lineId)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to delete cost line");
      }
      await queryClient.invalidateQueries({ queryKey: linesQueryKey });
      onChanged?.();
    } catch (error) {
      toast.error("Failed to delete cost line: " + (error.message || "Unknown error"));
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Actual Cost Lines</DialogTitle>
          <DialogDescription>
            {target?.event_name || "Event"} — itemised actual costs (saved immediately).
          </DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-slate-500 py-4">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading cost lines…
          </div>
        ) : (
          <div className="space-y-2 max-h-72 overflow-y-auto">
            {costLines.length === 0 && (
              <p className="text-sm text-slate-500">No cost lines yet. Add one below (e.g. venue hire).</p>
            )}
            {costLines.map((line) => (
              <div key={line.id} className="flex items-center gap-2 p-2 bg-slate-50 rounded-lg border border-slate-200" data-testid={`report-cost-line-${line.id}`}>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-800 truncate">{line.description}</p>
                  <p className="text-xs text-slate-500">
                    {line.cost_type ? `${line.cost_type} · ` : ""}
                    {Number(line.quantity) || 0} × {money(line.unit_cost)}
                  </p>
                </div>
                <span className="text-sm font-medium text-slate-800">
                  {money((Number(line.quantity) || 0) * (Number(line.unit_cost) || 0))}
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="text-red-600 hover:text-red-700 hover:bg-red-50"
                  onClick={() => deleteLine(line.id)}
                  data-testid={`button-report-delete-line-${line.id}`}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            ))}
            {costLines.length > 0 && (
              <div className="flex justify-end text-sm font-semibold text-slate-900 px-1">
                Total actual costs: {money(total)}
              </div>
            )}
          </div>
        )}
        <div className="p-3 bg-slate-50 rounded-lg border border-dashed border-slate-300 space-y-2">
          <Label className="text-sm font-medium">Add Cost Line</Label>
          <div className="grid grid-cols-2 md:grid-cols-[1fr_140px_80px_110px_auto] gap-2 items-center">
            <Input
              className="col-span-2 md:col-span-1"
              placeholder="Description (e.g. Venue hire)"
              value={newLine.description}
              onChange={(e) => setNewLine({ ...newLine, description: e.target.value })}
              data-testid="input-report-new-line-description"
            />
            <Input
              placeholder="Cost type"
              value={newLine.cost_type}
              onChange={(e) => setNewLine({ ...newLine, cost_type: e.target.value })}
              data-testid="input-report-new-line-cost-type"
            />
            <Input
              type="number" min="0" step="1" placeholder="Qty"
              value={newLine.quantity}
              onChange={(e) => setNewLine({ ...newLine, quantity: e.target.value })}
              data-testid="input-report-new-line-quantity"
            />
            <Input
              type="number" min="0" step="0.01" placeholder="Unit cost"
              value={newLine.unit_cost}
              onChange={(e) => setNewLine({ ...newLine, unit_cost: e.target.value })}
              data-testid="input-report-new-line-unit-cost"
            />
            <Button onClick={addLine} disabled={saving} variant="outline" data-testid="button-report-add-cost-line">
              {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}
              Add
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function EventBudgetReport() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const queryClient = useQueryClient();
  const [accessChecked, setAccessChecked] = useState(false);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [appliedFilters, setAppliedFilters] = useState(null);
  const [costLinesTarget, setCostLinesTarget] = useState(null);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded("page_EventBudgetReport")) {
        window.location.href = createPageUrl("Events");
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: reportData, isLoading, isFetching } = useQuery({
    queryKey: ["event-budget-report", appliedFilters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (appliedFilters?.dateFrom) params.set("eventDateFrom", appliedFilters.dateFrom);
      if (appliedFilters?.dateTo) params.set("eventDateTo", appliedFilters.dateTo);
      const response = await fetch(`/api/reports/event-budget-report?${params.toString()}`, { credentials: "include" });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to fetch report data");
      }
      return response.json();
    },
    enabled: !!appliedFilters,
    staleTime: 0,
    refetchOnMount: true,
  });

  const rows = reportData?.rows || [];
  const totals = reportData?.totals || null;

  const refetchReport = () => queryClient.invalidateQueries({ queryKey: ["event-budget-report", appliedFilters] });

  const exportCsv = () => {
    if (rows.length === 0) {
      toast.error("Nothing to export — generate the report first");
      return;
    }
    const headers = [
      "Project Code", "Event Name", "Event Date", "Type",
      "Actual Income", "Budgeted Income", "Income Difference",
      "Vouchers Redeemed", "Training Fund",
      "Actual Costs", "Budgeted Costs", "Costs Difference",
      "Actual Profit/Loss", "Budgeted Profit/Loss", "Profit Difference",
      "Seats", "Attendees", "Organisations",
    ];
    const esc = (v) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.map(esc).join(",")];
    for (const r of rows) {
      lines.push([
        r.project_code || "",
        r.event_name || "",
        r.start_date ? format(parseISO(r.start_date), "yyyy-MM-dd") : "",
        r.event_kind === "complex" ? "Complex" : "Simple",
        r.actual_income, r.budgeted_income ?? "", r.income_difference,
        r.vouchers_redeemed, r.training_fund_total,
        r.actual_costs, r.budgeted_costs ?? "", r.costs_difference,
        r.actual_profit, r.budgeted_profit, r.profit_difference,
        r.seats_unlimited ? "Unlimited" : r.seats, r.attendees, r.organisations,
      ].map(esc).join(","));
    }
    if (totals) {
      lines.push([
        "", "TOTALS", "", "",
        totals.actual_income, totals.budgeted_income, totals.income_difference,
        totals.vouchers_redeemed, totals.training_fund_total,
        totals.actual_costs, totals.budgeted_costs, totals.costs_difference,
        totals.actual_profit, totals.budgeted_profit, totals.profit_difference,
        totals.seats_unlimited ? "Unlimited" : totals.seats, totals.attendees, totals.organisations,
      ].map(esc).join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `event-budget-report-${format(new Date(), "yyyy-MM-dd")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!accessChecked) return null;

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-[1600px] mx-auto" data-testid="page-event-budget-report">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Event Budget Report</h1>
          <p className="text-sm text-slate-500">Budgeted vs actual income, costs and profit per event.</p>
        </div>
        <Button variant="outline" onClick={exportCsv} disabled={rows.length === 0} data-testid="button-export-csv">
          <Download className="w-4 h-4 mr-2" /> Export CSV
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Calendar className="w-4 h-4" /> Event Date Range
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="budget-date-from" className="text-xs">Events starting from</Label>
            <Input id="budget-date-from" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} data-testid="input-event-date-from" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="budget-date-to" className="text-xs">Events starting to</Label>
            <Input id="budget-date-to" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} data-testid="input-event-date-to" />
          </div>
          <Button
            onClick={() => setAppliedFilters({ dateFrom, dateTo })}
            disabled={isFetching}
            data-testid="button-generate-report"
          >
            {isFetching ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            Generate Report
          </Button>
          {appliedFilters && (
            <Button
              variant="ghost"
              onClick={() => { setDateFrom(""); setDateTo(""); setAppliedFilters({ dateFrom: "", dateTo: "" }); }}
              data-testid="button-clear-filters"
            >
              Clear dates
            </Button>
          )}
        </CardContent>
      </Card>

      {appliedFilters && isLoading && (
        <div className="flex items-center gap-2 text-slate-500 py-8 justify-center">
          <Loader2 className="w-5 h-5 animate-spin" /> Generating report…
        </div>
      )}

      {totals && !isLoading && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <SummaryCard label="Actual Income" value={money(totals.actual_income)} icon={Banknote} testId="card-total-actual-income" />
            <SummaryCard label="Budgeted Income" value={money(totals.budgeted_income)} icon={Banknote} testId="card-total-budgeted-income" />
            <SummaryCard label="Actual Costs" value={money(totals.actual_costs)} icon={Receipt} testId="card-total-actual-costs" />
            <SummaryCard label="Budgeted Costs" value={money(totals.budgeted_costs)} icon={Receipt} testId="card-total-budgeted-costs" />
            <SummaryCard label="Actual Profit/Loss" value={money(totals.actual_profit)} icon={PoundSterling} tone={diffClass(totals.actual_profit)} testId="card-total-actual-profit" />
            <SummaryCard label="Budgeted Profit/Loss" value={money(totals.budgeted_profit)} icon={PoundSterling} tone={diffClass(totals.budgeted_profit)} testId="card-total-budgeted-profit" />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <SummaryCard label="Vouchers Redeemed" value={money(totals.vouchers_redeemed)} icon={Ticket} testId="card-total-vouchers" />
            <SummaryCard label="Total Seats" value={totals.seats_unlimited ? `${totals.seats}+ (some unlimited)` : totals.seats} icon={Ticket} testId="card-total-seats" />
            <SummaryCard label="Total Attendees" value={totals.attendees} icon={Users} testId="card-total-attendees" />
            <SummaryCard label="Distinct Organisations" value={totals.organisations} icon={Building2} testId="card-total-organisations" />
          </div>

          <Card>
            <CardHeader className="pb-2 flex flex-row items-center justify-between">
              <CardTitle className="text-base">Events ({rows.length})</CardTitle>
              <span className="text-xs text-slate-500">Click "Costs" on a row to view or add actual cost lines.</span>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full text-sm" data-testid="table-event-budget">
                <thead>
                  <tr className="border-b bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
                    <th className="px-3 py-2">Project Code</th>
                    <th className="px-3 py-2">Event</th>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2 text-right">Actual Income</th>
                    <th className="px-3 py-2 text-right">Budgeted Income</th>
                    <th className="px-3 py-2 text-right">Diff</th>
                    <th className="px-3 py-2 text-right">Vouchers</th>
                    <th className="px-3 py-2 text-right">Actual Costs</th>
                    <th className="px-3 py-2 text-right">Budgeted Costs</th>
                    <th className="px-3 py-2 text-right">Diff</th>
                    <th className="px-3 py-2 text-right">Actual P/L</th>
                    <th className="px-3 py-2 text-right">Budgeted P/L</th>
                    <th className="px-3 py-2 text-right">Diff</th>
                    <th className="px-3 py-2 text-right">Seats</th>
                    <th className="px-3 py-2 text-right">Attendees</th>
                    <th className="px-3 py-2 text-right">Orgs</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr><td colSpan={17} className="px-3 py-6 text-center text-slate-500">No events found for the selected date range.</td></tr>
                  )}
                  {rows.map((r) => (
                    <tr key={`${r.event_kind}-${r.event_id}`} className="border-b hover:bg-slate-50" data-testid={`row-event-${r.event_id}`}>
                      <td className="px-3 py-2 font-mono text-xs">{r.project_code || "—"}</td>
                      <td className="px-3 py-2">
                        <div className="font-medium text-slate-900 max-w-[240px] truncate" title={r.event_name || ""}>{r.event_name || "Untitled"}</div>
                        {r.event_kind === "complex" && <Badge variant="outline" className="text-[10px] mt-0.5">Complex</Badge>}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">{r.start_date ? format(parseISO(r.start_date), "d MMM yyyy") : "—"}</td>
                      <td className="px-3 py-2 text-right">{money(r.actual_income)}</td>
                      <td className="px-3 py-2 text-right">{money(r.budgeted_income)}</td>
                      <td className={`px-3 py-2 text-right ${diffClass(r.income_difference)}`}>{money(r.income_difference)}</td>
                      <td className="px-3 py-2 text-right">{money(r.vouchers_redeemed)}</td>
                      <td className="px-3 py-2 text-right">{money(r.actual_costs)}</td>
                      <td className="px-3 py-2 text-right">{money(r.budgeted_costs)}</td>
                      <td className={`px-3 py-2 text-right ${diffClass(-r.costs_difference)}`}>{money(r.costs_difference)}</td>
                      <td className={`px-3 py-2 text-right font-medium ${diffClass(r.actual_profit)}`}>{money(r.actual_profit)}</td>
                      <td className={`px-3 py-2 text-right ${diffClass(r.budgeted_profit)}`}>{money(r.budgeted_profit)}</td>
                      <td className={`px-3 py-2 text-right ${diffClass(r.profit_difference)}`}>{money(r.profit_difference)}</td>
                      <td className="px-3 py-2 text-right">{r.seats_unlimited ? "Unlimited" : r.seats}</td>
                      <td className="px-3 py-2 text-right">{r.attendees}</td>
                      <td className="px-3 py-2 text-right">{r.organisations}</td>
                      <td className="px-3 py-2 text-right">
                        <Button size="sm" variant="outline" onClick={() => setCostLinesTarget(r)} data-testid={`button-cost-lines-${r.event_id}`}>
                          Costs
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}

      {!appliedFilters && (
        <Card>
          <CardContent className="py-10 text-center text-slate-500">
            Choose an optional event date range and click <span className="font-medium">Generate Report</span>.
          </CardContent>
        </Card>
      )}

      {costLinesTarget && (
        <CostLinesDialog
          target={costLinesTarget}
          onClose={() => setCostLinesTarget(null)}
          onChanged={refetchReport}
        />
      )}
    </div>
  );
}
