import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";

// Entirely intercepted browser fixture, not the running application. Real Sales,
// BrowserRouter, session/role providers and settings hook; only heavy destination
// workspaces are stubs. No real auth, sales writes or outbound network is used.
test("browser cold routes, refresh, history replacement and live naming publish preserve editor state", async () => {
  const proposal = {
    quoteSingularName: "Proposal", quotePluralName: "Proposals", quoteUrlSegment: "proposals",
    showInternalCode: false, showSku: true, quoteTaskListName: "Delivery preparation", version: 1,
  };
  const salesPlan = {
    quoteSingularName: "Sales Plan", quotePluralName: "Sales Plans", quoteUrlSegment: "sales-plans",
    showInternalCode: true, showSku: false, quoteTaskListName: "Delivery preparation", version: 2,
  };
  let activeSettings = proposal;
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "jsx",
      contents: `
        import React, { useEffect } from "react";
        import { createRoot } from "react-dom/client";
        import { BrowserRouter, Route, Routes, useNavigate, useLocation } from "react-router-dom";
        import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
        import Sales from "./client/src/pages/Sales.jsx";
        import { LayoutProvider, useLayoutContext } from "./client/src/contexts/LayoutContext.jsx";
        import { useSalesSettings } from "./client/src/hooks/useSalesSettings.js";
        const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
        function Fixture() {
          const layout = useLayoutContext();
          const settings = useSalesSettings();
          const navigate = useNavigate();
          const location = useLocation();
          useEffect(() => {
            layout.setMemberInfo({ id: "member-a", tenant_id: "tenant-a", role_id: "role-a", member_excluded_features: [] });
            layout.setSessionRoleSnapshot({
              status: "ready", member_id: "member-a", tenant_id: "tenant-a", role_id: "role-a", session_key: "session-a",
              role: { id: "role-a", tenant_id: "tenant-a", name: "Member", excluded_features: [] },
            });
            layout.setSessionValidated(true);
            layout.setAuthResolved(true);
          }, []);
          return <>
            <output data-testid="route">{location.pathname}{location.search}{location.hash}</output>
            <button onClick={() => navigate("/sales/quotes/new?opportunityId=opp%2F2#notes")}>Legacy new</button>
            <button onClick={() => navigate("/sales/dashboard?before=1#home")}>Dashboard</button>
            <button onClick={() => settings.publish(${JSON.stringify(salesPlan)})}>Publish Sales Plans</button>
            <Routes>
              <Route path="/sales/quotes" element={<Sales destination="quotes" />} />
              <Route path="/sales/quotes/:id" element={<Sales destination="quotes" />} />
              <Route path="/sales/dashboard" element={<Sales destination="dashboard" />} />
              <Route path="/sales/:destination" element={<Sales />} />
              <Route path="/sales/:destination/:id" element={<Sales />} />
              <Route path="/Preferences" element={<p>Preferences</p>} />
            </Routes>
          </>;
        }
        createRoot(document.getElementById("root")).render(
          <QueryClientProvider client={cache}><LayoutProvider><BrowserRouter><Fixture /></BrowserRouter></LayoutProvider></QueryClientProvider>
        );
      `,
    },
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    alias: { "@": path.resolve("client/src"), "@shared": path.resolve("shared") },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
    loader: { ".css": "empty" },
    logLevel: "silent",
    plugins: [{
      name: "stateful-workspace-stubs",
      setup(builder) {
        builder.onResolve(
          { filter: /(pages\/sales\/Catalogue|components\/sales\/(OpportunitiesWorkspace|QuotesWorkspace|SalesTasksWorkspace|SalesReportingWorkspace))$/ },
          args => ({ path: args.path, namespace: "browser-fixture" }),
        );
        builder.onLoad({ filter: /.*/, namespace: "browser-fixture" }, args => {
          if (args.path.endsWith("QuotesWorkspace")) return {
            loader: "jsx", resolveDir: process.cwd(),
            contents: `
              import React, { useState } from "react";
              import { useParams } from "react-router-dom";
              import { useQuoteNaming } from "@/hooks/useSalesSettings";
              import { useSalesSettings as useCatalogueSettings } from "@/components/sales/useSalesSettings";
              export default function Editor() {
                const [value, setValue] = useState("");
                const { id } = useParams();
                const naming = useQuoteNaming();
                const catalogue = useCatalogueSettings();
                return <section data-testid="editor">
                  <p data-testid="route-id">{id || "list"}</p>
                  <p data-testid="editor-label">{naming.singular} / {naming.plural}</p>
                  <p data-testid="catalogue-visibility">{JSON.stringify({
                    showInternalCode: catalogue.data?.showInternalCode,
                    showSku: catalogue.data?.showSku,
                    quoteTaskListName: catalogue.data?.quoteTaskListName,
                  })}</p>
                  <input aria-label="Unsaved offer" value={value} onChange={event => setValue(event.target.value)} />
                </section>;
              }
            `,
          };
          if (args.path.endsWith("SalesReportingWorkspace")) return {
            loader: "jsx", resolveDir: process.cwd(),
            contents: 'import React from "react"; export const SalesDashboard = () => <p>Dashboard workspace</p>; export const SalesReports = () => <p>Reports workspace</p>;',
          };
          return {
            loader: "jsx", resolveDir: process.cwd(),
            contents: 'import React from "react"; export default () => <p>Other workspace</p>;',
          };
        });
      },
    }],
  });
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  const page = await browser.newPage();
  const errors = [];
  const unexpected = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== "https://sales-route-fixture.invalid") {
      unexpected.push(request.url());
      return route.abort();
    }
    if (url.pathname === "/api/sales/settings") {
      assert.equal(request.method(), "GET");
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(activeSettings) });
    }
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: bundle.outputFiles[0].text });
    if (request.isNavigationRequest()) return route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><body><main id="root"></main><script src="/fixture.js"></script></body></html>',
    });
    unexpected.push(request.url());
    return route.abort();
  });
  const origin = "https://sales-route-fixture.invalid";
  const ready = () => page.getByLabel("Unsaved offer").waitFor();
  try {
    for (const naming of [proposal, salesPlan]) {
      activeSettings = naming;
      for (const alias of ["quotes", naming.quoteUrlSegment]) {
        for (const tail of ["", "/new", "/quote-7"]) {
          const suffix = "?opportunityId=opp%2F2#commercial";
          const canonical = `${origin}/sales/${naming.quoteUrlSegment}${tail}${suffix}`;
          await page.goto(`${origin}/sales/${alias}${tail}${suffix}`);
          await ready();
          await page.waitForURL(canonical);
          assert.equal(await page.locator("h1").textContent(), naming.quotePluralName);
          assert.equal(await page.getByTestId("route-id").textContent(), tail.slice(1) || "list");
          assert.deepEqual(JSON.parse(await page.getByTestId("catalogue-visibility").textContent()), {
            showInternalCode: naming.showInternalCode, showSku: naming.showSku, quoteTaskListName: "Delivery preparation",
          });
          await page.reload();
          await ready();
          assert.equal(page.url(), canonical);
        }
      }
    }
    activeSettings = proposal;
    await page.goto(`${origin}/sales/dashboard?before=1#home`);
    await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
    await page.getByRole("button", { name: "Legacy new", exact: true }).click();
    await ready();
    await page.waitForURL(`${origin}/sales/proposals/new?opportunityId=opp%2F2#notes`);
    await page.goBack();
    await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
    assert.equal(page.url(), `${origin}/sales/dashboard?before=1#home`);
    await page.goForward();
    await ready();
    assert.equal(page.url(), `${origin}/sales/proposals/new?opportunityId=opp%2F2#notes`);
    await page.getByLabel("Unsaved offer").fill("Negotiated draft, not saved");
    await page.getByLabel("Unsaved offer").evaluate(input => { input.dataset.originalInput = "retained"; });
    activeSettings = salesPlan;
    await page.getByRole("button", { name: "Publish Sales Plans", exact: true }).click();
    await page.waitForURL(`${origin}/sales/sales-plans/new?opportunityId=opp%2F2#notes`);
    assert.equal(await page.locator("h1").textContent(), "Sales Plans");
    assert.equal(await page.getByTestId("editor-label").textContent(), "Sales Plan / Sales Plans");
    assert.deepEqual(JSON.parse(await page.getByTestId("catalogue-visibility").textContent()), {
      showInternalCode: true, showSku: false, quoteTaskListName: "Delivery preparation",
    }, "the real canonical catalogue observer updates from naming publish without losing task-list settings");
    assert.equal(await page.getByLabel("Unsaved offer").inputValue(), "Negotiated draft, not saved");
    assert.equal(await page.getByLabel("Unsaved offer").getAttribute("data-original-input"), "retained");
    await page.reload();
    await ready();
    assert.equal(page.url(), `${origin}/sales/sales-plans/new?opportunityId=opp%2F2#notes`);
    assert.equal(await page.getByLabel("Unsaved offer").inputValue(), "", "a real refresh resets local-only draft fixture state");
    await page.goto(`${origin}/sales/proposals/quote-7`);
    await page.getByRole("alert").waitFor();
    assert.match(await page.getByRole("alert").textContent(), /Sales page not found/);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
