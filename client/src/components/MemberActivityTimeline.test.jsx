import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { JSDOM } from "jsdom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import MemberActivityTimeline from "./MemberActivityTimeline.jsx";
import { HistoricalInvoicesTable } from "./membership/HistoricalInvoices.jsx";
import { fetchAllHistoricalInvoices, fetchHistoricalInvoices, historicalInvoicesQueryKey } from "../hooks/useHistoricalInvoices.js";
import { bookingActivityDate } from "../lib/memberActivityDates.js";
import { activityInvoicesQueryKey, fetchAllHistoricalInvoices as fetchAllActivityInvoices, mergeHistoricalInvoiceActivity } from "./membership/activityInvoices.js";
import { setActiveTenantId } from "../api/base44Client.js";

const invoice = {
  id: "renewal", invoice_number: "REN-231", invoice_date: "2021-07-12",
  created_at: "2026-08-01", description: "Historical membership renewal",
  record_kind: "invoice", status: "Paid", amount_minor: 12340, currency: "GBP", can_download: true,
};

const membershipInvoice = {
  ...invoice, source: "membership", id: "current", invoice_number: "MEM-482",
  invoice_date: null, activity_date: "2024-03-18", date_label: "Payment date",
  description: "Annual membership", status: "paid",
};

test("membership dates interleave with archive dates and colliding IDs remain distinct", () => {
  const rows = mergeHistoricalInvoiceActivity([{ key: "event", date: "2023-05-12" }], [
    { ...invoice, id: "current" },
    membershipInvoice,
    { ...membershipInvoice, id: "start", activity_date: "2022-09-03", date_label: "Membership starts" },
    { ...membershipInvoice, id: "unknown", activity_date: null, invoice_date: "2099-01-01" },
  ]);
  assert.deepEqual(rows.map(row => row.key), [
    "membership-invoice-current", "event", "membership-invoice-start", "historical-invoice-current", "membership-invoice-unknown",
  ]);
  assert.equal(rows.at(-1).date, null);
});

test("Activity opts into membership on every page while historical-only reads and keys stay unchanged", async () => {
  const calls = [];
  const first = Array.from({ length: 50 }, (_, i) => ({ ...invoice, id: `old-${i}` }));
  const request = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({
      records: new URL(url, "http://localhost").searchParams.get("page") === "0"
        ? first : [{ ...membershipInvoice, id: "old-0" }],
      total: 51, canAccessInvoices: true,
    }) };
  };
  const signal = new AbortController().signal;
  const result = await fetchAllActivityInvoices({ memberId: "member", tenantId: "tenant", signal, request });
  assert.equal(result.records.length, 51);
  assert.deepEqual(calls.map(({ url }) => new URL(url, "http://localhost").searchParams.get("includeMembership")), ["true", "true"]);
  for (const { options } of calls) {
    assert.equal(options.credentials, "include");
    assert.equal(options.headers["X-Tenant-Id"], "tenant");
    assert.equal(options.signal, signal);
  }
  await fetchHistoricalInvoices({ memberId: "member", request });
  assert.equal(new URL(calls.at(-1).url, "http://localhost").searchParams.has("includeMembership"), false);
  assert.notDeepEqual(activityInvoicesQueryKey("tenant", "member"), historicalInvoicesQueryKey("tenant", "member", "all"));
});

test("membership rows label the actual date and recorded status without archive provenance", () => {
  for (const record of [
    membershipInvoice,
    { ...membershipInvoice, activity_date: "2024-02-01", date_label: "Membership starts" },
    { ...membershipInvoice, activity_date: null, date_label: "Date unavailable" },
  ]) {
    const html = renderToStaticMarkup(<HistoricalInvoicesTable activity records={[{
      ...record, accounting_status_checked_at: "2025-01-02", accounting_payment_status: "WRONG",
    }]} canAccessInvoices />);
    assert.match(html, /Membership/);
    assert.match(html, new RegExp(record.date_label));
    assert.match(html, /Recorded payment status/);
    assert.match(html, />paid</);
    assert.doesNotMatch(html, /Historical|Imported|Xero|WRONG|Invoice date|Unknown/);
  }
});

