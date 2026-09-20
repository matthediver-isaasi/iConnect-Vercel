import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import fs from "node:fs";
import postcss from "postcss";
import tailwindcss from "tailwindcss";

/*
 * Isolated browser-component verification for task 4626. All entity, settings,
 * voucher and payment calls are in-memory fixtures. No application server,
 * tenant database or payment provider is contacted.
 */
const stubs = {
  "@/api/base44Client": `
    const fixture = () => window.__task4626;
    export const base44 = {
      entities: {
        Event: { list: async () => [] },
        Program: { filter: async () => [] },
        Voucher: { list: async () => fixture().vouchers },
        SystemSettings: {
          list: async () => {
            if (fixture().adminSettingsError) throw new Error("Fixture settings unavailable");
            return fixture().adminSettings.map(row => ({ ...row }));
          },
          update: async (id, data) => fixture().updateSetting(id, data),
          create: async data => fixture().createSetting(data),
        },
      },
      functions: { invoke: (...args) => fixture().invoke(...args) },
      integrations: { Core: { UploadFile: async () => ({ file_url: "" }) } },
    };
  `,
  "@/api/publicClient": `
    const fixture = () => window.__task4626;
    export const publicClient = {
      listSystemSettings: () => fixture().listPublicSettings(),
      getSystemSetting: async key => key === "allow_voucher_use_after_expiry"
        ? { setting_key: key, setting_value: "true" }
        : null,
    };
  `,
  "@/hooks/useBalancesRealtime": `
    export const useBalancesRealtime = () => ({ isConnected: false });
  `,
  "@/hooks/useMemberAccess": `
    export const useMemberAccess = () => ({
      isAdmin: true,
      isAccessReady: true,
      isFeatureExcluded: () => false,
    });
  `,
  "@/components/canvas/LucideIconPicker": `
    import React from "react";
    export function LucideIconPicker() { return <div />; }
  `,
  "@/components/common/DynamicLucideIcon": `
    import React from "react";
    export default function DynamicLucideIcon() { return <span />; }
  `,
  "react-quill": `
    import React from "react";
    export default function ReactQuill(props) {
      return <textarea value={props.value || ""} onChange={e => props.onChange?.(e.target.value)} />;
    }
  `,
  "sonner": `
    const record = (level, message) => {
      window.__task4626.toastCalls.push({ level, message: String(message) });
    };
    export const toast = {
      success: message => record("success", message),
      error: message => record("error", message),
      info: message => record("info", message),
      warning: message => record("warning", message),
    };
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
    name: "task-4626-fixtures",
    setup(buildApi) {
      buildApi.onResolve({ filter: /^@\// }, args => {
        if (stubs[args.path]) return { path: args.path, namespace: "task4626-stub" };
        return { path: resolveSource(path.resolve("client/src", args.path.slice(2))) };
      });
      buildApi.onResolve({ filter: /^@shared\// }, args => ({
        path: resolveSource(path.resolve("shared", args.path.slice("@shared/".length))),
      }));
      buildApi.onResolve({ filter: /^react-quill$/ }, args => ({
        path: args.path,
        namespace: "task4626-stub",
      }));
      buildApi.onResolve({ filter: /^sonner$/ }, args => ({
        path: args.path,
        namespace: "task4626-stub",
      }));
      buildApi.onResolve({ filter: /\.css$/ }, args => ({
        path: args.path,
        namespace: "task4626-css",
      }));
      buildApi.onLoad({ filter: /.*/, namespace: "task4626-stub" }, args => ({
        contents: stubs[args.path],
        loader: "jsx",
        resolveDir: process.cwd(),
      }));
      buildApi.onLoad({ filter: /.*/, namespace: "task4626-css" }, () => ({
        contents: "",
        loader: "js",
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
        import EventSettings from "./client/src/pages/EventSettings.jsx";
        import PaymentOptions from "./client/src/components/booking/PaymentOptions.jsx";

        const event = {
          id: "event-task4626",
          title: "Payment policy workshop",
          start_date: "2099-06-01T09:00:00.000Z",
          donation_config: { enabled: false },
        };
        const member = {
          id: "member-task4626",
          role_id: window.__task4626.roleId,
          email: "member@example.invalid",
          first_name: "Fixture",
          last_name: "Member",
        };
        const organisation = {
          id: "org-task4626",
          name: "Fixture Organisation",
          training_fund_balance: 80,
          training_fund_allowed_role_ids: window.__task4626.allowedRoleIds,
          voucher_allowed_role_ids: window.__task4626.allowedRoleIds,
        };
        const attendee = {
          id: "attendee-task4626",
          isValid: true,
          isSelf: true,
          first_name: "Fixture",
          last_name: "Member",
          email: "member@example.invalid",
        };

        function Checkout() {
          return <PaymentOptions
            totalCost={100}
            memberInfo={member}
            organizationInfo={organisation}
            attendees={[attendee]}
            numberOfLinks={0}
            event={event}
            registrationMode="self"
            isOneOffEvent={!window.__task4626.complex}
            oneOffCostDetails={{ subtotal: 100, total: 100, freeTickets: 0, discount: 0 }}
            ticketPrice={100}
            selectedTicketClass={{ id: "ticket-task4626", name: "Standard", price: 100 }}
            isComplexEvent={window.__task4626.complex}
            complexEventApi={{ submitBooking: async payload => {
              window.__task4626.bookingCalls.push(payload);
              return { success: true, booking_reference: "CEB-TASK4626", bookings: [] };
            }}}
            renderAsCard={false}
          />;
        }
        function App() {
          const client = window.__task4626.queryClient || new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: 0 } },
          });
          window.__task4626.queryClient = client;
          return <QueryClientProvider client={client}>
            {window.__task4626.surface === "settings" ? <EventSettings /> : <Checkout />}
          </QueryClientProvider>;
        }
        window.__task4626.render = () => {
          window.__task4626.root?.unmount();
          window.__task4626.root = createRoot(document.getElementById("root"));
          window.__task4626.root.render(<App />);
        };
        window.__task4626.render();
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
  script = result.outputFiles.find(file => file.path.endsWith(".js"))?.text
    || result.outputFiles[0].text;
  css = (await postcss([tailwindcss({
    content: [
      "client/src/pages/EventSettings.jsx",
      "client/src/components/booking/{PaymentOptions,VoucherSelector}.jsx",
      "client/src/components/ui/{button,card,input,label,switch,radio-group,dialog,sheet,select,badge,textarea}.jsx",
    ],
    corePlugins: { preflight: true },
  })]).process("@tailwind base; @tailwind components; @tailwind utilities;", { from: undefined })).css;
});

async function mount(page, {
  surface = "checkout",
  voucher = true,
  training = true,
  missing = false,
  policyMode = "ready",
  complex = false,
  roleAllowed = true,
  restoredPayload = null,
} = {}) {
  await page.route("http://task4626.test/**", route => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: '<html><body><div id="root"></div></body></html>',
  }));
  await page.goto("http://task4626.test/");
  await page.setContent('<html><body><div id="root"></div></body></html>');
  await page.addStyleTag({ content: css });
  await page.evaluate(options => {
    const rows = options.missing ? [] : [
      { id: "setting-voucher", setting_key: "event_allow_voucher_payment", setting_value: String(options.voucher) },
      { id: "setting-training", setting_key: "event_allow_training_fund_payment", setting_value: String(options.training) },
    ];
    let resolvePublic;
    const publicGate = new Promise(resolve => { resolvePublic = resolve; });
    window.__task4626 = {
      surface: options.surface,
      complex: options.complex,
      roleId: "role-allowed",
      allowedRoleIds: options.roleAllowed ? ["role-allowed"] : ["role-other"],
      adminSettings: rows,
      adminSettingsError: options.policyMode === "admin-error",
      vouchers: [{
        id: "voucher-task4626",
        code: "FIXTURE-25",
        value: 25,
        status: "active",
        organization_id: "org-task4626",
        expires_at: "2099-12-31T00:00:00.000Z",
      }],
      bookingCalls: [],
      invocationCalls: [],
      toastCalls: [],
      writes: [],
      updateSetting(id, data) {
        const row = this.adminSettings.find(item => item.id === id);
        Object.assign(row, data);
        this.writes.push({ type: "update", id, data: { ...data } });
        return Promise.resolve({ ...row });
      },
      createSetting(data) {
        const row = { id: "created-" + data.setting_key, ...data };
        this.adminSettings.push(row);
        this.writes.push({ type: "create", data: { ...data } });
        return Promise.resolve({ ...row });
      },
      listPublicSettings() {
        if (options.policyMode === "error") return Promise.reject(new Error("Fixture public settings unavailable"));
        if (options.policyMode === "pending") return publicGate;
        return Promise.resolve(this.adminSettings.map(row => ({ ...row })));
      },
      resolvePublicSettings() {
        resolvePublic(this.adminSettings.map(row => ({ ...row })));
      },
      invoke(name, params) {
        this.invocationCalls.push({ name, params });
        if (name === "getStripePublishableKey") return Promise.resolve({ data: {} });
        if (name === "checkDuplicateRegistrations") {
          return Promise.resolve({ data: { success: true, hasDuplicates: false, duplicates: [] } });
        }
        if (name === "createOneOffEventBooking") {
          return Promise.resolve({ data: {
            success: false,
            error: "Voucher payment is not enabled for event bookings. Your card payment has been automatically refunded.",
            refunded: true,
          } });
        }
        return Promise.reject(new Error("Fixture blocked unexpected function: " + name));
      },
    };
  }, { surface, voucher, training, missing, policyMode, complex, roleAllowed });
  if (restoredPayload) {
    await page.evaluate(payload => {
      sessionStorage.setItem("pending_booking_payload_event-task4626", JSON.stringify(payload));
      history.replaceState(
        {},
        "",
        "/?payment_intent=pi_task4626_stale&redirect_status=succeeded",
      );
    }, restoredPayload);
  }
  await page.addScriptTag({ content: script });
}

async function expectMethodVisibility(page, voucher, training) {
  const voucherHeading = page.getByText("Training Vouchers", { exact: true });
  const trainingHeading = page.getByText("Training Fund", { exact: true });
  if (voucher) await expect(voucherHeading).toBeVisible();
  else await expect(voucherHeading).toHaveCount(0);
  if (training) await expect(trainingHeading).toBeVisible();
  else await expect(trainingHeading).toHaveCount(0);
}

test("admin saves both default-on settings independently and a fresh mount reloads them", async ({ page }, testInfo) => {
  await mount(page, { surface: "settings", missing: true });
  const voucher = page.getByTestId("switch-event-allow-voucher-payment");
  const training = page.getByTestId("switch-event-allow-training-fund-payment");
  await expect(voucher).toHaveAttribute("data-state", "checked");
  await expect(training).toHaveAttribute("data-state", "checked");

  await voucher.click();
  await expect(voucher).toHaveAttribute("data-state", "unchecked");
  await expect(training).toHaveAttribute("data-state", "checked");
  await page.getByTestId("button-save-event-payment-methods").click();
  await expect.poll(() => page.evaluate(() => window.__task4626.writes.some(write =>
    write.data?.setting_key === "event_allow_voucher_payment"
      && write.data?.setting_value === "false"
  ))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__task4626.writes.some(write =>
    write.data?.setting_key === "event_allow_training_fund_payment"
      && write.data?.setting_value === "true"
  ))).toBe(true);

  await page.evaluate(() => window.__task4626.render());
  await expect(page.getByTestId("switch-event-allow-voucher-payment")).toHaveAttribute("data-state", "unchecked");
  await expect(page.getByTestId("switch-event-allow-training-fund-payment")).toHaveAttribute("data-state", "checked");
  await page.screenshot({ path: testInfo.outputPath("admin-payment-method-toggles.png"), fullPage: true });
});

test("admin settings load failure is explicit and prevents unsafe saves", async ({ page }) => {
  await mount(page, { surface: "settings", policyMode: "admin-error" });
  await expect(page.getByRole("alert")).toContainText(
    "Payment method settings could not be loaded. Reload the page before making changes.",
  );
  await expect(page.getByTestId("switch-event-allow-voucher-payment")).toBeDisabled();
  await expect(page.getByTestId("switch-event-allow-training-fund-payment")).toBeDisabled();
  await expect(page.getByTestId("button-save-event-payment-methods")).toBeDisabled();
  expect(await page.evaluate(() => window.__task4626.writes)).toEqual([]);
});

for (const complex of [false, true]) {
  for (const [voucher, training] of [[true, true], [true, false], [false, true], [false, false]]) {
    test(`${complex ? "complex" : "standard"} checkout honours voucher=${voucher} training=${training}`, async ({ page }) => {
      await mount(page, { voucher, training, complex });
      await expectMethodVisibility(page, voucher, training);
      expect(await page.evaluate(() => window.__task4626.bookingCalls)).toEqual([]);
      expect((await page.evaluate(() => window.__task4626.invocationCalls))
        .filter(call => !["getStripePublishableKey"].includes(call.name))).toEqual([]);
    });
  }
}

test("missing rows use default-on policy while loading and errors never expose credit methods", async ({ page }) => {
  await mount(page, { missing: true });
  await expectMethodVisibility(page, true, true);

  const pendingPage = await page.context().newPage();
  await mount(pendingPage, { policyMode: "pending" });
  await expectMethodVisibility(pendingPage, false, false);
  await expect(pendingPage.getByRole("button", { name: /book & pay/i })).toBeDisabled();
  await pendingPage.evaluate(() => window.__task4626.resolvePublicSettings());
  await expectMethodVisibility(pendingPage, true, true);
  await expect(pendingPage.getByRole("button", { name: /book & pay/i })).toBeEnabled();
  await pendingPage.close();

  const errorPage = await page.context().newPage();
  await mount(errorPage, { policyMode: "error" });
  await expectMethodVisibility(errorPage, false, false);
  await expect(errorPage.getByRole("button", { name: /book & pay/i })).toBeDisabled();
  expect(await errorPage.evaluate(() => window.__task4626.bookingCalls)).toEqual([]);
  await errorPage.close();
});

test("existing organisation role restrictions still hide both enabled credit methods", async ({ page }) => {
  await mount(page, { voucher: true, training: true, roleAllowed: false });
  await expectMethodVisibility(page, false, false);
  await expect(page.getByText("Amount Due:", { exact: true })).toBeVisible();
});

test("selected credits are cleared when refreshed settings disable them", async ({ page }) => {
  await mount(page, { voucher: true, training: true });
  await expectMethodVisibility(page, true, true);

  await page.getByTestId("voucher-option-voucher-task4626").getByRole("switch").click();
  await page.getByPlaceholder("Amount in £").fill("30");
  const paymentSummary = page.getByText("Payment Summary", { exact: true }).locator("..");
  await expect(paymentSummary).toBeVisible();
  await expect(page.getByText("Voucher Value Applied:", { exact: true }).locator("..")).toContainText("£25.00");
  await expect(paymentSummary.getByText("Training Fund:", { exact: true }).locator("..")).toContainText("-£30.00");
  await expect(page.getByText("Amount Due:", { exact: true }).locator("..")).toContainText("£45.00");

  await page.evaluate(async () => {
    for (const row of window.__task4626.adminSettings) row.setting_value = "false";
    await window.__task4626.queryClient.invalidateQueries({
      queryKey: ["/api/public/system-settings"],
    });
  });

  await expectMethodVisibility(page, false, false);
  await expect(page.getByText("Payment Summary", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Amount Due:", { exact: true }).locator("..")).toContainText("£100.00");
  expect(await page.evaluate(() => window.__task4626.bookingCalls)).toEqual([]);
  expect((await page.evaluate(() => window.__task4626.invocationCalls))
    .filter(call => call.name !== "getStripePublishableKey")).toEqual([]);
});

for (const [state, options] of [
  ["disabled", { voucher: false, training: false }],
  ["loading", { policyMode: "pending" }],
  ["error", { policyMode: "error" }],
]) {
  test(`restored post-3DS credits reach server unchanged while settings are ${state}`, async ({ page }) => {
    await mount(page, {
      ...options,
      restoredPayload: {
        stripePaymentIntentId: "pi_task4626_stale",
        selectedVoucherIds: ["voucher-task4626"],
        trainingFundAmount: 20,
        voucherOrderManual: false,
        isComplexEvent: false,
      },
    });

    await expect.poll(() => page.evaluate(() => {
      return window.__task4626.invocationCalls.find(
        call => call.name === "createOneOffEventBooking",
      ) || null;
    })).not.toBeNull();
    const forwardedPayload = await page.evaluate(() => {
      return window.__task4626.invocationCalls.find(
        call => call.name === "createOneOffEventBooking",
      ).params;
    });
    expect(forwardedPayload).toEqual(expect.objectContaining({
      stripePaymentIntentId: "pi_task4626_stale",
      selectedVoucherIds: ["voucher-task4626"],
      trainingFundAmount: 20,
      voucherOrderManual: false,
    }));
    await expect.poll(() => page.evaluate(() => window.__task4626.toastCalls)).toContainEqual({
      level: "error",
      message: "Voucher payment is not enabled for event bookings. Your card payment has been automatically refunded.",
    });
    expect(await page.evaluate(() => window.__task4626.bookingCalls)).toEqual([]);
    expect((await page.evaluate(() => window.__task4626.invocationCalls))
      .filter(call => call.name !== "getStripePublishableKey")
      .map(call => call.name)).toEqual(["createOneOffEventBooking"]);
  });
}