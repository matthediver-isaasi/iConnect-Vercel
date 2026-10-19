import DOMPurify from "dompurify";
import BillingSchedule from "./BillingSchedule";
import { billingScheduleOf } from "./billingGroups";
import { legalHtmlOf, signaturePayload } from "./agreementSignature";

export function LegalContent({ html }) {
  const clean = DOMPurify.sanitize(html || "", {
    ALLOWED_TAGS: ["p", "br", "strong", "em", "u", "s", "h1", "h2", "h3", "h4", "ul", "ol", "li", "blockquote", "table", "thead", "tbody", "tr", "th", "td"],
    ALLOWED_ATTR: ["colspan", "rowspan"],
  });
  return <div className="prose prose-sm max-w-none overflow-x-auto break-words [&_table]:w-full [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:bg-muted [&_th]:p-2" dangerouslySetInnerHTML={{ __html: clean }} />;
}

export function AgreementSignatureDisplay({ signer, title = "Sender signature" }) {
  const signature = signaturePayload(signer?.signature);
  return <section aria-label={title} className="space-y-2 rounded-lg border p-4"><h3 className="font-semibold">{title}</h3>{signature ? <img alt={`${title} of ${signer.name || "signatory"}`} src={signature.data} className="h-28 max-w-full object-contain object-left" /> : <p className="text-sm text-muted-foreground">Not yet signed</p>}<p className="text-sm">{[signer?.name, signer?.role].filter(Boolean).join(" · ")}</p>{(signer?.organization || signer?.organisation) && <p className="text-sm">{signer.organization || signer.organisation}</p>}{signer?.email && <p className="break-all text-sm text-muted-foreground">{signer.email}</p>}{signer?.signedAt && <p className="text-xs text-muted-foreground">Signed {new Date(signer.signedAt).toLocaleString()}</p>}</section>;
}

