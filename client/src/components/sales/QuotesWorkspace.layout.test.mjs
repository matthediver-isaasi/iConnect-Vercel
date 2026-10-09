import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { chromium } from "playwright";
import { createServer } from "node:http";

// Isolated browser fixture: production LinesEditor and UI primitives, no portal
// server, authentication, database or network requests. Only the tax query is
// stubbed; field edits and add/reorder/delete use the production handlers.
test("quote lines fit narrow and wide containers and preserve editing/actions", async () => {
  const source = await readFile("client/src/components/sales/QuotesWorkspace.jsx", "utf8");
  const uiSources = await Promise.all(["button", "card", "input", "label", "select"].map(
    (name) => readFile(`client/src/components/ui/${name}.jsx`, "utf8"),
  ));
  const css = await postcss([tailwindcss({
    content: [{ raw: [source, ...uiSources].join("\n"), extension: "jsx" }],
    theme: { extend: { colors: {
      border: "#dbe2ea", input: "#dbe2ea", background: "#f8fafc",
      foreground: "#182334", card: "#f8fafc", primary: "#245ad2",
      secondary: "#e8eef6", muted: "#e8eef6", accent: "#e8eef6",
    } } },
  })]).process("@tailwind base; @tailwind components; @tailwind utilities;", { from: undefined });
  const bundle = await build({
    stdin: {
      resolveDir: path.resolve("."),
      loader: "jsx",
      contents: `
        import React, { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { LinesEditor } from "./client/src/components/sales/QuotesWorkspace.jsx";
        const initial = (key, description, type = "free_text") => ({
          key, description, type, productId: type === "product" ? "product-1" : "",
          quantity: 2, standardUnitPriceMinor: 1250, quotedUnitPriceMinor: 1250,
          discountBps: 0, taxRateBps: 2000, taxCode: null,
        });
        function Fixture() {
          const [form, setForm] = useState({ currency: "GBP", lines: [
            initial("one", "Workshop delivery"), initial("two", "Printed resources", "product"),
          ] });
          return <LinesEditor form={form} setForm={setForm}
            products={[{ id: "product-1", name: "Printed resources", standardPriceMinor: 1250 }]}
            bundles={[]} readOnly={false} canOverride={true} />;
        }
        createRoot(document.getElementById("root")).render(<Fixture />);
      `,
    },
    bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
    alias: { "@": path.resolve("client/src"), "@shared": path.resolve("shared") },
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{
      name: "isolated-tax-options",
      setup(builder) {
        builder.onResolve({ filter: /pages\/sales\/useCatalogue$/ }, () => ({ path: "tax-options", namespace: "fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: "export const useCatalogueTaxOptions = () => ({ data: [], isPending: false, isError: false });",
          loader: "js",
        }));
      },
    }],
    logLevel: "silent",
  });
  if (process.argv.includes("--serve")) {
    const server = createServer((req, res) => {
      const script = req.url === "/fixture.js";
      const style = req.url === "/fixture.css";
      res.setHeader("Content-Type", script ? "text/javascript" : style ? "text/css" : "text/html");
      res.end(script ? bundle.outputFiles[0].text : style ? css.css : '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body style="padding:16px"><main id="root" style="width:100%;max-width:880px;min-width:0"></main><script src="/fixture.js"></script></body></html>');
    });
    server.listen(5187, "0.0.0.0", () => console.log("Quote layout fixture ready on 5187"));
    await new Promise(() => {});
  }
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => route.request().isNavigationRequest()
      ? route.fulfill({ contentType: "text/html", body: '<!doctype html><html><body><main id="root" style="width:100%;min-width:0"></main></body></html>' })
      : route.abort());
    await page.goto("https://quote-layout.invalid");
    await page.addStyleTag({ content: css.css });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.getByText("Quote lines", { exact: true }).waitFor();
    // Include desktop viewports with a portal/sidebar-sized content area.
    for (const [viewport, container] of [[375, 343], [1280, 560], [1440, 880], [1920, 1560]]) {
      await page.setViewportSize({ width: viewport, height: 1100 });
      await page.locator("#root").evaluate((root, width) => { root.style.width = `${width}px`; }, container);
      const layout = await page.locator("#root").evaluate((root) => {
        const card = root.firstElementChild.getBoundingClientRect();
        const actions = [...root.querySelectorAll('button[aria-label]')];
        const controls = [...root.querySelectorAll("input, select, button")];
        return {
          overflow: root.scrollWidth > root.clientWidth,
          actionsInside: actions.every((action) => {
            const line = action.parentElement.parentElement.parentElement.getBoundingClientRect();
            const box = action.getBoundingClientRect();
            return box.left >= line.left && box.right <= line.right && box.bottom <= line.bottom;
          }),
          controlsInside: controls.every((control) => {
            const box = control.getBoundingClientRect();
            return box.left >= card.left && box.right <= card.right;
          }),
        };
      });
      assert.equal(layout.overflow, false, `overflow at ${viewport}/${container}px`);
      assert.equal(layout.actionsInside, true, `actions outside line at ${viewport}/${container}px`);
      assert.equal(layout.controlsInside, true, `controls outside card at ${viewport}/${container}px`);
    }
    assert.equal(await page.getByRole("button", { name: "Move line 1 up", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Move line 2 down", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "Move line 1 down", exact: true }).click();
    assert.equal(await page.locator('input[aria-label="Line description"]').inputValue(), "Printed resources");
    await page.getByRole("button", { name: "Move line 2 up", exact: true }).click();
    await page.getByPlaceholder("Description", { exact: true }).fill("Revised workshop delivery");
    assert.equal(await page.getByPlaceholder("Description", { exact: true }).inputValue(), "Revised workshop delivery");
    assert.equal(await page.getByText("£30.00", { exact: true }).count(), 2);
    await page.getByRole("button", { name: "Delete line 1", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: /^Delete line/ }).count(), 1);
    await page.getByRole("button", { name: "Free text", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: /^Delete line/ }).count(), 2);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
