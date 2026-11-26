import { organisationActivityPurchase } from '@/lib/organisationActivityPurchase';

export default function OrganisationActivityPurchaseSummary({ submission, canView, tenantId, organizationId }) {
  const summary = organisationActivityPurchase(submission, { canView, tenantId, organizationId });
  if (!summary) return null;
  return (
    <div className="mt-2 space-y-1 text-sm text-slate-600 dark:text-slate-300" data-testid={`activity-purchase-${submission.id}`}>
      <p className="font-medium">Invoice order</p>
      {summary.items.length > 0
        ? <ul className="list-disc pl-5 break-words">{summary.items.map((item, index) => <li key={index}>{item}</li>)}</ul>
        : <p>Item details not recorded</p>}
      {summary.amount && <p>Recorded order amount: {summary.amount}</p>}
      <p>{summary.invoice}</p>
      {summary.invoiceStatus && <p>Recorded invoice status: {summary.invoiceStatus}</p>}
      <p>Recorded payment status: {summary.paymentStatus}</p>
    </div>
  );
}