export default function AgreementDocument({ quote, sender, recipient, draft = false }) {
  const currency = quote.currency || "GBP";
  const money = value => { if (value == null) return "—"; try { return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(Number(value) / 100); } catch { return `${currency} ${(Number(value) / 100).toFixed(2)}`; } };
  const lines = quote.lines || quote.sales_quote_line || quote.line_items || [];
  const totals = quote.totals || {};
  const address = quote.address || quote.address_snapshot || {};
  const billingContact = quote.billing_contact_snapshot || quote.billingContact || {};
  const scheduled = quote.scheduledBilling ?? quote.scheduled_billing ?? Boolean(billingScheduleOf(quote));
  const terms = !scheduled && (quote.terms?.text || quote.terms_snapshot?.text || quote.termsSnapshot?.text || (typeof quote.terms === "string" ? quote.terms : "") || quote.paymentTerms || quote.payment_terms);
  const date = value => value ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value).toLocaleDateString(undefined, { dateStyle: "long" }) : "—";
  return <article aria-label="Full agreement preview" className="space-y-6 rounded-lg border bg-background p-4 sm:p-6">
    <header className="border-b pb-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">{draft ? "Draft agreement · Estimates" : "Agreement"} · Version {quote.versionNumber || quote.version_number || (typeof quote.version === "number" ? quote.version : 1)}</p><h2 className="mt-1 text-xl font-semibold">{quote.number || quote.quoteNumber || quote.quote_number || "Sales agreement"}</h2><p className="mt-2 text-sm">Prepared for {quote.customerName || quote.customer_name || quote.organisation_snapshot?.name || quote.organisation?.name || address.addressee || "customer"}</p><dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm"><dt>Issued</dt><dd>{date(quote.issueDate || quote.issue_date)}</dd><dt>Valid until</dt><dd>{date(quote.validUntil || quote.valid_until)}</dd>{(quote.event?.name || quote.event_snapshot?.name) && <><dt>Activity / event</dt><dd>{quote.event?.name || quote.event_snapshot?.name}</dd></>}</dl></header>
    <div className="grid gap-4 text-sm sm:grid-cols-2"><section><h3 className="mb-2 font-semibold">Billing address</h3>{[address.addressee, address.line1 || address.line_1, address.line2 || address.line_2, address.city, address.region, address.postalCode || address.postal_code, address.country].filter(Boolean).map((part, index) => <p key={index}>{part}</p>)}{(billingContact.name || billingContact.email) && <p className="mt-2 break-words">{billingContact.name} {billingContact.email}</p>}</section><section><h3 className="mb-2 font-semibold">References</h3><p>Purchase order: {quote.purchaseOrderReference || quote.purchase_order_reference || "—"}</p><p>Customer reference: {quote.customerReference || quote.customer_reference || "—"}</p></section></div>
    <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm"><thead><tr className="border-b"><th className="py-2">Description / benefits</th><th className="px-3 py-2">Quantity</th><th className="px-3 py-2 text-right">Unit price</th><th className="px-3 py-2 text-right">Discount</th><th className="px-3 py-2 text-right">Tax</th><th className="py-2 text-right">Total</th></tr></thead><tbody>{lines.map((line, index) => {
      const components = line.bundleComponents || line.sales_quote_bundle_component || line.bundle_components || [];
      const gross = line.grossMinor ?? line.gross_minor ?? line.totalMinor ?? line.total_minor ?? (draft ? Math.round(Number(line.quantity || 0) * Number(line.quotedUnitPriceMinor || 0) * (1 - Number(line.discountBps || 0) / 10000) * (1 + Number(line.taxRateBps || 0) / 10000)) : null);
      return <tr key={line.key || line.id || index} className="border-b"><td className="py-3"><strong>{line.description || line.name}</strong>{line.detail && <p className="text-muted-foreground">{line.detail}</p>}{components.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted-foreground">{components.map((component, componentIndex) => <li key={component.id || componentIndex}>{component.quantity} × {component.name || component.product_snapshot?.name || component.productSnapshot?.name || "Included product"}</li>)}</ul>}</td><td className="px-3">{line.quantity}</td><td className="px-3 text-right">{money(line.quotedUnitPriceMinor ?? line.quoted_unit_price_minor)}</td><td className="px-3 text-right">{Number(line.discountBps ?? line.discount_bps ?? 0) / 100}%</td><td className="px-3 text-right">{Number(line.taxRateBps ?? line.tax_rate_bps ?? 0) / 100}%</td><td className="text-right">{money(gross)}</td></tr>;
    })}</tbody></table></div>
    <dl className="ml-auto grid max-w-sm grid-cols-2 gap-2 text-sm"><dt>Net</dt><dd className="text-right">{money(totals.netMinor ?? totals.net_minor ?? quote.netMinor ?? quote.net_minor)}</dd><dt>Tax</dt><dd className="text-right">{money(totals.taxMinor ?? totals.tax_minor ?? quote.taxMinor ?? quote.tax_minor)}</dd><dt className="font-semibold">Total</dt><dd className="text-right font-semibold">{money(totals.grossMinor ?? totals.gross_minor ?? quote.grossMinor ?? quote.gross_minor)}</dd></dl>
    <div className="text-sm">{terms && <div><h3 className="font-semibold">Payment terms</h3><p className="mt-1 whitespace-pre-wrap">{terms}</p></div>}{quote.notes && <div className="mt-3"><h3 className="font-semibold">Notes</h3><p className="mt-1 whitespace-pre-wrap">{quote.notes}</p></div>}</div>
    {scheduled && <BillingSchedule schedule={billingScheduleOf(quote)} />}
    <section aria-label="Legal agreement"><LegalContent html={legalHtmlOf(quote)} /></section>
    <div className="grid gap-4 sm:grid-cols-2"><AgreementSignatureDisplay signer={sender} /><AgreementSignatureDisplay signer={recipient} title="Customer signature" /></div>
  </article>;
}
