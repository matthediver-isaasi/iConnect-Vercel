import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import fs from "node:fs";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import loadConfig from "tailwindcss/loadConfig.js";

// Mount real pages without a server, tenant, provider or live network.
const stubs = {
  "@/api/base44Client": `export const base44 = {
    entities: new Proxy({}, { get: (_, name) => ({
      list: async () => structuredClone(window.fixture.entities[name] || []),
      filter: async () => structuredClone(window.fixture.entities[name] || []),
      update: async () => { throw new Error("Unexpected mutation"); },
    }) }),
    functions: { invoke: async () => { throw new Error("Unexpected function"); } },
  };`,
  "@/api/entities": `export const Form = { list: async () => [], filter: async () => [] };
    export const FormSubmission = Form;`,
  "@/hooks/useMemberAccess": `export const useMemberAccess = () => ({
    memberInfo: { id: "member", tenant_id: "tenant", email: "member@example.invalid", page_tours_seen: { Bookings: true, History: true } },
    organizationInfo: null, memberRole: { show_tours: false },
    isFeatureExcluded: () => false, isAccessReady: true,
  });`,
  "@/contexts/LayoutContext": `export const useLayoutContext = () => ({ hasBanner: false });`,
};
const nullComponents = /(?:PageTour|TourButton|TransferTicketDialog|PublicInvoicePoRegistrations|BookingCreditRefresh|AttendeeCpdCertificateDialog|CpdPointsReplayDialog|HistoricalDdPayments|MemberMembershipInstalments|MembershipPricingDisplay)(?:\.jsx)?$/;
let script;
let css;

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { MemoryRouter } from "react-router-dom";
        import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
        import { TooltipProvider } from "./client/src/components/ui/tooltip.jsx";
        import Bookings from "./client/src/pages/Bookings.jsx";
        import History from "./client/src/pages/History.jsx";
        import Report from "./client/src/pages/EventRegistrationReport.jsx";
        const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
        window.refreshFixture = () => client.invalidateQueries();
        window.fetch = async (url, options = {}) => {
          window.fixture.calls.push(String(url));
          if (options.method && options.method !== "GET") throw new Error("Blocked write");
          if (String(url).startsWith("/api/booking-invoice/")) return { ok: true, blob: async () => new Blob(["%PDF fixture"], { type: "application/pdf" }) };
          if (String(url).startsWith("/api/reports/event-registration-report")) return { ok: true, json: async () => structuredClone(window.fixture.report) };
          if (String(url) === "/api/complex-event-bookings") return { ok: true, json: async () => structuredClone(window.fixture.complex) };
          if (String(url) === "/api/membership/member-history") return { ok: true, json: async () => [] };
          if (String(url).startsWith("/api/admin/event-cpd-points-replay")) return { ok: true, json: async () => ({ replays: [] }) };
          if (String(url).includes("cancellation") || String(url).includes("transfer")) return { ok: true, json: async () => ({ requests: [] }) };
          throw new Error("Unexpected request: " + url);
        };
        const Page = window.fixture.page === "Bookings" ? Bookings : window.fixture.page === "History" ? History : Report;
        createRoot(document.getElementById("root")).render(<MemoryRouter><QueryClientProvider client={client}><TooltipProvider><Page /></TooltipProvider></QueryClientProvider></MemoryRouter>);
      `,
      loader: "jsx",
      resolveDir: process.cwd(),
    },
    bundle: true, write: false, jsx: "automatic",
    define: { "process.env.NODE_ENV": '"test"', "import.meta.env.DEV": "false" },
    plugins: [{
      name: "isolated-recovery-pages",
      setup(api) {
        api.onResolve({ filter: /.*/ }, args => {
          if (stubs[args.path]) return { path: args.path, namespace: "stub" };
          if (nullComponents.test(args.path)) return { path: "null-component", namespace: "stub" };
          if (!args.path.startsWith("@/")) return;
          const base = path.resolve("client/src", args.path.slice(2));
          const resolved = [base, ...[".jsx", ".js", ".mjs", ".ts", ".tsx"].map(ext => base + ext), path.join(base, "index.ts"), path.join(base, "index.js")]
            .find(file => fs.existsSync(file) && fs.statSync(file).isFile());
          return { path: resolved || base };
        });
        api.onLoad({ filter: /.*/, namespace: "stub" }, args => ({
          contents: stubs[args.path] || "export default function Null() { return null; } export const isMonthlyMembershipRecord = () => false;",
          loader: "jsx",
        }));
      },
    }],
  });
  script = result.outputFiles[0].text;
  css = (await postcss([tailwindcss({
    ...loadConfig(path.resolve("tailwind.config.ts")),
    content: ["client/src/pages/{Bookings,History,EventRegistrationReport}.jsx", "client/src/components/booking/EventInvoiceStatus.jsx", "client/src/components/ui/*.{jsx,tsx}"],
  })]).process(fs.readFileSync("client/src/index.css", "utf8"), { from: "client/src/index.css" })).css;
});

const booking = {
  id: "recovery-booking", member_id: "member", event_id: "event",
  is_one_off_event: true, event_name: "Recovery Workshop",
  booking_group_reference: "RECOVERY", booking_reference: "RECOVERY",
  total_cost: 50, ticket_price: 50, created_date: "2026-11-01T12:00:00Z",
  status: "confirmed", payment_method: "card", invoice_recovery_status: "retry",
  attendee_first_name: "Pat", attendee_last_name: "Delegate",
  invoice_recovery_next_attempt_at: "2026-12-01T12:00:00Z",
  xero_invoice_error: "DO_NOT_SHOW_RAW_PROVIDER_ERROR",
};

function group(record) {
  return {
    groupRef: "RECOVERY", bookingSource: "booking", isGroup: false,
    eventTitle: "Recovery Workshop", eventId: "event", attendeeCount: 1,
    attendees: [{ ...record, price_paid: 50, price_paid_status: "paid", ticket_class_name: "Standard" }],
    groupPayment: {
      totalCost: 50, ticketTotal: 50, totalAfterDiscount: 50, discount: 0,
      codeDiscount: 0, offerDiscount: 0, paymentMethod: record.payment_method,
      invoiceRecoveryStatus: record.invoice_recovery_status,
      invoiceRecoveryNextAttemptAt: record.invoice_recovery_next_attempt_at,
      accountingInvoiceId: record.accounting_invoice_id, accountingInvoiceNumber: record.accounting_invoice_number,
      status: record.status,
    },
  };
}

async function mount(page, name, record = booking, complex = false) {
  const escaped = [];
  await page.route("**/*", route => { escaped.push(route.request().url()); return route.abort(); });
  await page.setContent('<html><body><div id="root"></div></body></html>');
  await page.addStyleTag({ content: css });
  await page.evaluate(fixture => { window.fixture = fixture; }, {
    page: name, calls: [],
    entities: { Booking: complex ? [] : [record], Event: [{ id: "event", title: "Recovery Workshop", is_one_off: true }], SystemSettings: [] },
    complex: { bookings: complex ? [{ ...record, total_paid: 50, created_at: record.created_date }] : [], events: { event: { id: "event", title: "Recovery Workshop" } }, sessions: {} },
    report: { events: [], bookingGroups: [group(record)], organizations: {}, summary: {} },
  });
  await page.addScriptTag({ content: script });
  if (name === "Report") await page.getByTestId("button-generate-report").click();
  return escaped;
}

for (const name of ["Bookings", "History"]) {
  for (const complex of [false, true]) {
    test(`${name} ${complex ? "complex" : "standard"} recovery stays neutral then reveals PDFs despite settlement retry`, async ({ page }, testInfo) => {
      const escaped = await mount(page, name, booking, complex);
      const status = page.getByTestId(`invoice-status-${complex ? "complex:" : ""}RECOVERY`);
      await expect(status).toHaveText("Invoice awaited");
      await status.locator("[tabindex]").focus();
      await expect(page.getByRole("tooltip")).toContainText("No action is needed from you");
      await expect(page.locator("body")).not.toContainText("DO_NOT_SHOW_RAW_PROVIDER_ERROR");
      await expect(page.getByTestId(`button-view-invoice-${complex ? "complex:" : ""}RECOVERY`)).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`${name}-${complex ? "complex" : "standard"}-awaited.png`) });
      await page.evaluate(isComplex => {
        const rows = isComplex ? window.fixture.complex.bookings : window.fixture.entities.Booking;
        rows[0] = { ...rows[0], accounting_invoice_id: "linked-id", accounting_invoice_number: "INV-READY" };
        return window.refreshFixture();
      }, complex);
      await expect(status).toHaveCount(0);
      const download = page.getByTestId(`button-download-invoice-${complex ? "complex:" : ""}RECOVERY`);
      await expect(download).toBeVisible();
      await download.click();
      await expect.poll(() => page.evaluate(() => window.fixture.calls.filter(url => url.startsWith("/api/booking-invoice/")))).toEqual(["/api/booking-invoice/RECOVERY"]);
      expect(escaped).toEqual([]);
    });
  }
}

test("admin report shows next retry and explicit attention without raw provider diagnostics", async ({ page }, testInfo) => {
  const escaped = await mount(page, "Report");
  await expect(page.getByTestId("text-invoice-status-recovery-booking")).toContainText("Invoice awaited");
  await expect(page.getByTestId("text-invoice-status-recovery-booking")).toContainText("Next retry:");
  await page.evaluate(() => {
    window.fixture.report.bookingGroups[0].groupPayment.invoiceRecoveryStatus = "needs_review";
    return window.refreshFixture();
  });
  await expect(page.getByTestId("text-invoice-status-recovery-booking")).toHaveText("Needs attention");
  await page.getByTestId("text-invoice-status-recovery-booking").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("admin-needs-attention.png") });
  expect(escaped).toEqual([]);
});

for (const excluded of [
  { invoice_recovery_status: null }, { invoice_recovery_status: "not_applicable" },
  { payment_method: "public_invoice_po" }, { status: "cancelled" },
  { total_cost: 0, payment_method: "free" }, { total_cost: 50, training_fund_amount: 50 },
]) {
  test(`member excludes non-recovery booking ${JSON.stringify(excluded)}`, async ({ page }) => {
    await mount(page, "History", { ...booking, ...excluded });
    await expect(page.getByText("Recovery Workshop").first()).toBeVisible();
    await expect(page.getByText("Invoice awaited", { exact: true })).toHaveCount(0);
    await expect(page.locator('[data-testid^="button-view-invoice-"]')).toHaveCount(0);
  });
}