test("event starts, not booking creation or invoice import dates, determine interleaving", () => {
  const activity = [
    { key: "simple", date: bookingActivityDate({ start_date: "2021-08-14" }, { created_date: "2020-01-02" }) },
    { key: "complex", date: bookingActivityDate({ start_date: "2021-06-11" }, { created_at: "2026-02-03" }) },
    { key: "checkin", date: "2021-07-13T10:00:00Z" },
    { key: "group", date: "2021-07-11" },
  ];
  assert.deepEqual(mergeHistoricalInvoiceActivity(activity, [invoice]).map(item => item.key),
    ["simple", "checkin", "historical-invoice-renewal", "group", "complex"]);
});

test("missing/invalid starts fall back to booking timestamps; invoices never use import timestamps", () => {
  assert.equal(bookingActivityDate(null, { created_date: "2020-04-05" }), "2020-04-05");
  assert.equal(bookingActivityDate({ start_date: "invalid" }, { created_at: "2020-04-06" }), "2020-04-06");
  assert.equal(bookingActivityDate({ start_date: "2021-02-30" }, { created_date: "bad", created_at: "2020-04-07" }), "2020-04-07");
  assert.equal(bookingActivityDate(null, {}), null);
  const unknowns = [
    { ...invoice, id: "z", invoice_date: "invalid" },
    { ...invoice, id: "a", invoice_date: null },
    { ...invoice, id: "b", invoice_date: "2021-02-30" },
  ];
  const result = mergeHistoricalInvoiceActivity([{ key: "dated", date: "1965-02-03" }], unknowns);
  assert.deepEqual(result.map(item => item.key), ["dated", "historical-invoice-a", "historical-invoice-b", "historical-invoice-z"]);
  assert.ok(result.slice(1).every(item => item.date === null));
  assert.deepEqual(mergeHistoricalInvoiceActivity([], unknowns.reverse()), result.slice(1));
  assert.deepEqual(mergeHistoricalInvoiceActivity([{ key: "z", date: "2021-07-12" }, { key: "a", date: "2021-07-12" }], [])
    .map(item => item.key), ["a", "z"]);
});

test("full archive reads include page 2, preserve auth, and fail closed on incomplete/error pages", async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const first = Array.from({ length: 50 }, (_, i) => ({ ...invoice, id: `old-${i}` }));
  const request = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({
      records: url.endsWith("page=0") ? first : [{ ...invoice, id: "newest", invoice_date: "2025-01-01" }],
      total: 51, canAccessInvoices: !url.endsWith("page=1"),
    }) };
  };
  const result = await fetchAllHistoricalInvoices({ memberId: "m", tenantId: "t", signal, request });
  assert.equal(result.records.length, 51);
  assert.equal(mergeHistoricalInvoiceActivity([], result.records)[0].id, "newest");
  assert.equal(result.canAccessInvoices, false);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.options.signal, signal);
    assert.equal(call.options.credentials, "include");
    assert.equal(call.options.headers["X-Tenant-Id"], "t");
  }
  const brokenRequest = second => async url => ({
    ok: !url.endsWith("page=1") || second !== "error",
    json: async () => url.endsWith("page=0") ? { records: first, total: 51, canAccessInvoices: true }
      : second === "error" ? { error: "Archive offline" }
        : { records: [], total: second === "changed" ? 52 : 51, canAccessInvoices: true },
  });
  await assert.rejects(fetchAllHistoricalInvoices({ memberId: "m", request: brokenRequest("error") }), /Archive offline/);
  await assert.rejects(fetchAllHistoricalInvoices({ memberId: "m", request: brokenRequest("empty") }), /fully loaded/);
  await assert.rejects(fetchAllHistoricalInvoices({ memberId: "m", request: brokenRequest("changed") }), /changed while loading/);
});

