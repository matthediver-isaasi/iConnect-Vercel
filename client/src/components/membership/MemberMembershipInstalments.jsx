import React, { useEffect, useState } from "react";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Download,
  Eye,
  FileText,
  Loader2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * This endpoint is intentionally separate from the member membership summary.
 * A history row can be opened without making the initial member-detail request
 * load an unbounded payment ledger.
 *
 * The API is authorized by the backend from the authenticated member/admin
 * context and the history row id. The member id is deliberately not sent as
 * an authorization grant; the backend resolves ownership from the session and
 * tenant context.
 */
export const MEMBER_INSTALMENTS_ENDPOINT = "/api/membership/member-membership";
export const MEMBER_INSTALMENTS_PAGE_SIZE = 25;
export const MEMBER_MEMBERSHIP_SOURCES = new Set(["personal", "organisation"]);

/**
 * Membership history can contain rows from both ledgers.  Do not infer an
 * organisation row from the member's current organisation alone: a personal
 * membership can belong to a member who is currently assigned to an
 * organisation.  The history endpoint marks rows explicitly, with the
 * organisation_id fallback retained for older responses.
 */
export function getMembershipSource(record = {}) {
  if (record.membership_source === "personal") return "personal";
  if (
    record.membership_source === "organisation"
    || record.membership_source === "organization"
  ) {
    return "organisation";
  }
  return record.organization_id ? "organisation" : "personal";
}

function normalizeMembershipSource(value) {
  if (value === "organization") return "organisation";
  return MEMBER_MEMBERSHIP_SOURCES.has(value) ? value : "personal";
}

const STATUS_LABELS = {
  collected: "Collected",
  collection_pending: "Pending",
  collection_failed: "Failed",
  unknown: "Unknown",
  pending: "Pending",
  failed: "Failed",
  skipped: "Skipped",
  missing_accounting: "No accounting provider",
  invoice_unpaid: "Invoice unpaid",
  invoice_created: "Invoice created — payment not recorded",
  posted: "Posted",
  not_recorded: "Not recorded",
};

const STATUS_VARIANTS = {
  collected: "secondary",
  collection_pending: "outline",
  collection_failed: "destructive",
  failed: "destructive",
  invoice_unpaid: "warning",
  invoice_created: "warning",
  pending: "outline",
  skipped: "outline",
  missing_accounting: "outline",
  posted: "secondary",
  not_recorded: "outline",
};

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
}

function normalizeCollectionStatus(value) {
  const status = normalizeStatus(value);
  if (["confirmed", "paid_out", "succeeded", "paid", "collected"].includes(status)) {
    return "collected";
  }
  if (["failed", "cancelled", "canceled", "rejected"].includes(status)) {
    return "collection_failed";
  }
  if (["pending", "created", "submitted", "processing"].includes(status)) {
    return "collection_pending";
  }
  return status || "unknown";
}

function normalizeAccountingStatus(value) {
  const status = normalizeStatus(value);
  if (!status) return "not_recorded";
  if (status === "posting") return "pending";
  if (["synced", "paid", "complete", "completed"].includes(status)) return "posted";
  if (["unpaid", "invoice_not_paid"].includes(status)) return "invoice_unpaid";
  if (["created", "invoice_created_payment_not_recorded"].includes(status)) return "invoice_created";
  if (["no_accounting_provider", "no_accounting", "missing_provider"].includes(status)) {
    return "missing_accounting";
  }
  if (["not_applicable", "not_expected"].includes(status)) return "skipped";
  return status;
}

/**
 * Monthly rows have appeared with both the old payment-method names and the
 * newer agreement fields. Keep this predicate deliberately conservative:
 * annual history rows must retain their existing invoice controls and must
 * not make a monthly ledger request.
 */
