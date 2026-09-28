import { test, expect } from "@playwright/test";
import { PDFDocument, rgb } from "pdf-lib";
import { readFile } from "node:fs/promises";
import { serializeCertificatePlaceholder } from '../client/src/lib/cpdCertificateContract.js';
import { layoutPlaceholder } from '../api/_lib/cpdCertificatePdf.js';

// The application code and PDF.js run through the existing Vite preview.
// Only the HTML shell, access hook, certificate API and PDF bytes are fixture-owned.
// All other API requests and all writes fail closed; no tenant or database is contacted.
const SIZE = {
  portrait: { width: 612, height: 792 },
  landscape: { width: 792, height: 612 },
};
const FIELD = { id: "fixture-field", key: "member.full_name", label: "Member full name",
  page: 1, x: 72, y: 90, width: 200, height: 32, font_size: 16, sample: "Fixture Member" };
let pdf;
let workerCode;
let origin;

test.beforeAll(async ({ request }) => {
  const response = await request.get("/src/pages/CPDCertificateTemplates.jsx");
  expect(response.ok(), "Vite must serve the actual certificate designer").toBeTruthy();
  origin = new URL(response.url()).origin;
  workerCode = await readFile("node_modules/pdfjs-dist/build/pdf.worker.min.mjs", "utf8");
  const document = await PDFDocument.create();
  for (const size of Object.values(SIZE)) {
    const page = document.addPage([size.width, size.height]);
    // Colored PDF ink at the same top-left PDF coordinates as the sample field.
    page.drawRectangle({
      x: FIELD.x, y: size.height - FIELD.y - FIELD.height,
      width: FIELD.width, height: FIELD.height, color: rgb(1, 0, 0),
    });
  }
  pdf = Buffer.from(await document.save());
});

async function modules(request) {
  const transformed = await (await request.get("/src/pages/CPDCertificateTemplates.jsx")).text();
  const react = transformed.match(/"([^"]*\/react\.js\?[^"]*)"/)?.[1];
  if (!react) throw new Error("Vite React dependency was not transformed");
  const dependency = name => react.replace(/react\.js\?/, `${name}.js?`);
  for (const path of ["/@react-refresh", "/@vite/client", "/src/index.css",
    "/src/pages/CPDCertificateTemplates.jsx", react, dependency("react-dom_client"),
    dependency("@tanstack_react-query"), dependency("react-router-dom")]) {
    expect((await request.get(path)).ok(), `Vite fixture dependency ${path}`).toBeTruthy();
  }
  return { react, dependency };
}

function html({ react, dependency }) {
  return `<!doctype html><html><head><title>Certificate preview fixture</title></head>
    <body><div id="root"></div><script>
      // System Chromium 125 predates URL.parse; pdfjs-dist requires it.
      URL.parse ||= (input, base) => { try { return new URL(input, base); } catch { return null; } };
      Promise.try ||= (fn, ...args) => new Promise(resolve => resolve(fn(...args)));
      Uint8Array.prototype.toHex ||= function() {
        return Array.from(this, byte => byte.toString(16).padStart(2, "0")).join("");
      };
      Map.prototype.getOrInsertComputed ||= function(key, compute) {
        if (!this.has(key)) this.set(key, compute(key));
        return this.get(key);
      };
      Map.prototype.getOrInsert ||= function(key, value) {
        if (!this.has(key)) this.set(key, value);
        return this.get(key);
      };
    </script><script type="module">
      import RefreshRuntime from "/@react-refresh";
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      await import("/@vite/client");
      await import("/src/index.css");
      const React = (await import(${JSON.stringify(react)})).default;
      const { createRoot } = (await import(${JSON.stringify(dependency("react-dom_client"))})).default;
      const { QueryClient, QueryClientProvider } = await import(${JSON.stringify(dependency("@tanstack_react-query"))});
      const { MemoryRouter, Route, Routes } = await import(${JSON.stringify(dependency("react-router-dom"))});
      const { default: DesignerPage } = await import("/src/pages/CPDCertificateTemplates.jsx");
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
      createRoot(document.getElementById("root")).render(
        React.createElement(QueryClientProvider, { client },
          React.createElement(MemoryRouter, { initialEntries: [location.pathname + location.search] },
            React.createElement(Routes, null,
              React.createElement(Route, { path: "/CPDCertificateTemplates/:templateId", element: React.createElement(DesignerPage) })
            )
          )
        )
      );
    </script></body></html>`;
}

