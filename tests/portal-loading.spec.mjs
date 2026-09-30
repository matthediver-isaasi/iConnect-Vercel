import { test, expect } from "@playwright/test";
import { writeFileSync } from "node:fs";

// Controlled fixtures only: these are not live-tenant performance measurements.
const member = { id: "fixture-member", tenant_id: "fixture-tenant", role_id: "fixture-role", email: "fixture@example.invalid", first_name: "Fixture", member_excluded_features: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function installOriginalSessionLifecycle(page) {
  if (process.env.PORTAL_SESSION_LIFECYCLE_VARIANT !== "original") return;

  await page.route("**/src/lib/viewerSessionPreload.js*", async route => {
    const response = await route.fetch();
    let body = await response.text();
    const original = body;
    body = body
      .replace("  hostname,\n  authRevision", "  hostname,\n  pathname,\n  authRevision")
      .replace("return `${tenant}:${authRevision}`;", "return `${tenant}:${pathname}:${authRevision}`;");
    if (body === original || !body.includes("`${tenant}:${pathname}:${authRevision}`")) {
      throw new Error("Could not install original viewer-session scope in transformed module");
    }
    await route.fulfill({ response, body });
  });

  await page.route("**/src/pages/Layout.jsx*", async route => {
    const response = await route.fetch();
    let body = await response.text();
    const original = body;
    body = body
      .replace(
        "hostname: window.location.hostname,\n    authRevision",
        "hostname: window.location.hostname,\n    pathname: location.pathname,\n    authRevision",
      )
      .replace(
        "}, [authRevision, viewerSessionScope]);",
        "}, [location.pathname, authRevision, viewerSessionScope]);",
      );
    if (body === original
      || !body.includes("pathname: location.pathname")
      || !body.includes("[location.pathname, authRevision, viewerSessionScope]")) {
      throw new Error("Could not install original Layout auth lifecycle in transformed module");
    }
    await route.fulfill({ response, body });
  });
}

async function fixture(page, { hold = "", audience = "member", fail = "" } = {}) {
  const requests = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
    window.__portalFirstVisibleShellMs = null;
    const timer = setInterval(() => {
      const sidebar = document.querySelector('[data-sidebar="sidebar"]');
      if (!sidebar || !sidebar.getClientRects().length) return;
      for (let element = sidebar; element; element = element.parentElement) {
        const style = getComputedStyle(element);
        if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return;
      }
      window.__portalFirstVisibleShellMs = performance.now();
      clearInterval(timer);
    }, 16);
  });
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (!path.startsWith("/api/")) return route.continue();
    const key = path === "/api/auth/me" ? "auth"
      : path.includes("tenant-branding") ? "branding"
      : path.includes("/page/") ? "page"
      : path.includes("/Role/") ? "role"
      : url.searchParams.get("key") === "page_visibility_settings" ? "visibility" : "";
    const entry = { path: path + url.search, key, start: Date.now() };
    requests.push(entry);
    if (!["GET", "HEAD"].includes(route.request().method())) {
      return route.fulfill({ status: 405, json: { error: "Read-only fixture" } });
    }
    if (hold && key === hold) await gate;
    if (key) await delay(200);
    let body = [];
    let status = fail && key === fail ? 503 : 200;
    if (path === "/api/auth/me") { body = audience === "member" ? member : null; status = audience === "guest" ? 401 : status; }
    else if (path === "/api/auth/tenant-user-me") body = { authenticated: false };
    else if (path.includes("/Role/")) body = { id: member.role_id, tenant_id: member.tenant_id, name: "Fixture role", excluded_features: [] };
    else if (path === "/api/entities/Member") body = [member];
    else if (path.includes("tenant-branding")) body = { success: true, branding: { id: member.tenant_id, name: "Portal measurement fixture", headerConfig: {}, footerConfig: {}, platformBranding: { enabled: false } } };
    else if (path.includes("microsites")) body = { microsites: [] };
    else if (path.includes("/page/")) {
      const slug = path.split("/").pop();
      body = { success: true, page: {
        id: slug, slug, title: "Fixture portal", status: "published", builder_type: "canvas", layout_type: "hybrid", public_chrome: "none",
        canvas_design: { version: 1, root: { groups: [], guides: { vertical: [], horizontal: [] }, sections: [{ id: "section", type: "section", children: [{
          id: "copy", type: "custom-html", geom: { x: 0, y: 0, w: 800, h: 180 },
          style: { opacity: 1 },
          content: { html: `<h1>Fixture content ${slug}</h1><a href="/portal-next">Next fixture page</a>` },
        }] }] } },
      }, elements: [], symbols: [] };
    } else if (path.includes("unread")) body = { unread_count: 0, conversations: [] };
    entry.end = Date.now();
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  return { requests, release };
}

