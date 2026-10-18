import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { chromium } from "playwright";

// Disposable browser fixture only: no app workflow, database, provider or email.
// Every request is intercepted in this browser; production panel/hooks run.
test("grouped invoice customer confirmation and provider refresh work at mobile and desktop sizes", async () => {
  const sources = await Promise.all([
    "client/src/components/sales/InvoiceSchedulesPanel.jsx",
    ...["button", "card", "badge"].map(name => `client/src/components/ui/${name}.jsx`),
  ].map(file => readFile(file, "utf8")));
  const css = await postcss([tailwindcss({
    content: [{ raw: sources.join("\n"), extension: "jsx" }],
    theme: { extend: { colors: {
      border: "#dbe2ea", input: "#dbe2ea", background: "#f8fafc", foreground: "#182334",
      card: "#f8fafc", primary: "#245ad2", secondary: "#e8eef6", muted: "#e8eef6",
      accent: "#e8eef6", destructive: "#b12c48",
    } } },
  })]).process("@tailwind base; @tailwind components; @tailwind utilities;", { from: undefined });
  const bundle = await build({
    stdin: { contents: `
      import React from "react";
      import {createRoot} from "react-dom/client";
      import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
      import Panel from "./client/src/components/sales/InvoiceSchedulesPanel.jsx";
      const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
      createRoot(document.getElementById("root")).render(<QueryClientProvider client={client}>
        <Panel saleId="sale-fixture" access={{canViewInvoice:true,canRetryInvoice:true}} />
      </QueryClientProvider>);`, resolveDir: process.cwd(), loader: "jsx" },
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    alias: { "@": `${process.cwd()}/client/src`, "@shared": `${process.cwd()}/shared` },
    plugins: [{ name: "isolated-schedule-discovery", setup(builder) {
      builder.onResolve({ filter: /useSalesSettings$/ }, () => ({ path: "scope", namespace: "fixture" }));
      builder.onResolve({ filter: /base44Client$/ }, () => ({ path: "tenant", namespace: "fixture" }));
      builder.onResolve({ filter: /viewerProtectedWorkGate$/ }, () => ({ path: "gate", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
        contents: path === "tenant" ? "export const getActiveTenantId=()=>null;"
          : path === "gate" ? "export const getViewerProtectedWorkGeneration=()=>0; export const isViewerProtectedWorkPaused=()=>false;"
            : `export const useSalesSettingsScope=()=>({scopeKey:"fixture-tenant",ready:true,tenant:null,generation:0});
            export async function salesSettingsRequest(path,options={}) {
              const response=await fetch(path,{credentials:"include",...options,headers:{"Content-Type":"application/json",...options.headers}});
              const payload=await response.json();
              if(!response.ok) throw Object.assign(new Error(payload.message||"Fixture request failed"),{status:response.status,payload});
              return payload;
            }`, loader: "js",
      }));
    } }],
  });
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 1000 } });
    const errors = [], calls = [], unexpected = [];
    let confirmed = false, paid = false;
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", async route => {
      const req = route.request();
      const url = new URL(req.url());
      if (req.isNavigationRequest()) return route.fulfill({ contentType: "text/html", body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="padding:12px"><main id="root" style="width:100%;min-width:0"></main></body></html>' });
      if (url.pathname !== "/api/sales/accounting/sale-fixture") { unexpected.push(req.url()); return route.abort(); }
      const action = url.searchParams.get("action");
      calls.push({ action, method: req.method(), body: req.postDataJSON() });
      if (action === "retry-schedule" && req.method() === "POST") {
        assert.deepEqual(req.postDataJSON(), { scheduleId: "travel-schedule", providerCustomerId: "customer-b", confirmCustomerMatch: true });
        confirmed = true;
        return route.fulfill({ json: { ok: true } });
      }
      if (action === "refresh-schedule" && req.method() === "POST") {
        assert.deepEqual(req.postDataJSON(), { scheduleId: "travel-schedule" });
        paid = true;
        return route.fulfill({ json: { ok: true } });
      }
      if (action !== "schedules" || req.method() !== "GET") { unexpected.push(req.url()); return route.abort(); }
      return route.fulfill({ json: { schedules: [
        { id: "travel-schedule", status: confirmed ? "invoiced" : "blocked", can_retry: !confirmed, delivery_status: confirmed ? "sent" : "pending",
          last_error: confirmed ? null : { code: "AMBIGUOUS_CUSTOMER_MATCH", message: "Choose the intended customer", details: { candidates: [
            { providerCustomerId: "customer-a", name: "Harbour Events", email: "accounts@harbour.example.test" },
            { provider_customer_id: "customer-b", display_name: "Harbour Exhibition Services", email: "billing@harbour.example.test" },
          ] } },
          snapshot: { name: "Accommodation & travel", grossMinor: 1731, currency: "GBP" },
          invoice: confirmed ? { id: "invoice-137", number: "INV-137", status: paid ? "paid" : "unpaid" } : null },
        { id: "zero-schedule", status: "no_invoice_required", snapshot: { name: "Included support", grossMinor: 0, currency: "GBP" } },
      ] } });
    });
    await page.goto("http://sales-schedule.fixture.invalid");
    await page.addStyleTag({ content: css.css });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const confirm = page.getByRole("button", { name: "Confirm customer and retry this group" });
    await confirm.waitFor();
    assert.equal(await confirm.isDisabled(), true);
    assert.equal(await page.locator('input[type="radio"]:checked').count(), 0);
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.locator("#root").evaluate(root => root.scrollWidth > root.clientWidth), false, `Overflow at ${width}px`);
    }
    await page.locator('input[value="customer-b"]').check();
    await confirm.click();
    await page.getByText("INV-137", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Refresh payment status", exact: true }).click();
    await page.locator("dd").getByText("paid", { exact: true }).waitFor();
    assert.equal(calls.filter(call => call.action === "retry-schedule").length, 1);
    assert.equal(calls.filter(call => call.action === "refresh-schedule").length, 1);
    assert.equal(await page.getByRole("button", { name: "Retry this group", exact: true }).count(), 0);
    assert.equal(await page.getByText("No invoice required", { exact: true }).count(), 1);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
  } finally { await browser.close(); }
});
