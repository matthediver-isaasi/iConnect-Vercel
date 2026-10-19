import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import HistoricalInvoices, {
  HistoricalInvoicesTable,
  formatHistoricalInvoiceAmount,
  formatHistoricalInvoiceDate,
  historicalInvoiceUrl,
  historicalStoredInvoiceFilename,
} from "./HistoricalInvoices.jsx";
import { fetchHistoricalInvoices, historicalInvoicesQueryKey } from "../../hooks/useHistoricalInvoices.js";
import { setActiveTenantId } from "../../api/base44Client.js";

const record = {
  id: "record-1", invoice_number: "INV-104", invoice_date: "2021-06-09",
  amount_minor: 1304, currency: null, description: "Annual subscription",
  record_kind: "credit", status: null, can_download: true,
};

test("stored dates, absent currency, kinds and status are not inferred", () => {
  assert.equal(formatHistoricalInvoiceDate(record.invoice_date), "09/06/2021");
  assert.equal(formatHistoricalInvoiceDate("2021-02-30"), "Unknown");
  assert.equal(formatHistoricalInvoiceDate(null), "Unknown");
  assert.equal(formatHistoricalInvoiceAmount(1304, null), "13.04 (currency not supplied)");
  assert.equal(formatHistoricalInvoiceAmount(1304, "GBP"), "£13.04");
  const html = renderToStaticMarkup(<HistoricalInvoicesTable records={[record]} canAccessInvoices request={() => { throw new Error("No request during render"); }} />);
  for (const text of ["Historical", "09/06/2021", "Annual subscription", "INV-104", "Credit", "Unknown status", "currency not supplied"]) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /£|xero\.com/);
});

test("PDF controls require both list permission and record availability", () => {
  const render = (permission, downloadable) => renderToStaticMarkup(
    <HistoricalInvoicesTable records={[{ ...record, can_download: downloadable }]} canAccessInvoices={permission} />,
  );
  assert.match(render(true, true), /View invoice INV-104/);
  assert.match(render(false, true), /Invoice access denied/);
  assert.doesNotMatch(render(false, true), /View invoice|Download invoice/);
  assert.match(render(true, false), /Document unavailable/);
  assert.doesNotMatch(render(true, false), /View invoice|Download invoice/);
  assert.doesNotMatch(render(true, undefined), /View invoice|Download invoice/);
});
test("verified Xero payment observation is separate from imported status and shows stale checks", () => {
  const html = renderToStaticMarkup(<HistoricalInvoicesTable records={[{
    ...record, record_kind: "invoice", status: "Unpaid in workbook",
    accounting_payment_status: "paid", accounting_status: "PAID",
    accounting_status_checked_at: "2026-01-02T12:00:00Z",
    accounting_status_refresh_pending: true,
  }]} canAccessInvoices={false} />);
  assert.match(html, /paid/);
  assert.match(html, /Xero checked 02\/01\/2026/);
  assert.match(html, /refresh pending/);
  assert.match(html, /Imported status: Unpaid in workbook/);
});

test("PDF URL uses persisted record id and explicit inline flag; filename is sanitized", () => {
  assert.equal(historicalInvoiceUrl("record-1", true), "/api/membership/historical-invoice?recordId=record-1&inline=true");
  assert.equal(historicalInvoiceUrl("record-1"), "/api/membership/historical-invoice?recordId=record-1&inline=false");
  assert.equal(historicalStoredInvoiceFilename(null, { ...record, invoice_number: "INV/104" }), "historical-invoice-INV-104.pdf");
  assert.equal(historicalStoredInvoiceFilename("attachment; filename*=UTF-8''June%20invoice.pdf", record), "June invoice.pdf");
  assert.equal(historicalStoredInvoiceFilename('attachment; filename="../../invoice"', record), "..-..-invoice.pdf");
});