test("controlled portal cold, warm and internal navigation timings", async ({ page }, testInfo) => {
  await installOriginalSessionLifecycle(page);
  const state = await fixture(page);
  const results = [];
  for (const mode of ["cold", "warm", "internal"]) {
    const start = Date.now();
    const requestOffset = state.requests.length;
    if (mode === "cold") await page.goto("/portal", { waitUntil: "domcontentloaded" });
    else if (mode === "warm") await page.reload({ waitUntil: "domcontentloaded" });
    else await page.evaluate(() => { history.pushState({}, "", "/portal-next"); window.dispatchEvent(new PopStateEvent("popstate")); });
    await expect(page.getByRole("heading", { name: mode === "internal" ? "Fixture content portal-next" : "Fixture content portal", exact: true })).toBeVisible({ timeout: 100_000 });
    const visibleContentMs = Date.now() - start;
    const firstVisibleShellMs = mode === "internal" ? null : await page.evaluate(() => window.__portalFirstVisibleShellMs);
    results.push({ mode, visibleContentMs, firstVisibleShellMs, requests: state.requests.slice(requestOffset).map(r => ({ ...r, start: r.start - start, end: r.end && r.end - start })) });
  }
  const report = {
    label: process.env.PORTAL_MEASUREMENT_LABEL || "current",
    lifecycleVariant: process.env.PORTAL_SESSION_LIFECYCLE_VARIANT || "current",
    fixtureDelayMs: 200,
    environment: "already-running development preview; API interception; not production",
    results,
  };
  writeFileSync(`/tmp/portal-loading-${report.label}.json`, JSON.stringify(report, null, 2));
  await testInfo.attach("controlled-timings", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
  await page.screenshot({ path: `/tmp/portal-loading-${report.label}.png` });
});

for (const hold of ["auth", "branding", "page", "role", "visibility"]) {
  test(`slow ${hold} does not reveal content before prerequisites settle`, async ({ page }) => {
    const state = await fixture(page, { hold });
    await page.goto("/portal", { waitUntil: "domcontentloaded" });
    await expect.poll(() => state.requests.some(r => r.key === hold), { timeout: 100_000 }).toBe(true);
    await delay(350);
    await expect(page.getByRole("heading", { name: "Fixture content portal", exact: true })).not.toBeVisible();
    state.release();
    await expect(page.getByRole("heading", { name: "Fixture content portal", exact: true })).toBeVisible({ timeout: 30_000 });
  });
}

for (const fail of ["branding", "page", "role", "visibility"]) {
  test(`failed ${fail} fails closed with visible feedback`, async ({ page }) => {
    const state = await fixture(page, { fail });
    await page.goto("/portal", { waitUntil: "domcontentloaded" });
    await expect.poll(() => state.requests.some(r => r.key === fail && r.end), { timeout: 30_000 }).toBe(true);
    await expect(page.getByRole("heading", { name: "Fixture content portal", exact: true })).not.toBeVisible();
    await expect(page.getByRole("alert").first()).toBeVisible({ timeout: 15_000 });
  });
}

test("guest hybrid page never mounts portal sidebar", async ({ page }) => {
  await fixture(page, { audience: "guest" });
  await page.goto("/portal", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Fixture content portal", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-sidebar="sidebar"]')).toHaveCount(0);
});

test("failed authentication cannot reveal member sidebar", async ({ page }) => {
  const state = await fixture(page, { fail: "auth" });
  await page.goto("/portal", { waitUntil: "domcontentloaded" });
  await expect.poll(() => state.requests.some(r => r.key === "auth" && r.end)).toBe(true);
  await delay(500);
  await expect(page.locator('[data-sidebar="sidebar"]')).toHaveCount(0);
});