test("timeline invoice rendering retains metadata and both authorization gates without a table", () => {
  for (const [canAccessInvoices, canDownload] of [[true, true], [false, true], [true, false], [true, undefined]]) {
    const html = renderToStaticMarkup(<HistoricalInvoicesTable activity records={[{ ...invoice, can_download: canDownload }]} canAccessInvoices={canAccessInvoices} />);
    assert.doesNotMatch(html, /<table|<tr|<td/);
    assert.match(html, /Historical membership renewal/);
    assert.match(html, /12\/07\/2021/);
    assert.match(html, /£123.40/);
    if (canAccessInvoices && canDownload === true) {
      assert.match(html, /View invoice REN-231/);
      assert.match(html, /Download invoice REN-231/);
    } else {
      assert.doesNotMatch(html, /aria-label="(?:View|Download) invoice/);
      assert.match(html, canAccessInvoices ? /Document unavailable/ : /Invoice access denied/);
    }
  }
});

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/activity" });
Object.assign(globalThis, {
  React, window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
  Node: dom.window.Node, MutationObserver: dom.window.MutationObserver,
  CustomEvent: dom.window.CustomEvent, NodeFilter: dom.window.NodeFilter,
  HTMLInputElement: dom.window.HTMLInputElement,
  getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { act } = React;
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

function seededClient(tenant = "tenant-1") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["public-system-settings-date-format"], []);
  client.setQueryData(["related-opportunity-activity", "member", "member-1"], { opportunities: [], activity: [] });
  client.setQueryData(["member-detail-bookings", "member-1", undefined, tenant], [
    { id: "booking", member_id: "member-1", event_id: "event", created_date: "2026-03-01", checked_in_at: "2022-07-01" },
  ]);
  client.setQueryData(["member-detail-complex-bookings", "member-1", undefined, tenant], [
    { id: "complex-booking", member_id: "member-1", event_id: "complex-event", created_at: "2026-02-01" },
  ]);
  client.setQueryData(["events-for-member-detail", tenant], [{ id: "event", title: "Summer workshop", start_date: "2022-06-01" }]);
  client.setQueryData(["complex-events-for-member-detail", ["complex-event"], tenant], [{ id: "complex-event", title: "Spring conference", start_date: "2020-04-01" }]);
  client.setQueryData(["member-detail-complex-checkins", ["complex-booking"], tenant], []);
  client.setQueryData(["member-detail-group-activity", "member-1", tenant], [{ id: "joined", action: "joined", group_name: "Fellows", created_at: "2021-04-01" }]);
  return client;
}

const rowIds = container => [...container.querySelectorAll('[data-testid^="row-"]')].map(row => row.dataset.testid);

test("mounted timeline waits for ALL pages, globally sorts, paginates without loss and retries later-page errors", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = seededClient();
  let resolvePage;
  let fail = true;
  const first = Array.from({ length: 50 }, (_, i) => ({ ...invoice, id: `invoice-${String(i).padStart(2, "0")}` }));
  first[49] = { ...first[49], invoice_date: null };
  const request = async url => {
    if (new URL(url, "http://localhost").searchParams.get("page") === "1") {
      await new Promise(resolve => { resolvePage = resolve; });
      if (fail) return { ok: false, json: async () => ({ error: "Second page unavailable" }) };
    }
    return { ok: true, json: async () => ({
      records: new URL(url, "http://localhost").searchParams.get("page") === "0" ? first : [{ ...membershipInvoice, id: "newest" }],
      total: 51, canAccessInvoices: true,
    }) };
  };
  try {
    await act(async () => {
      root.render(<MemoryRouter><QueryClientProvider client={client}><MemberActivityTimeline memberId="member-1" activeTenantId="tenant-1" request={request} /></QueryClientProvider></MemoryRouter>);
      await settle();
    });
    await act(async () => { await settle(); });
    assert.ok(container.querySelector('[aria-label="Loading activity"]'));
    assert.deepEqual(rowIds(container), []);
    await act(async () => { resolvePage(); await settle(); });
    await act(async () => { await settle(); });
    assert.match(container.querySelector('[role="alert"]').textContent, /Second page unavailable/);
    assert.deepEqual(rowIds(container), []);
    fail = false;
    await act(async () => { [...container.querySelectorAll("button")].find(button => button.textContent === "Retry").click(); await settle(); });
    await act(async () => { resolvePage(); await settle(); });
    await act(async () => { await settle(); });
    assert.deepEqual(rowIds(container).slice(0, 4), [
      "row-membership-invoice-newest", "row-checkin-booking", "row-booking-simple-booking", "row-historical-invoice-invoice-00",
    ]);
    assert.equal(rowIds(container).length, 50);
    assert.match(container.textContent, /Page 1 of 2 · 55 activities/);
    assert.match(container.textContent, /not evidence of current membership entitlement/);
    assert.equal(container.querySelector("table"), null);
    assert.match(container.querySelector('[data-testid="row-membership-invoice-newest"]').textContent, /Payment date: 18\/03\/2024/);
    const pageOne = rowIds(container);
    await act(async () => { [...container.querySelectorAll("button")].find(button => button.textContent === "Next").click(); });
    const pageTwo = rowIds(container);
    assert.equal(new Set([...pageOne, ...pageTwo]).size, 55);
    assert.deepEqual(pageTwo.slice(-3), ["row-group-activity-joined", "row-booking-complex-complex-booking", "row-historical-invoice-invoice-49"]);
    assert.match(container.textContent, /Unknown/);
    await act(async () => { [...container.querySelectorAll("button")].find(button => button.textContent === "Previous").click(); });
    assert.deepEqual(rowIds(container), pageOne);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  }
});