export function isMonthlyMembershipRecord(record = {}) {
  const method = normalizeStatus(record.payment_method);
  const frequency = normalizeStatus(
    record.payment_frequency
      || record.interval_unit
      || record.billing_period
      || record.billing_frequency,
  );
  const hasAgreement = !!(
    record.billing_agreement_id
    || record.billingAgreementId
    || record.payment_plan_id
    || record.plan_id
  );

  if (!hasAgreement) return false;

  const monthlyPaymentMethod = new Set([
    "stripe_monthly_card",
    "card_monthly",
    "monthly_card",
    "monthly_direct_debit",
  ]);
  const monthlyBillingPeriod = new Set([
    "monthly",
    "monthly_card",
    "monthly_direct_debit",
    "monthly_instalments",
  ]);

  return monthlyPaymentMethod.has(method)
    || monthlyBillingPeriod.has(frequency)
    || (method === "direct_debit" && monthlyBillingPeriod.has(frequency))
    || toNumber(record.instalments_total) > 1;
}

function normalizeInvoiceId(item = {}) {
  // Only an internal instalment row id may be sent to the membership-invoice
  // endpoint. Provider invoice ids are not authorization references.
  return item.invoiceRecordId
    || item.invoice_record_id
    || item.instalmentInvoiceId
    || item.instalment_invoice_id
    || item.membershipInstalmentInvoiceId
    || item.membership_instalment_invoice_id
    || item.accountingRecordId
    || (item.id && (
      item.invoiceNumber
      || item.accountingInvoiceNumber
      || item.accounting_invoice_number
    ) ? item.id : null)
    || null;
}

export function normalizeCollection(item = {}) {
  const explicitCollectionStatus = item.collectionStatus
    || item.paymentStatus
    || item.payment_status
    || item.collection_status;
  const hasStripeCollectionRow = normalizeStatus(item.provider) === "stripe"
    && (item.paymentRef || item.payment_ref || item.externalPaymentId || item.external_payment_id || item.id);
  const collectionStatus = explicitCollectionStatus
    ? normalizeCollectionStatus(explicitCollectionStatus)
    : hasStripeCollectionRow
      ? "collected"
      : normalizeCollectionStatus(item.status);
  const rawAccountingStatus = item.accountingStatus
    || item.accountingSyncStatus
    || item.accounting_sync_status
    || item.accountingSyncState
    || item.accounting_sync_state
    || item.syncStatus;
  let accountingStatus = normalizeAccountingStatus(rawAccountingStatus);
  const paymentRecorded = item.paymentRecorded ?? item.payment_recorded;
  const hasInvoice = !!(
    item.invoiceRecordId
    || item.instalmentInvoiceId
    || item.membershipInstalmentInvoiceId
    || item.invoiceUrl
    || item.invoice_url
    || item.invoiceId
    || item.invoiceNumber
    || item.accountingInvoiceNumber
    || item.accounting_invoice_number
  );
  const reason = item.reason || item.skipReason || item.accountingSyncError || item.accounting_sync_error || null;
  if (accountingStatus === "skipped" && /accounting provider|no provider/i.test(String(reason || ""))) {
    accountingStatus = "missing_accounting";
  } else if (paymentRecorded === false && hasInvoice && accountingStatus === "posted") {
    accountingStatus = "invoice_unpaid";
  }

  return {
    ...item,
    // `status` remains the accounting state for existing callers. The
    // collectionStatus/accountingStatus pair is what the expanded row uses,
    // so a GoCardless `confirmed` collection with a null sync status cannot
    // be displayed as a pending collection.
    status: accountingStatus,
    collectionStatus,
    accountingStatus,
    paymentRef: item.paymentRef || item.payment_ref || item.externalPaymentId || item.external_payment_id || null,
    amount: toNumber(item.amount ?? item.amountMajor ?? (
      item.amountMinor !== undefined ? Number(item.amountMinor) / 100 : null
    )),
    currency: item.currency || "GBP",
    date: item.collectionDate || item.chargeDate || item.confirmedAt || item.date || item.createdAt || null,
    invoiceNumber: item.invoiceNumber
      || item.accountingInvoiceNumber
      || item.accounting_invoice_number
      || null,
    // The accounting invoice endpoint accepts the backend-issued invoiceUrl
    // (or its paymentRef). Never treat a provider invoice id as an
    // authorization reference.
    invoiceRecordId: normalizeInvoiceId(item) || item.paymentRef || item.payment_ref || null,
    invoiceUrl: item.invoiceUrl || item.invoice_url || null,
    reason,
  };
}

