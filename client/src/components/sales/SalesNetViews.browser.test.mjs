import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { build } from "esbuild";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { chromium } from "playwright";
import { buildSalesReport, buildSalesDashboard, parseSalesReportQuery } from "../../../../api/_lib/salesReports.js";

test("real dashboard payload and pipeline views show net values, responsive context and keyboard links", async () => {
  const opportunity = { id: "opportunity", name: "Annual professional training partnership", currency: "GBP",
    value_minor: 12000, stage_id: "open", organization_id: "org", expected_close_date: "2026-12-02" };
  const data = {
    opportunities: [opportunity], stages: [{ id: "open", name: "Open", probability: 25 }],
    organisations: [{ id: "org", name: "An organisation with a very long name for narrow screen verification" }],
    quotes: Array.from({ length: 10 }, (_, i) => ({ id: `q/${i}`, opportunity_id: i === 0 ? opportunity.id : null, current_version: 1, quote_number: i === 1 ? null : `P-${i}` })),
    versions: Array.from({ length: 10 }, (_, i) => ({ id: `v-${i}`, quote_id: `q/${i}`, version_number: 1,
      status: ["issued", "sent", "accepted"][i % 3], net_minor: i === 1 ? null : i === 2 ? 0 : 10000,
      tax_minor: 2000, gross_minor: 12000, currency: i === 2 ? "EUR" : "GBP",
      issued_at: i === 1 ? null : "2026-11-26T12:00:00Z" })),
    sales: [],
  };
  const filters = parseSalesReportQuery({ view: "dashboard", expectedCloseFrom: "2026-01-01" });
  const dashboard = buildSalesDashboard(data, buildSalesReport(data, filters), filters);
  const paths = ["SalesReportingWorkspace", "OutstandingProposalSummary", "OpportunitiesWorkspace", "SalesRecentActivity"].map(name => `client/src/components/sales/${name}.jsx`);
  const sources = await Promise.all(paths.map(path => readFile(path, "utf8")));
  const css = await postcss([tailwindcss({
    content: [{ raw: sources.join("\n"), extension: "jsx" }],
    theme: { extend: { colors: { border: "#dbe2ea", input: "#dbe2ea", background: "#fff", foreground: "#182334", card: "#fff", primary: "#245ad2", secondary: "#e8eef6", muted: "#e8eef6", accent: "#e8eef6" } } },
  })]).process("@tailwind base; @tailwind components; @tailwind utilities;", { from: undefined });
  const bundle = await build({
    stdin: { contents: `
      import React from "react"; import {createRoot} from "react-dom/client";
      import {BrowserRouter} from "react-router-dom"; import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
      import {SalesDashboard} from "./client/src/components/sales/SalesReportingWorkspace.jsx";
      import {OpportunitiesList} from "./client/src/components/sales/OpportunitiesWorkspace.jsx";
      const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{gcTime:0}}});
      createRoot(document.getElementById("root")).render(<QueryClientProvider client={client}><BrowserRouter>
      {location.pathname==="/sales/pipeline"?<OpportunitiesList destination="pipeline"/>:<SalesDashboard/>}
      </BrowserRouter></QueryClientProvider>);`, resolveDir: process.cwd(), loader: "jsx" },
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    alias: { "@": `${process.cwd()}/client/src`, "@shared": `${process.cwd()}/shared` },
    plugins: [{ name: "isolate-unrelated-sales-dependencies", setup(builder) {
      builder.onResolve({ filter: /useSalesSettings$/ }, () => ({ path: "naming", namespace: "fixture" }));
      builder.onResolve({ filter: /^(?:@\/|\.\/)/ }, args => {
        if (!args.importer.endsWith("/OpportunitiesWorkspace.jsx") || args.path.includes("/ui/") || args.path.endsWith("salesNetMoney.mjs")) return;
        return { path: args.path, namespace: "opportunity-dependency" };
      });
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        contents: 'export const useQuoteNaming=()=>({singular:"Training Proposal",plural:"Training Proposals",slug:"training-proposals"});',
      }));
      builder.onLoad({ filter: /.*/, namespace: "opportunity-dependency" }, ({ path }) => {
        // Only unrelated page dependencies are replaced; list, cards, money,
        // router, query state and shared UI are the production implementations.
        const declaration = [...sources[2].matchAll(/import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];/g)].find(match => match[2] === path)?.[1] || "";
        const named = declaration.match(/\{([^}]+)\}/)?.[1].split(",").map(name => name.trim()).filter(Boolean) || [];
        return { contents: `export default ()=>null;\n${named.map(name => `export const ${name}=${name === "useMemberAccess" ? '()=>({memberInfo:{id:"fixture",tenant_id:"fixture"}})' : name === "useToast" ? '()=>({toast:()=>{}})' : name === "DEFAULT_TASK_CHOICE" ? '"standard"' : '()=>null'};`).join("\n")}` };
      });
    } }],
  });
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  await mkdir("generated-artifacts/sales-net", { recursive: true });
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      const requests = [];
      await page.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.pathname === "/api/sales/reports") return route.fulfill({ json: dashboard });
        if (url.pathname === "/api/opportunities") {
          requests.push(url);
          return route.fulfill({ json: { items: [
            { ...opportunity, netValueMinor: 10000, netValueSource: "proposal" },
            { ...opportunity, id: "manual", name: "Manual estimate", netValueMinor: 5000, netValueSource: "manual" },
            { ...opportunity, id: "missing", name: "Missing evidence", netValueMinor: null, netValueSource: "unavailable" },
            { ...opportunity, id: "zero", name: "Free proposal", currency: "EUR", netValueMinor: 0, netValueSource: "proposal" },
          ], total: 4 } });
        }
        if (url.pathname === "/api/opportunity-settings") return route.fulfill({ json: { items: data.stages } });
        if (route.request().resourceType() !== "document") throw Error(`Unexpected fixture request ${url.pathname}`);
        return route.fulfill({ contentType: "text/html", body: `<html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css.css}</style><div id="root" style="padding:16px"></div><script>${bundle.outputFiles[0].text}</script></html>` });
      });
      await page.goto("https://fixture.example.test/sales/dashboard");
      const row = page.getByRole("link").filter({ hasText: "P-0" });
      await row.waitFor();
      assert.match(await row.textContent(), /GBP.*100\.00 net/);
      assert.match(await row.textContent(), /Opportunity: Annual professional training partnership/);
      assert.match(await row.textContent(), /Issued: 26\/11\/2026/);
      assert.match(await page.textContent("#root"), /10 outstanding training proposals · Showing 8 of 10/);
      assert.match(await page.textContent("#root"), /EUR.*0\.00 net/s);
      assert.doesNotMatch(await page.textContent("#root"), /\[object Object\]|120\.00/);
      await page.screenshot({ path: `generated-artifacts/sales-net/dashboard-${width}.png`, fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
        JSON.stringify(await page.locator("#root *").evaluateAll(nodes => nodes.filter(node => node.getBoundingClientRect().right > innerWidth).map(node => ({ tag: node.tagName, cls: node.className, width: node.getBoundingClientRect().width })).slice(0, 8))));
      await row.focus();
      assert.equal(await row.evaluate(node => document.activeElement === node), true);
      await page.keyboard.press("Enter");
      assert.equal(new URL(page.url()).pathname, "/sales/training-proposals/q%2F0");
      await page.goto("https://fixture.example.test/sales/pipeline");
      await page.getByText("GBP £100.00 net", { exact: true }).waitFor();
      assert.match(await page.textContent("#root"), /GBP.*50\.00 net estimate/);
      assert.match(await page.textContent("#root"), /Net unavailable/);
      assert.match(await page.textContent("#root"), /EUR.*0\.00 net/);
      await page.getByRole("button", { name: "Table view", exact: true }).click();
      await page.getByRole("columnheader", { name: "Net value (excluding tax)" }).waitFor();
      assert.match(await page.locator("tbody").textContent(), /GBP.*100\.00 net/);
      assert.doesNotMatch(await page.locator("tbody").textContent(), /120\.00/);
      assert.ok(requests.every(url => url.searchParams.get("moneyBasis") === "net"));
      await page.screenshot({ path: `generated-artifacts/sales-net/pipeline-table-${width}.png`, fullPage: true });
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});