test("list requests are paginated, authenticated, tenant scoped and validate errors", async () => {
  const calls = [];
  const payload = { records: [record], total: 51, canAccessInvoices: true };
  const result = await fetchHistoricalInvoices({
    memberId: "member-1", page: 1, tenantId: "tenant-1",
    request: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => payload }; },
  });
  assert.equal(result, payload);
  assert.equal(calls[0].url, "/api/membership/historical-invoices?memberId=member-1&page=1");
  assert.equal(calls[0].options.credentials, "include");
  assert.equal(calls[0].options.headers["X-Tenant-Id"], "tenant-1");
  assert.notDeepEqual(historicalInvoicesQueryKey("one", "member-1"), historicalInvoicesQueryKey("two", "member-1"));
  await assert.rejects(fetchHistoricalInvoices({ memberId: "member-1", request: async () => ({ ok: false, json: async () => ({ error: "Access denied" }) }) }), /Access denied/);
  await assert.rejects(fetchHistoricalInvoices({ memberId: "member-1", request: async () => ({ ok: true, json: async () => ({ records: [] }) }) }), /Invalid historical invoices response/);
});

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/history" });
Object.assign(globalThis, {
  React, window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
  Node: dom.window.Node, MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { act } = React;
const settle = () => new Promise(resolve => setTimeout(resolve, 25));

test("pagination uses 50-record pages, tenant switches reset the page, empty and errors are visible", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const calls = [];
  let failure = false;
  const request = async (url, options) => {
    calls.push({ url, options });
    return { ok: !failure, json: async () => failure ? { error: "Archive unavailable" } : {
      records: url.includes("page=1") ? [] : [record], total: 51, canAccessInvoices: true,
    } };
  };
  const render = memberId => root.render(<QueryClientProvider client={client}><HistoricalInvoices memberId={memberId} activeTenantId="tenant-fallback" request={request} /></QueryClientProvider>);
  try {
    await act(async () => { render("member-1"); await settle(); });
    await act(async () => { await settle(); });
    assert.match(container.textContent, /Page 1 of 2/);
    const next = [...container.querySelectorAll("button")].find(button => button.textContent === "Next");
    await act(async () => { next.click(); await settle(); });
    await act(async () => { await settle(); });
    assert.match(container.textContent, /No historical invoices found on this page/);
    assert.ok(calls.some(call => call.url.includes("page=1")));
    await act(async () => { setActiveTenantId("tenant-other"); await settle(); });
    await act(async () => { await settle(); });
    assert.match(container.textContent, /Page 1 of 2/);
    assert.equal(calls.at(-1).options.headers["X-Tenant-Id"], "tenant-other");
    failure = true;
    await act(async () => { render("member-error"); await settle(); });
    await act(async () => { await settle(); });
    assert.match(container.querySelector('[role="alert"]').textContent, /Archive unavailable/);
    failure = false;
    await act(async () => { [...container.querySelectorAll("button")].find(button => button.textContent === "Retry").click(); await settle(); });
    await act(async () => { await settle(); });
    assert.match(container.textContent, /INV-104/);
  } finally {
    await act(async () => { root.unmount(); setActiveTenantId(null); });
    client.clear();
    container.remove();
  }
});

test("authenticated PDF errors are displayed inline and can be retried without list requests", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    return { ok: false, json: async () => ({ error: "Document access denied" }) };
  };
  try {
    await act(async () => root.render(<HistoricalInvoicesTable records={[record]} canAccessInvoices tenantId="tenant-1" request={request} />));
    await act(async () => { container.querySelector('[aria-label="View invoice INV-104"]').click(); await settle(); });
    assert.match(container.querySelector('[role="alert"]').textContent, /Document access denied/);
    assert.equal(calls[0].options.credentials, "include");
    assert.equal(calls[0].options.headers["X-Tenant-Id"], "tenant-1");
    assert.equal(calls[0].url, historicalInvoiceUrl(record.id, true));
    await act(async () => { [...container.querySelectorAll("button")].find(button => button.textContent === "Retry").click(); await settle(); });
    assert.equal(calls.length, 2);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("downloads use authenticated PDF blobs and sanitized filenames, then revoke object URLs", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const originalClick = dom.window.HTMLAnchorElement.prototype.click;
  const downloads = [];
  const revoked = [];
  URL.createObjectURL = () => "blob:historical-invoice-test";
  URL.revokeObjectURL = url => revoked.push(url);
  dom.window.HTMLAnchorElement.prototype.click = function () {
    downloads.push({ href: this.href, filename: this.download });
  };
  const request = async (url, options) => {
    assert.equal(url, historicalInvoiceUrl(record.id, false));
    assert.equal(options.credentials, "include");
    return {
      ok: true, blob: async () => new Blob(["%PDF-1.7"], { type: "application/pdf" }),
      headers: new Headers({ "content-disposition": 'attachment; filename="INV/104.pdf"' }),
    };
  };
  try {
    await act(async () => root.render(<HistoricalInvoicesTable records={[record]} canAccessInvoices request={request} />));
    await act(async () => { container.querySelector('[aria-label="Download invoice INV-104"]').click(); await settle(); });
    assert.deepEqual(downloads, [{ href: "blob:historical-invoice-test", filename: "INV-104.pdf" }]);
    assert.deepEqual(revoked, ["blob:historical-invoice-test"]);
    assert.equal(document.querySelector('a[download]'), null);
  } finally {
    await act(async () => root.unmount());
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    dom.window.HTMLAnchorElement.prototype.click = originalClick;
    container.remove();
  }
});

test("unmount aborts a pending PDF request without constructing a blob URL", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  let signal;
  const request = async (_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
      const error = new Error("Aborted");
      error.name = "AbortError";
      reject(error);
    }));
  };
  await act(async () => root.render(<HistoricalInvoicesTable records={[record]} canAccessInvoices request={request} />));
  await act(async () => { container.querySelector('[aria-label="View invoice INV-104"]').click(); });
  assert.equal(signal.aborted, false);
  await act(async () => root.unmount());
  assert.equal(signal.aborted, true);
});

test("historical-only members retain their History category and both Activity implementations show the archive", () => {
  const history = readFileSync(new URL("../../pages/History.jsx", import.meta.url), "utf8");
  assert.match(history, /count: membershipHistory\.length \+ \(historicalInvoicesQuery\.data\?\.total/);
  assert.equal((history.match(/<HistoricalInvoices\s/g) || []).length, 2);
  for (const path of ["../MemberDetailView.jsx", "../../pages/MemberDetail.jsx"]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(source, /<TabsContent value="activity"[\s\S]*?<HistoricalInvoices/);
  }
});