test("member/tenant changes reset client pagination and prevent old invoice actions", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const client = seededClient();
  const other = seededClient("tenant-2");
  for (const query of other.getQueryCache().getAll()) client.setQueryData(query.queryKey, query.state.data);
  other.clear();
  client.setQueryData(activityInvoicesQueryKey("tenant-1", "member-1"), {
    records: Array.from({ length: 51 }, (_, i) => ({ ...invoice, id: `first-${i}` })), total: 51, canAccessInvoices: true,
  });
  client.setQueryData(activityInvoicesQueryKey("tenant-2", "member-1"), {
    records: [{ ...invoice, id: "second", invoice_number: "SECOND" }], total: 1, canAccessInvoices: false,
  });
  try {
    await act(async () => root.render(<MemoryRouter><QueryClientProvider client={client}><MemberActivityTimeline memberId="member-1" activeTenantId="tenant-1" /></QueryClientProvider></MemoryRouter>));
    await act(async () => { [...container.querySelectorAll("button")].find(button => button.textContent === "Next").click(); });
    assert.match(container.textContent, /Page 2 of 2/);
    await act(async () => { setActiveTenantId("tenant-2"); await settle(); });
    assert.match(container.textContent, /SECOND/);
    assert.doesNotMatch(container.textContent, /REN-231|Page 2/);
    assert.match(container.textContent, /Invoice access denied/);
    assert.equal(container.querySelector('[aria-label="View invoice SECOND"]'), null);
  } finally {
    await act(async () => { root.unmount(); setActiveTenantId(null); });
    client.clear();
  }
});

test("timeline PDF errors retry with tenant credentials and downloads clean up blob URLs", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const originalClick = dom.window.HTMLAnchorElement.prototype.click;
  const revoked = [];
  const downloads = [];
  const calls = [];
  let fail = true;
  URL.createObjectURL = () => "blob:activity-invoice";
  URL.revokeObjectURL = url => revoked.push(url);
  dom.window.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
  const request = async (url, options) => {
    calls.push({ url, options });
    return fail ? { ok: false, json: async () => ({ error: "Invoice permission expired" }) } : {
      ok: true, blob: async () => new Blob(["%PDF"], { type: "application/pdf" }), headers: new Headers(),
    };
  };
  try {
    await act(async () => root.render(<HistoricalInvoicesTable activity records={[invoice]} canAccessInvoices tenantId="tenant-1" request={request} />));
    await act(async () => { container.querySelector('[aria-label="Download invoice REN-231"]').click(); await settle(); });
    assert.match(container.querySelector('[role="alert"]').textContent, /Invoice permission expired/);
    fail = false;
    await act(async () => { [...container.querySelectorAll("button")].find(button => button.textContent === "Retry").click(); await settle(); });
    assert.deepEqual(downloads, ["historical-invoice-REN-231.pdf"]);
    assert.deepEqual(revoked, ["blob:activity-invoice"]);
    assert.equal(container.querySelector('[role="alert"]'), null);
    assert.equal(calls.length, 2);
    for (const { url, options } of calls) {
      assert.equal(url, "/api/membership/historical-invoice?recordId=renewal&inline=false");
      assert.equal(options.credentials, "include");
      assert.equal(options.headers["X-Tenant-Id"], "tenant-1");
    }
  } finally {
    await act(async () => root.unmount());
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    dom.window.HTMLAnchorElement.prototype.click = originalClick;
    container.remove();
  }
});