/**
 * Keep the response adapter tolerant of pagination wrappers used by the
 * member-detail API while still rendering a bounded page. The canonical
 * response is:
 *   { instalments, pagination: { page, pageSize, totalCount, hasNextPage } }
 */
export function normalizeInstalmentPage(body, requestedPage = 1, pageSize = MEMBER_INSTALMENTS_PAGE_SIZE) {
  const payload = Array.isArray(body) ? {} : (body || {});
  const source = Array.isArray(body)
    ? body
    : (payload.instalments || payload.items || payload.records || payload.data || []);
  const pagination = payload.pagination || payload.meta || {};
  const items = (Array.isArray(source) ? source : []).map(normalizeCollection);
  const page = Number(pagination.page || payload.page || requestedPage) || requestedPage;
  const effectivePageSize = Number(pagination.pageSize || pagination.page_size || payload.pageSize || pageSize) || pageSize;
  const total = pagination.total ?? pagination.totalCount ?? payload.total ?? payload.totalCount ?? null;
  const hasNext = pagination.hasNext
    ?? pagination.has_next
    ?? pagination.hasNextPage
    ?? payload.hasNext
    ?? payload.has_more
    ?? payload.hasNextPage
    ?? (total !== null ? page * effectivePageSize < Number(total) : items.length >= effectivePageSize);
  const hasPrevious = pagination.hasPrevious
    ?? pagination.has_previous
    ?? page > 1;

  return {
    items,
    page,
    pageSize: effectivePageSize,
    total,
    hasNext: !!hasNext,
    hasPrevious: !!hasPrevious,
    accountingProvider: payload.accountingProvider
      ?? payload.accounting_provider
      ?? null,
    ledgerState: payload.ledger?.state || null,
    ledgerMissing: payload.ledger?.missing === true,
    hasAccountingProvider: payload.hasAccountingProvider
      ?? payload.has_accounting_provider
      ?? undefined,
    invoicingMode: payload.invoicingMode
      || payload.invoicing_mode
      || payload.modeSnapshot?.invoicingMode
      || payload.modeSnapshot?.invoicing_mode
      || null,
  };
}

export function instalmentStatusLabel(status) {
  const normalized = normalizeStatus(status);
  return STATUS_LABELS[normalized] || (normalized ? normalized.replaceAll("_", " ") : "Pending");
}

export function collectionStatusLabel(status) {
  return instalmentStatusLabel(status);
}

