import { CalendarDays } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { billingTimingText, billingValue } from "./billingGroups";

export const billingMoney = (amount, currency = "GBP") => {
  try { return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(Number(amount || 0) / 100); }
  catch { return `${currency} ${Number(amount || 0) / 100}`; }
};
const contentText = item => typeof item === "string" ? item : `${item.quantity ? `${item.quantity} × ` : ""}${item.name || item.description || "Product"}`;

export default function BillingSchedule({ schedule, pending = false }) {
  if (!schedule) return null;
  const groups = schedule.groups || [];
  return <Card className="border-blue-100"><CardHeader><CardTitle className="flex items-center gap-2"><CalendarDays className="h-5 w-5 text-blue-600" />Billing schedule</CardTitle><p className="text-sm text-slate-500">Each group is a separate billing commitment. Nothing is invoiced or emailed before acceptance.</p></CardHeader>
    <CardContent className="space-y-4">
      {pending && <p role="status" className="rounded bg-amber-50 p-3 text-sm text-amber-800">This is the last calculated schedule. Recalculate after editing to see updated commitments.</p>}
      <p className="text-xs text-slate-500">Calendar dates use {schedule.timezone || "UTC"}{billingValue(schedule, "timezoneFallback", "timezone_fallback", !schedule.timezone) ? " — UTC fallback: no tenant timezone configured" : ""}. Delayed processing uses the actual issue date; payment terms run from that date.</p>
      {!groups.length ? <p className="rounded-lg border border-dashed p-4 text-sm text-slate-500">No billing groups returned. Recalculate or reload the saved version before issuing.</p> : <ol className="space-y-3">{groups.map((group, index) => {
        const terms = billingValue(group, "paymentTerms", "payment_terms", {});
        const gross = billingValue(group, "grossMinor", "gross_minor", 0);
        const linePosition = billingValue(group, "linePosition", "line_position", null);
        return <li key={`${group.id}-${linePosition ?? "remainder"}-${index}`} className="rounded-lg border bg-slate-50/50 p-4">
          <div className="flex flex-wrap justify-between gap-3"><div><p className="font-semibold">{group.name}</p><p className="mt-1 text-xs text-slate-500">{linePosition === null ? "Remainder · standalone and ungrouped lines" : `Line ${Number(linePosition) + 1} · Group ${Number(group.position ?? index) + 1}`}</p></div><div className="text-right"><p className="font-semibold">{billingMoney(gross, group.currency)}</p><p className="text-xs text-slate-500">Net {billingMoney(billingValue(group, "netMinor", "net_minor", 0), group.currency)} · Tax {billingMoney(billingValue(group, "taxMinor", "tax_minor", 0), group.currency)}</p></div></div>
           {group.bundleLineLabel && <p className="mt-2 text-xs font-medium text-slate-600">{group.bundleLineLabel}</p>}
           <ul className="mt-3 space-y-1 text-xs text-slate-600">{(group.contents || []).map((item, i) => <li key={i}>{contentText(item)}</li>)}</ul>
          <div className="mt-3 border-t pt-3 text-sm"><p>{billingTimingText(group.timing)}</p><p className="mt-1 text-xs text-slate-600">{terms.name || "Payment terms"} · Payment due {terms.days ?? 0} calendar days after invoice issue.</p>{Number(gross) === 0 && <p className="mt-2 font-medium text-slate-600">No invoice required</p>}</div>
        </li>;
      })}</ol>}
      {schedule.recipient && <p className="break-words text-xs text-slate-500">Invoice recipient: {[schedule.recipient.name, schedule.recipient.email].filter(Boolean).join(" · ") || "Not available — confirm billing contact before issuing."}</p>}
    </CardContent>
  </Card>;
}