test("timeline View uses authenticated inline requests and surfaces permission errors", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let calls = 0;
  const request = async (url, options) => {
    calls += 1;
    assert.equal(url, "/api/membership/historical-invoice?recordId=renewal&inline=true");
    assert.equal(options.credentials, "include");
    assert.equal(options.headers["X-Tenant-Id"], "tenant-preview");
    return { ok: false, json: async () => ({ error: "Invoice access denied by server" }) };
  };
  try {
    await act(async () => root.render(<HistoricalInvoicesTable activity records={[invoice]} canAccessInvoices tenantId="tenant-preview" request={request} />));
    await act(async () => { container.querySelector('[aria-label="View invoice REN-231"]').click(); await settle(); });
    assert.match(container.querySelector('[role="alert"]').textContent, /Invoice access denied by server/);
    assert.equal(calls, 1);
    assert.equal(document.querySelector('[role="dialog"] iframe'), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("disabled Activity does not fetch archive pages and empty archives retain the composed empty state", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const client = seededClient();
  let calls = 0;
  const request = async () => { calls += 1; throw new Error("Unexpected archive request"); };
  try {
    await act(async () => root.render(<MemoryRouter><QueryClientProvider client={client}>
      <MemberActivityTimeline memberId="member-1" activeTenantId="tenant-1" enabled={false} request={request} />
    </QueryClientProvider></MemoryRouter>));
    assert.equal(calls, 0);
    client.setQueryData(["member-detail-bookings", "member-1", undefined, "tenant-1"], []);
    client.setQueryData(["member-detail-complex-bookings", "member-1", undefined, "tenant-1"], []);
    client.setQueryData(["member-detail-group-activity", "member-1", "tenant-1"], []);
    client.setQueryData(activityInvoicesQueryKey("tenant-1", "member-1"), { records: [], total: 0, canAccessInvoices: false });
    await act(async () => root.render(<MemoryRouter><QueryClientProvider client={client}>
      <MemberActivityTimeline memberId="member-1" activeTenantId="tenant-1" request={request} />
    </QueryClientProvider></MemoryRouter>));
    assert.equal(container.querySelector('[data-testid="text-no-activity"]').textContent, "No activity found");
    assert.equal(calls, 0);
  } finally {
    await act(async () => root.unmount());
    client.clear();
  }
});

test("mounted membership actions use personal membership routes, tenant auth and both permission gates", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    return { ok: false, json: async () => ({ error: "Permission changed" }) };
  };
  try {
    await act(async () => root.render(<HistoricalInvoicesTable activity records={[membershipInvoice]} canAccessInvoices tenantId="tenant-current" request={request} />));
    for (const action of ["View", "Download"]) {
      await act(async () => { container.querySelector(`[aria-label="${action} invoice MEM-482"]`).click(); await settle(); });
      assert.match(container.querySelector('[role="alert"]').textContent, /Permission changed/);
    }
    assert.deepEqual(calls.map(call => call.url), [
      "/api/membership-invoice/current?source=personal&inline=true",
      "/api/membership-invoice/current?source=personal&inline=false",
    ]);
    for (const { options } of calls) {
      assert.equal(options.credentials, "include");
      assert.equal(options.headers["X-Tenant-Id"], "tenant-current");
    }
    for (const [access, downloadable] of [[false, true], [true, false], [true, undefined]]) {
      await act(async () => root.render(<HistoricalInvoicesTable activity records={[{ ...membershipInvoice, can_download: downloadable }]} canAccessInvoices={access} request={request} />));
      assert.equal(container.querySelector('[aria-label="View invoice MEM-482"]'), null);
      assert.equal(container.querySelector('[aria-label="Download invoice MEM-482"]'), null);
    }
    assert.equal(calls.length, 2);
  } finally {
    await act(async () => root.unmount());
  }
});