function formatAmount(value, currency) {
  if (value === null || value === undefined) return "—";
  const code = String(currency || "GBP").toUpperCase();
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${code} ${Number(value).toFixed(2)}`;
  }
}

function formatDate(value) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function InvoiceButtons({
  item,
  source,
  onViewInvoice,
  onDownloadInvoice,
  loadingInvoiceId,
}) {
  // A payment reference is useful for identifying a collection, but is not
  // itself proof that an accounting invoice exists.  In particular, failed,
  // pending, and skipped rows must not expose invoice actions that can only
  // result in a confusing 404 from the scoped invoice endpoint.
  const hasInvoice = !!(
    item.invoiceUrl
    || item.invoiceId
    || item.accountingInvoiceId
    || item.invoiceNumber
  );
  if (!item.invoiceRecordId || !hasInvoice) return null;
  const busy = loadingInvoiceId === item.invoiceRecordId || loadingInvoiceId === item.paymentRef;

  return (
    <div className="flex items-center gap-1">
      {busy ? (
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" data-testid={`spinner-instalment-invoice-${item.invoiceRecordId}`} />
      ) : (
        <>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => onViewInvoice?.(item.paymentRef, item.invoiceNumber, "instalment", item.invoiceUrl, source)}
            title={`View invoice ${item.invoiceNumber || ""}`.trim()}
            data-testid={`button-view-instalment-invoice-${item.invoiceRecordId}`}
          >
            <Eye className="w-4 h-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => onDownloadInvoice?.(item.paymentRef, item.invoiceNumber, "instalment", item.invoiceUrl, source)}
            title={`Download invoice ${item.invoiceNumber || ""}`.trim()}
            data-testid={`button-download-instalment-invoice-${item.invoiceRecordId}`}
          >
            <Download className="w-4 h-4" />
          </Button>
        </>
      )}
    </div>
  );
}

/**
 * Details row for one monthly membership history row. The parent owns the
 * expanded id so the table row remains stable, while this component retains
 * fetched pages when the row is collapsed and expanded again.
 */
export default function MemberMembershipInstalments({
  record,
  expanded = false,
  source = null,
  onViewInvoice,
  onDownloadInvoice,
  loadingInvoiceId,
}) {
  const historyId = record?.id;
  const membershipSource = normalizeMembershipSource(source || getMembershipSource(record));
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState({});
  const [loadingPage, setLoadingPage] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setPage(1);
    setPages({});
    setLoadingPage(null);
    setError("");
  }, [historyId, membershipSource]);

  useEffect(() => {
    if (!expanded || !historyId || pages[page] || loadingPage === page) return undefined;

    let active = true;
    const loadPage = async () => {
      setLoadingPage(page);
      setError("");
      try {
        const params = new URLSearchParams({
          recordId: String(historyId),
          instalments: "true",
          page: String(page),
          source: membershipSource,
        });
        const response = await fetch(`${MEMBER_INSTALMENTS_ENDPOINT}?${params.toString()}`, {
          credentials: "include",
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "Failed to load monthly instalments");
        if (active) setPages((previous) => ({
          ...previous,
          [page]: normalizeInstalmentPage(body, page),
        }));
      } catch (loadError) {
        if (active) setError(loadError.message || "Failed to load monthly instalments");
      } finally {
        if (active) setLoadingPage(null);
      }
    };

    loadPage();
    return () => {
      active = false;
      // A collapsed row remains mounted in the history table. If its request
      // is still pending, clear the guard so a later re-expand can retry
      // instead of treating the abandoned request as active forever.
      setLoadingPage((current) => (current === page ? null : current));
    };
  // Do not include loadingPage here: setting it to the current page is part
  // of this request's lifecycle, and including it would run the cleanup,
  // deactivate the request, and leave the row loading forever before the
  // response can populate pages.
  }, [expanded, historyId, membershipSource, page, pages]);

  if (!expanded) return null;

  const loaded = pages[page];
  const items = loaded?.items || [];
  const ledgerUnavailable = loaded?.ledgerState === "missing";
  const missingAccounting = loaded
    && (loaded.hasAccountingProvider === false
      || items.some((item) => item.status === "missing_accounting"));

  return (
    <tr id={`row-member-instalments-${historyId}`} data-testid={`row-member-instalments-${historyId}`}>
      <td colSpan={9} className="p-0">
        <div className="bg-muted/20 border-t border-b px-4 py-3 space-y-3">
          <div className="flex items-start gap-2">
            <FileText className="w-4 h-4 mt-0.5 text-muted-foreground shrink-0" />
            <div>
              <p className="text-sm font-medium">Monthly instalment history</p>
              <p className="text-xs text-muted-foreground">
                The membership status above describes the whole term. Partial means the term is not fully paid; it does not mean a collected monthly instalment failed.
              </p>
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 text-sm text-destructive" role="alert" data-testid={`error-member-instalments-${historyId}`}>
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
              <Button size="sm" variant="outline" onClick={() => setPages((previous) => ({ ...previous, [page]: undefined }))}>
                Try again
              </Button>
            </div>
          )}

          {loadingPage === page && !loaded && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid={`loading-member-instalments-${historyId}`}>
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading monthly instalments…
            </div>
          )}

          {loaded && ledgerUnavailable && (
            <p className="text-xs text-amber-700 dark:text-amber-400" data-testid={`text-member-instalments-ledger-unavailable-${historyId}`}>
              The monthly accounting ledger is currently unavailable. This is different from a membership with no collections.
            </p>
          )}

          {loaded && missingAccounting && !ledgerUnavailable && (
            <p className="text-xs text-amber-700 dark:text-amber-400" data-testid={`text-member-instalments-missing-accounting-${historyId}`}>
              No accounting provider is connected for this membership. Collections can still be shown, but no accounting invoice is expected.
            </p>
          )}

          {loaded?.invoicingMode === "annual" && (
            <p className="text-xs text-muted-foreground" data-testid={`text-member-instalments-annual-mode-${historyId}`}>
              Annual accounting mode is active: successful monthly collections are applied to the annual invoice, so a separate invoice for each instalment is not expected.
            </p>
          )}

          {loaded && items.length === 0 && !ledgerUnavailable && (
            <p className="text-sm text-muted-foreground" data-testid={`text-member-instalments-empty-${historyId}`}>
              {loaded.invoicingMode === "annual"
                ? "No separate monthly accounting invoices are recorded under annual invoicing."
                : "No monthly collections recorded for this membership yet."}
            </p>
          )}

          {items.length > 0 && (
            <div className="border rounded-md overflow-auto">
              <table className="w-full text-sm" data-testid={`table-member-instalments-${historyId}`}>
                <thead>
                  <tr className="border-b bg-background/60">
                    <th className="text-left p-2 font-medium">Collection</th>
                    <th className="text-right p-2 font-medium">Amount</th>
                    <th className="text-left p-2 font-medium">Accounting</th>
                    <th className="text-left p-2 font-medium">Invoice</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, index) => {
                    const itemKey = item.id || item.paymentRef || `${page}-${index}`;
                    const collectionLabel = collectionStatusLabel(item.collectionStatus);
                    const accountingLabel = instalmentStatusLabel(item.accountingStatus);
                    return (
                      <tr key={itemKey} className="border-b last:border-0" data-testid={`row-member-instalment-${itemKey}`}>
                        <td className="p-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span>{formatDate(item.date)}</span>
                            <span className="text-xs text-muted-foreground">Collection</span>
                            <Badge variant={STATUS_VARIANTS[item.collectionStatus] || "outline"} data-testid={`badge-member-instalment-collection-${itemKey}`}>
                              {collectionLabel}
                            </Badge>
                          </div>
                          {(item.collectionStatus === "collection_failed"
                            || item.accountingStatus === "failed"
                            || item.accountingStatus === "skipped"
                            || item.accountingStatus === "missing_accounting") && item.reason && (
                            <p className="text-xs text-muted-foreground mt-1">{item.reason}</p>
                          )}
                        </td>
                        <td className="p-2 text-right whitespace-nowrap">{formatAmount(item.amount, item.currency)}</td>
                        <td className="p-2">
                          <span className="text-xs text-muted-foreground mr-1">Accounting:</span>
                          <Badge
                            variant={STATUS_VARIANTS[item.accountingStatus] || "outline"}
                            data-testid={`badge-member-instalment-accounting-${itemKey}`}
                          >
                            {accountingLabel}
                          </Badge>
                        </td>
                        <td className="p-2">
                          <div className="flex items-center gap-2">
                            <span>{item.invoiceNumber || "—"}</span>
                            <InvoiceButtons
                              item={item}
                                source={membershipSource}
                              onViewInvoice={onViewInvoice}
                              onDownloadInvoice={onDownloadInvoice}
                              loadingInvoiceId={loadingInvoiceId}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {loaded && (loaded.hasPrevious || loaded.hasNext) && (
            <div className="flex items-center justify-between gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!loaded.hasPrevious || loadingPage === page}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                data-testid={`button-member-instalments-previous-${historyId}`}
              >
                Previous
              </Button>
              <span className="text-xs text-muted-foreground">
                Page {loaded.page}{loaded.total !== null ? ` of ${Math.max(1, Math.ceil(loaded.total / loaded.pageSize))}` : ""}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={!loaded.hasNext || loadingPage === page}
                onClick={() => setPage((current) => current + 1)}
                data-testid={`button-member-instalments-next-${historyId}`}
              >
                Next
              </Button>
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

export function MemberMembershipInstalmentsToggle({ record, expanded, onToggle }) {
  if (!isMonthlyMembershipRecord(record)) return null;
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="text-xs h-7 px-2"
      aria-expanded={expanded}
      aria-controls={`row-member-instalments-${record.id}`}
      onClick={onToggle}
      data-testid={`button-member-instalments-${record.id}`}
    >
      {expanded ? <ChevronDown className="w-3 h-3 mr-1" /> : <ChevronRight className="w-3 h-3 mr-1" />}
      Monthly instalments
    </Button>
  );
}