async function mount(page, request, { active = false, direct = true, delay = 80, fields } = {}) {
  const fixtureHtml = html(await modules(request));
  const state = { writes: [], unexpected: [], errors: [], consoleErrors: [], failedRequests: [], pdfRequests: [] };
  page.on("pageerror", error => state.errors.push(error.stack || error.message));
  page.on("console", async message => {
    if (message.type() !== "error") return;
    const detail = await Promise.all(message.args().map(arg => arg.evaluate(value =>
      value instanceof Error || value?.message
        ? { name: value.name, message: value.message, stack: value.stack, details: value.details }
        : String(value),
    ).catch(() => "<unavailable>")));
    state.consoleErrors.push(detail);
  });
  page.on("requestfailed", req => state.failedRequests.push(`${req.url()}: ${req.failure()?.errorText}`));
  page.on("request", req => { if (/pdf|worker/i.test(req.url())) state.pdfRequests.push(req.url()); });
  const template = {
    id: "fixture-template", name: "Certificate fixture", version: 1,
    status: active ? "active" : "draft", pdf_metadata: { pages: [
      { number: 1, ...SIZE.portrait }, { number: 2, ...SIZE.landscape },
    ] }, placeholders: fields || [FIELD, { ...FIELD, id: "landscape-field", page: 2 }],
  };
  await page.route("**/*", async route => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.endsWith("/pdf.worker.min.mjs")) {
      return route.fulfill({
        contentType: "text/javascript",
        body: `Promise.try ||= (fn, ...args) => new Promise(resolve => resolve(fn(...args)));
URL.parse ||= (input, base) => { try { return new URL(input, base); } catch { return null; } };
Uint8Array.prototype.toHex ||= function() {
  return Array.from(this, byte => byte.toString(16).padStart(2, "0")).join("");
};
Map.prototype.getOrInsertComputed ||= function(key, compute) {
  if (!this.has(key)) this.set(key, compute(key));
  return this.get(key);
};
Map.prototype.getOrInsert ||= function(key, value) {
  if (!this.has(key)) this.set(key, value);
  return this.get(key);
};
` + workerCode,
      });
    }
    if (url.pathname === "/src/hooks/useMemberAccess.js") {
      return route.fulfill({ contentType: "text/javascript", body: `
        export const useMemberAccess = () => ({
          authResolved: true, isRoleLoading: false, memberInfo: { role_id: "fixture-role" },
          memberRole: { id: "fixture-role" }, isFeatureExcluded: () => false,
        });
      ` });
    }
    if (url.pathname === "/CPDCertificateTemplates/fixture-template") {
      return route.fulfill({ contentType: "text/html", body: fixtureHtml });
    }
    const json = value => route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
    if (url.pathname === "/api/cpd-certificate-templates/fixture-template" && req.method() === "GET") {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      return json({ template, placeholders: template.placeholders });
    }
    if (url.pathname === "/api/cpd-certificate-templates/fixture-template/source" && req.method() === "GET") {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      return json({ signedUrl: `${origin}/fixture-certificate.pdf` });
    }
    if (url.pathname === "/fixture-certificate.pdf") {
      return route.fulfill({ contentType: "application/pdf", body: pdf });
    }
    if (url.pathname.startsWith("/api/") || !["GET", "HEAD"].includes(req.method())) {
      state.unexpected.push(`${req.method()} ${url.pathname}`);
      return route.abort();
    }
    return route.continue();
  });
  await page.goto(`/CPDCertificateTemplates/fixture-template${direct ? "?preview=1" : ""}`);
  await expect(page.getByTestId("certificate-page")).toBeVisible();
  await expect(page.locator('canvas[aria-label="PDF page 1"]')).toBeVisible();
  try { await expect.poll(() => page.locator('canvas[aria-label="PDF page 1"]').evaluate((canvas, field) => {
    if (!canvas.width || !canvas.clientWidth) return false;
    const pixel = canvas.getContext("2d").getImageData(
      Math.round(canvas.width / 612 * (field.x + 8)),
      Math.round(canvas.height / 792 * (field.y + 8)), 1, 1,
    ).data;
    return pixel[0] > 200 && pixel[1] < 80 && pixel[3] > 200;
  }, FIELD)).toBe(true); } catch (error) {
    const pixel = await page.locator('canvas[aria-label="PDF page 1"]').evaluate((canvas, field) =>
      ({ size: [canvas.width, canvas.height], color: Array.from(canvas.getContext("2d").getImageData(
        Math.round(canvas.width / 612 * (field.x + 8)),
        Math.round(canvas.height / 792 * (field.y + 8)), 1, 1).data) }), FIELD);
    throw new Error(`${error.message}\nPDF pixel ${JSON.stringify(pixel)}; fixture state ${JSON.stringify(state)}`);
  }
  return state;
}

