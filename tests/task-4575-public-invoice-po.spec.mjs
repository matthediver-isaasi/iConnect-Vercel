import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import fs from "node:fs";
import postcss from "postcss";
import tailwindcss from "tailwindcss";

/*
 * Isolated browser-component verification for task 4575. The fixture does not
 * use a tenant, credentials, database, Stripe, or accounting provider.
 */
const stubs = {
  "@/api/base44Client": `
    export const base44 = {
      entities: { Voucher: { list: async () => [] } },
      functions: { invoke: (...args) => window.__task4575.invoke(...args) },
    };
  `,
  "@/api/publicClient": `
    export const publicClient = { getSystemSetting: async () => null };
  `,
  "@/hooks/useBalancesRealtime": `
    export const useBalancesRealtime = () => ({ isConnected: false });
  `,
};

function resolveSource(base) {
  for (const candidate of [
    base, `${base}.jsx`, `${base}.js`, `${base}.mjs`, `${base}.ts`, `${base}.tsx`,
    path.join(base, "index.jsx"), path.join(base, "index.js"), path.join(base, "index.mjs"),
    path.join(base, "index.ts"), path.join(base, "index.tsx"),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return base;
}

function fixturePlugin() {
  return {
    name: "task-4575-fixtures",
    setup(buildApi) {
      buildApi.onResolve({ filter: /^@\// }, args => {
        if (stubs[args.path]) return { path: args.path, namespace: "task4575-stub" };
        return { path: resolveSource(path.resolve("client/src", args.path.slice(2))) };
      });
      buildApi.onResolve({ filter: /^@shared\// }, args => ({
        path: resolveSource(path.resolve("shared", args.path.slice("@shared/".length))),
      }));
      buildApi.onLoad({ filter: /.*/, namespace: "task4575-stub" }, args => ({
        contents: stubs[args.path],
        loader: "jsx",
        resolveDir: process.cwd(),
      }));
    },
  };
}

let script;
let css;

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
        import PaymentOptions from "./client/src/components/booking/PaymentOptions.jsx";
        import PublicInvoicePoRegistrations from "./client/src/components/events/PublicInvoicePoRegistrations.jsx";

        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const event = {
          id: "event-task4575",
          title: "Public PO Workshop",
          allow_public_invoice_po: window.__task4575.mode !== "checkout-disabled",
          donation_config: { enabled: false },
        };
        const attendee = {
          id: "attendee-task4575",
          isValid: true,
          first_name: "Delegate",
          last_name: "Different",
          email: "delegate@example.invalid",
        };
        function Checkout() {
          const complexEventApi = {
            submitBooking: async payload => {
              window.__task4575.bookingCalls.push(payload);
              return {
                success: true,
                booking_reference: "CEB-TASK4575",
                bookings: [{ id: "booking-task4575", status: "pending" }],
                payment_details: { payment_method: "public_invoice_po" },
              };
            },
          };
          return <QueryClientProvider client={queryClient}>
            <PaymentOptions
              totalCost={125}
              memberInfo={null}
              organizationInfo={null}
              attendees={[attendee]}
              numberOfLinks={0}
              event={event}
              registrationMode="self"
              isOneOffEvent={false}
              oneOffCostDetails={{ subtotal: 125, total: 125, freeTickets: 0, discount: 0 }}
              ticketPrice={125}
              selectedTicketClass={{ id: "ticket-public", name: "Public ticket", price: 125, visibility_mode: "members_and_public" }}
              isGuestCheckout={true}
              guestInfo={{ first_name: "Pat", last_name: "Purchaser", email: "pat.purchaser@example.invalid", organization: "Purchaser Org" }}
              isComplexEvent={true}
              complexEventApi={complexEventApi}
              renderAsCard={false}
            />
          </QueryClientProvider>;
        }

        const groups = [{
          eventId: event.id,
          eventTitle: event.title,
          groupRef: "PO-GROUP-1",
          isPublicInvoicePo: true,
          publicInvoicePurchaser: {
            first_name: "Pat", last_name: "Purchaser",
            email: "pat.purchaser@example.invalid",
            organization: "Purchaser Org",
          },
          groupPayment: { purchaseOrderNumber: "PO-4575" },
          attendees: [{
            id: "booking-task4575",
            attendee_first_name: "Delegate",
            attendee_last_name: "Different",
            attendee_email: "delegate@example.invalid",
            attendee_job_title: "Engineer",
            ticket_class_name: "Public ticket",
            ticket_price: 125,
            total_cost: 125,
            status: "pending",
            booking_reference: "CEB-TASK4575",
            created_at: "2026-03-10T10:00:00.000Z",
            purchase_order_number: "PO-4575",
            payment_method: "public_invoice_po",
            organization_id: "org-task4575",
            dietary_selections: ["Vegetarian"],
          }],
        }];
        function Report() {
          return <div className="space-y-4">
            <div data-testid="registrations-card" className="border p-4">Registrations</div>
            <PublicInvoicePoRegistrations
              groups={groups}
              allGroups={groups}
              organizations={{ "org-task4575": "Attendee Organisation" }}
              renderFormAnswers={(_group, email) => <div data-testid={"answers-" + email}>Emergency contact: Alex</div>}
            />
          </div>;
        }
        createRoot(document.getElementById("root")).render(
          window.__task4575.mode === "report" ? <Report /> : <Checkout />
        );
      `,
      resolveDir: process.cwd(),
      loader: "jsx",
    },
    bundle: true,
    write: false,
    jsx: "automatic",
    plugins: [fixturePlugin()],
    define: {
      "process.env.NODE_ENV": '"test"',
      "import.meta.env.DEV": "false",
    },
  });
  script = result.outputFiles[0].text;
  css = (await postcss([tailwindcss({
    content: [
      "client/src/components/booking/PaymentOptions.jsx",
      "client/src/components/events/PublicInvoicePoRegistrations.jsx",
      "client/src/components/ui/{button,card,input,label,radio-group,dialog}.jsx",
    ],
    corePlugins: { preflight: true },
  })]).process("@tailwind base; @tailwind components; @tailwind utilities;", { from: undefined })).css;
});

async function mount(page, mode) {
  await page.setContent('<html><body><div id="root"></div></body></html>');
  await page.addStyleTag({ content: css });
  await page.evaluate(modeValue => {
    window.__task4575 = {
      mode: modeValue,
      bookingCalls: [],
      unexpectedPaymentCalls: [],
      invoke: async function invoke(name) {
        this.unexpectedPaymentCalls.push(name);
        throw new Error("Fixture blocked unexpected backend function: " + name);
      },
    };
  }, mode);
  await page.addScriptTag({ content: script });
}

test("public purchaser can choose Invoice / PO, omit PO, and submit without payment-provider calls", async ({ page }, testInfo) => {
  await mount(page, "checkout");
  const option = page.getByTestId("payment-option-public-invoice-po");
  await expect(option).toBeVisible();
  await option.click();
  await expect(page.getByTestId("public-invoice-po-details")).toBeVisible();
  await expect(page.getByTestId("input-purchaser-first-name")).toHaveValue("Pat");
  await expect(page.getByTestId("input-purchaser-email")).toHaveValue("pat.purchaser@example.invalid");
  await expect(page.getByTestId("input-public-purchase-order")).toHaveValue("");

  await page.getByRole("button", { name: /confirm invoice \/ po registration/i }).click();
  await expect.poll(() => page.evaluate(() => window.__task4575.bookingCalls.length)).toBe(1);
  const payload = await page.evaluate(() => window.__task4575.bookingCalls[0]);
  expect(payload).toMatchObject({
    payment_method: "public_invoice_po",
    purchase_order_number: null,
    purchaser_info: {
      first_name: "Pat",
      last_name: "Purchaser",
      email: "pat.purchaser@example.invalid",
      organization: "Purchaser Org",
    },
  });
  expect(payload.purchaser_info.email).not.toBe("delegate@example.invalid");
  expect(await page.evaluate(() => window.__task4575.unexpectedPaymentCalls)).toEqual([]);
  await expect(page.getByTestId("text-booking-confirmed")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("public-invoice-po-confirmed.png"), fullPage: true });
});

test("optional PO value is included while the distinct payment method stays unchanged", async ({ page }) => {
  await mount(page, "checkout");
  await page.getByTestId("payment-option-public-invoice-po").click();
  await page.getByTestId("input-public-purchase-order").fill("PO-OPTIONAL-4575");
  await page.getByRole("button", { name: /confirm invoice \/ po registration/i }).click();
  await expect.poll(() => page.evaluate(() => window.__task4575.bookingCalls.length)).toBe(1);
  const payload = await page.evaluate(() => window.__task4575.bookingCalls[0]);
  expect(payload.payment_method).toBe("public_invoice_po");
  expect(payload.purchase_order_number).toBe("PO-OPTIONAL-4575");
  expect(await page.evaluate(() => window.__task4575.unexpectedPaymentCalls)).toEqual([]);
});

test("disabled event toggle leaves public checkout unchanged and hides Invoice / PO", async ({ page }) => {
  await mount(page, "checkout-disabled");
  await expect(page.getByTestId("payment-option-public-invoice-po")).toHaveCount(0);
  await expect(page.getByText("Pay by Credit/Debit Card", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__task4575.bookingCalls)).toEqual([]);
  expect(await page.evaluate(() => window.__task4575.unexpectedPaymentCalls)).toEqual([]);
});

test("report card follows Registrations and opens complete purchaser, attendee, PO, and form details", async ({ page }, testInfo) => {
  await mount(page, "report");
  const report = page.getByTestId("public-invoice-po-registrations");
  await expect(report).toBeVisible();
  const order = await page.locator("#root > div > *").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-testid")));
  expect(order).toEqual(["registrations-card", "public-invoice-po-registrations"]);
  await expect(report).toContainText("Pat Purchaser");
  await expect(report).toContainText("pat.purchaser@example.invalid");
  await expect(report).toContainText("Public PO Workshop");
  await expect(report).toContainText("PO-4575");

  await report.getByRole("button", { name: /Pat Purchaser/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Invoice / PO");
  await expect(dialog).toContainText("PO-4575");
  await expect(dialog).toContainText("Purchaser Org");
  await expect(dialog).toContainText("Delegate");
  await expect(dialog).toContainText("Different");
  await expect(dialog).toContainText("Attendee Organisation");
  await expect(dialog).toContainText("Vegetarian");
  await expect(dialog).toContainText("Emergency contact: Alex");
  await page.screenshot({ path: testInfo.outputPath("public-invoice-po-report-modal.png"), fullPage: true });
});