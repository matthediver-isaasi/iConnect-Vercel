import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, ExternalLink, History } from "lucide-react";

export function formatHistoricalDdAmount(amountMinor, currency = "GBP") {
  if (!Number.isInteger(amountMinor)) return "—";
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
  }).format(amountMinor / 100);
}

export function formatHistoricalDdDate(value, options = {}) {
  const date = value ? new Date(`${String(value).slice(0, 10)}T00:00:00Z`) : null;
  if (!date || Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleDateString("en-GB", {
    month: options.monthOnly ? "long" : "short",
    year: "numeric",
    ...(options.monthOnly ? {} : { day: "numeric" }),
    timeZone: "UTC",
  });
}

export function HistoricalDdPaymentsTable({ payments }) {
  return (
    <div className="border rounded-md overflow-auto">
      <table className="w-full text-sm" data-testid="table-historical-dd">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="text-left p-3 font-medium">Nominal period</th>
            <th className="text-left p-3 font-medium">Charged</th>
            <th className="text-right p-3 font-medium">Amount</th>
            <th className="text-left p-3 font-medium">Status</th>
            <th className="text-left p-3 font-medium">Xero invoice</th>
          </tr>
        </thead>
        <tbody>
          {payments.map((payment) => (
            <tr className="border-b last:border-0" key={payment.id} data-testid={`row-historical-dd-${payment.id}`}>
              <td className="p-3 font-medium">{formatHistoricalDdDate(payment.period, { monthOnly: true })}</td>
              <td className="p-3">{formatHistoricalDdDate(payment.charge_date)}</td>
              <td className="p-3 text-right font-medium">
                {formatHistoricalDdAmount(payment.amount_minor, payment.currency)}
              </td>
              <td className="p-3">
                <Badge variant="secondary">{payment.provider_status === "paid_out" ? "Paid out" : payment.provider_status}</Badge>
              </td>
              <td className="p-3">
                {payment.xero_invoice_url ? (
                  <a
                    className="inline-flex items-center gap-1 text-primary underline underline-offset-2"
                    href={payment.xero_invoice_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid={`link-historical-dd-invoice-${payment.id}`}
                  >
                    {payment.xero_invoice_number}
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                ) : payment.xero_invoice_number || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="p-3 text-xs text-muted-foreground border-t">
        Imported historical records are read-only and never trigger a collection, retry, refund or accounting action.
      </p>
    </div>
  );
}

export default function HistoricalDdPayments({
  memberId,
  embedded = false,
  request = fetch,
  activeTenantId = null,
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["historical-dd-payments", activeTenantId, memberId],
    queryFn: async () => {
      const response = await request(`/api/membership/historical-dd?memberId=${encodeURIComponent(memberId)}`, {
        credentials: "include",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Failed to load historical Direct Debit payments");
      if (!Array.isArray(payload.payments)) throw new Error("Invalid historical Direct Debit response");
      return payload.payments;
    },
    enabled: !!memberId,
    retry: false,
  });

  if (!memberId || isLoading) return null;
  const body = error ? (
    <div className="flex items-start gap-2 text-sm text-destructive" role="alert" data-testid="historical-dd-error">
      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
      <span>{error.message}</span>
    </div>
  ) : !data?.length ? null : <HistoricalDdPaymentsTable payments={data} />;

  if (!body) return null;
  if (embedded) return <div className="space-y-2" data-testid="historical-dd-embedded">{body}</div>;
  return (
    <Card data-testid="card-historical-dd">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <History className="w-4 h-4" />
          Historical Direct Debit payments
        </CardTitle>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}