async function measure(page) {
  return page.evaluate(() => {
    const viewport = document.querySelector('[data-testid="certificate-viewport"]');
    const sheet = document.querySelector('[data-testid="certificate-page"]');
    const canvas = sheet.querySelector("canvas");
    const field = sheet.querySelector('[title^="72.0, 90.0"]');
    const rect = el => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    return {
      viewport: rect(viewport), page: rect(sheet), canvas: rect(canvas), field: field && rect(field),
      scrollWidth: viewport.scrollWidth, clientWidth: viewport.clientWidth,
      scrollHeight: viewport.scrollHeight, clientHeight: viewport.clientHeight,
      scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop,
      screenWidth: window.innerWidth,
    };
  });
}

function aligned(g, size, { fit = true, fitHeight = false } = {}) {
  const tolerance = 2;
  expect(g.field, "sample field overlay exists").toBeTruthy();
  const scale = g.page.width / size.width;
  expect(Math.abs(g.page.height - size.height * scale)).toBeLessThan(tolerance);
  expect(Math.abs(g.canvas.x - g.page.x)).toBeLessThan(tolerance);
  expect(Math.abs(g.canvas.y - g.page.y)).toBeLessThan(tolerance);
  expect(Math.abs(g.canvas.width - g.page.width)).toBeLessThan(tolerance);
  expect(Math.abs(g.canvas.height - g.page.height)).toBeLessThan(tolerance);
  expect(Math.abs(g.field.x - (g.page.x + FIELD.x * scale))).toBeLessThan(tolerance);
  expect(Math.abs(g.field.y - (g.page.y + FIELD.y * scale))).toBeLessThan(tolerance);
  expect(Math.abs(g.field.width - FIELD.width * scale)).toBeLessThan(tolerance);
  if (fit) {
    expect(g.page.x).toBeGreaterThanOrEqual(g.viewport.x + 8);
    expect(g.page.right).toBeLessThanOrEqual(g.viewport.right - 8);
    expect(g.page.y).toBeGreaterThanOrEqual(g.viewport.y + 8);
    if (fitHeight) expect(g.page.bottom).toBeLessThanOrEqual(g.viewport.bottom - 8);
    expect(g.scrollWidth).toBeLessThanOrEqual(g.clientWidth + 1);
    expect(Math.abs((g.page.x - g.viewport.x) - (g.viewport.right - g.page.right)))
      .toBeLessThan(tolerance + 1);
  }
}

async function waitForCanvas(page) {
  await expect.poll(async () => {
    const g = await measure(page);
    return Math.max(
      Math.abs(g.canvas.width - g.page.width),
      Math.abs(g.canvas.height - g.page.height),
    );
  }).toBeLessThan(2);
}

async function expectPdfInk(page, number, size) {
  await expect.poll(() => page.locator(`canvas[aria-label="PDF page ${number}"]`)
    .evaluate((canvas, { size, field }) => {
      if (!canvas.width || !canvas.clientWidth) return false;
      const pixel = canvas.getContext("2d").getImageData(
        Math.round(canvas.width / size.width * (field.x + 8)),
        Math.round(canvas.height / size.height * (field.y + 8)), 1, 1,
      ).data;
      return pixel[0] > 200 && pixel[1] < 80 && pixel[3] > 200;
    }, { size, field: FIELD })).toBe(true);
}

for (const width of [1440, 390]) {
  test(`direct async preview fits portrait and landscape at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await mount(page, request);
    await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Built-in fields" })).toHaveCount(0);
    if (width === 1440) {
      const { viewport, screenWidth } = await measure(page);
      // A hidden editor sidebar must not leave its 260/300px grid tracks behind.
      expect(viewport.width).toBeGreaterThan(screenWidth * 0.9);
    }
    for (const [number, size] of [[1, SIZE.portrait], [2, SIZE.landscape]]) {
      await page.getByRole("combobox", { name: "Page" }).selectOption(String(number));
      await page.getByRole("combobox", { name: "Zoom" }).selectOption("fit-page");
      await expect.poll(async () => (await measure(page)).page.width).toBeLessThan(width);
      await expect(page.locator(`canvas[aria-label="PDF page ${number}"]`)).toBeVisible();
      await waitForCanvas(page);
      await expectPdfInk(page, number, size);
      aligned(await measure(page), size, { fitHeight: true });
    }
    await page.screenshot({ path: `/tmp/task-4804-preview-${width}.png`, fullPage: true });
    expect(state.unexpected).toEqual([]);
    expect(state.errors).toEqual([]);
  });
}

test("draft edit toggle, parent-only resize, and manual zoom scroll keep PDF coordinates aligned", async ({ page, request }) => {
  const state = await mount(page, request, { direct: false });
  await expect(page.getByRole("heading", { name: "Built-in fields" })).toBeVisible();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Built-in fields" })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Zoom" }).selectOption("fit-width");
  await waitForCanvas(page);
  aligned(await measure(page), SIZE.portrait);
  // Resize only the designer's parent; window.resize is deliberately not fired.
  await page.getByTestId("certificate-viewport").evaluate(el => { el.parentElement.style.width = "650px"; });
  await expect.poll(async () => (await measure(page)).page.width).toBeLessThan(600);
  await waitForCanvas(page);
  aligned(await measure(page), SIZE.portrait);
  await page.getByRole("combobox", { name: "Zoom" }).selectOption("2");
  await expect.poll(async () => (await measure(page)).page.width).toBeGreaterThan(1200);
  await waitForCanvas(page);
  const before = await measure(page);
  expect(before.scrollWidth).toBeGreaterThan(before.clientWidth);
  await page.getByTestId("certificate-viewport").evaluate(el => { el.scrollLeft = 180; el.scrollTop = 120; });
  await expect.poll(async () => (await measure(page)).scrollLeft).toBeGreaterThan(100);
  aligned(await measure(page), SIZE.portrait, { fit: false });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Built-in fields" })).toBeVisible();
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("active template opens preview-only with no editing actions", async ({ page, request }) => {
  const state = await mount(page, request, { active: true, direct: false });
  await expect(page.getByRole("heading", { name: "Built-in fields" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  const geometry = await measure(page);
  expect(geometry.viewport.width).toBeGreaterThan(geometry.screenWidth * 0.9);
  aligned(geometry, SIZE.portrait);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("points preview preserves persisted styling and shrinks the complete suffix", async ({ page, request }) => {
  const savedPoints = serializeCertificatePlaceholder({
    ...FIELD, id: 'default', y: 220, key: 'cpd.cpd_points', sample: '', default_value: 6.5,
    field_type: 'number', number_format: 'number:2', font_family: 'Helvetica',
  });
  const pdfValue = layoutPlaceholder(savedPoints, {}).value;
  expect(pdfValue).toBe('6.50 points');
  const state = await mount(page, request, { fields: [
    { ...FIELD, key: 'cpd.cpd_points', sample: 8, width: 90, height: 40,
      font_family: 'Courier', font_style: 'bolditalic', font_size: 24, color: '#123456', align: 'center', shrink_to_fit: true },
    { ...FIELD, id: 'zero', y: 160, key: 'cpd.cpd_points', sample: 0 },
    { ...savedPoints, id: 'default' },
    { ...FIELD, id: 'missing', y: 280, key: 'cpd.cpd_points', sample: '' },
  ] });
  await page.getByRole('combobox', { name: 'Zoom' }).selectOption('1');
  const text = page.getByTestId('certificate-page').getByText('8 points', { exact: true });
  await expect(text).toHaveText('8 points');
  await expect(text).toHaveCSS('font-family', 'Courier');
  await expect(text).toHaveCSS('font-weight', '700');
  await expect(text).toHaveCSS('font-style', 'italic');
  await expect(text).toHaveCSS('color', 'rgb(18, 52, 86)');
  await expect(text).toHaveCSS('text-align', 'center');
  await expect.poll(() => text.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeLessThan(24);
  expect(await text.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBeTruthy();
  await expect(page.getByText('0 points', { exact: true })).toBeVisible();
  await expect(page.getByText(pdfValue, { exact: true })).toBeVisible();
  await expect(page.getByText('Missing: Member full name', { exact: true })).toBeVisible();
  await page.screenshot({ path: '/tmp/task-4808-points-preview.png', fullPage: true });
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});