import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const OUTPUT = "tests/task-4666-portal-lifecycle-comparison.json";
const CRITICAL_DELAY_MS = 200;
const REPETITIONS = 3;
const member = {
  id: "fixture-member",
  tenant_id: "fixture-tenant",
  role_id: "fixture-role",
  email: "fixture@example.invalid",
  first_name: "Fixture",
  member_excluded_features: [],
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function replaceExactlyOnce(body, before, after, label) {
  const occurrences = body.split(before).length - 1;
  if (occurrences !== 1) {
    throw new Error(`${label}: expected one transformed-module match, found ${occurrences}`);
  }
  return body.replace(before, after);
}

async function installOriginalLifecycle(page) {
  await page.route("**/src/lib/viewerSessionPreload.js*", async route => {
    const response = await route.fetch();
    let body = await response.text();
    body = replaceExactlyOnce(
      body,
      "  hostname,\n  authRevision,",
      "  hostname,\n  pathname,\n  authRevision,",
      "viewer session arguments",
    );
    body = replaceExactlyOnce(
      body,
      "return `${tenant}:${authRevision}`;",
      "return `${tenant}:${pathname}:${authRevision}`;",
      "viewer session scope",
    );
    await route.fulfill({ response, body });
  });

  await page.route("**/src/pages/Layout.jsx*", async route => {
    const response = await route.fetch();
    let body = await response.text();
    body = replaceExactlyOnce(
      body,
      "hostname: window.location.hostname,\n    authRevision",
      "hostname: window.location.hostname,\n    pathname: location.pathname,\n    authRevision",
      "Layout viewer session arguments",
    );
    body = replaceExactlyOnce(
      body,
      "}, [authRevision, viewerSessionScope]);",
      "}, [location.pathname, authRevision, viewerSessionScope]);",
      "Layout auth dependencies",
    );
    await route.fulfill({ response, body });
  });
}

async function installFixture(page, variant) {
  const requests = [];
  if (variant === "original-lifecycle") await installOriginalLifecycle(page);
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
    window.__portalLoadingFallback = { count: 0, visible: false };
    setInterval(() => {
      const visible = [...document.querySelectorAll('[role="status"]')].some(element => {
        if (!element.textContent?.includes("Loading portal")) return false;
        const style = getComputedStyle(element);
        return element.getClientRects().length > 0
          && style.visibility !== "hidden"
          && style.display !== "none"
          && style.opacity !== "0";
      });
      const state = window.__portalLoadingFallback;
      if (visible && !state.visible) state.count += 1;
      state.visible = visible;
    }, 10);
  });
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (!path.startsWith("/api/")) return route.continue();
    if (!["GET", "HEAD"].includes(route.request().method())) {
      return route.fulfill({ status: 405, json: { error: "Read-only fixture" } });
    }
    const key = path === "/api/auth/me" ? "auth"
      : path.includes("tenant-branding") ? "branding"
      : path.includes("/page/") ? "page"
      : path.includes("/Role/") ? "role"
      : url.searchParams.get("key") === "page_visibility_settings" ? "visibility" : "";
    const entry = { path: path + url.search, key, start: Date.now() };
    requests.push(entry);
    if (key) await delay(CRITICAL_DELAY_MS);
    let body = [];
    if (path === "/api/auth/me") body = member;
    else if (path === "/api/auth/tenant-user-me") body = { authenticated: false };
    else if (path.includes("/Role/")) {
      body = {
        id: member.role_id,
        tenant_id: member.tenant_id,
        name: "Fixture role",
        excluded_features: [],
      };
    } else if (path === "/api/entities/Member") body = [member];
    else if (path.includes("tenant-branding")) {
      body = {
        success: true,
        branding: {
          id: member.tenant_id,
          name: "Portal lifecycle comparison",
          headerConfig: {},
          footerConfig: {},
          platformBranding: { enabled: false },
        },
      };
    } else if (path.includes("microsites")) body = { microsites: [] };
    else if (path.includes("/page/")) {
      const slug = path.split("/").pop();
      body = {
        success: true,
        page: {
          id: slug,
          slug,
          title: "Fixture portal",
          status: "published",
          builder_type: "canvas",
          layout_type: "hybrid",
          public_chrome: "none",
          canvas_design: {
            version: 1,
            root: {
              groups: [],
              guides: { vertical: [], horizontal: [] },
              sections: [{
                id: "section",
                type: "section",
                children: [{
                  id: "copy",
                  type: "custom-html",
                  geom: { x: 0, y: 0, w: 800, h: 180 },
                  style: { opacity: 1 },
                  content: { html: `<h1>Fixture content ${slug}</h1>` },
                }],
              }],
            },
          },
        },
        elements: [],
        symbols: [],
      };
    } else if (path.includes("unread")) {
      body = { unread_count: 0, conversations: [] };
    }
    entry.end = Date.now();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  return requests;
}

function requestCounts(requests) {
  return {
    auth: requests.filter(request => request.key === "auth").length,
    role: requests.filter(request => request.key === "role").length,
    page: requests.filter(request => request.key === "page").length,
  };
}

async function measureStep(page, requests, name, action, heading) {
  const requestOffset = requests.length;
  const fallbackBefore = await page.evaluate(
    () => window.__portalLoadingFallback?.count || 0,
  ).catch(() => 0);
  const started = Date.now();
  await action();
  await expect(page.getByRole("heading", { name: heading, exact: true }))
    .toBeVisible({ timeout: 100_000 });
  const visibleContentMs = Date.now() - started;
  await page.waitForTimeout(30);
  const fallbackAfter = await page.evaluate(
    () => window.__portalLoadingFallback?.count || 0,
  );
  const stepRequests = requests.slice(requestOffset);
  return {
    name,
    visibleContentMs,
    loadingFallbackAppearances: Math.max(0, fallbackAfter - fallbackBefore),
    requests: requestCounts(stepRequests),
  };
}

async function runSequence(browser, baseURL, variant) {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  const requests = await installFixture(page, variant);
  const steps = [];
  try {
    steps.push(await measureStep(
      page,
      requests,
      "cold-document",
      () => page.goto("/portal", { waitUntil: "domcontentloaded" }),
      "Fixture content portal",
    ));
    steps.push(await measureStep(
      page,
      requests,
      "same-context-reload",
      () => page.reload({ waitUntil: "domcontentloaded" }),
      "Fixture content portal",
    ));
    steps.push(await measureStep(
      page,
      requests,
      "navigate-forward",
      () => page.evaluate(() => {
        history.pushState({}, "", "/portal-next");
        window.dispatchEvent(new PopStateEvent("popstate"));
      }),
      "Fixture content portal-next",
    ));
    steps.push(await measureStep(
      page,
      requests,
      "browser-back",
      () => page.goBack({ waitUntil: "domcontentloaded" }),
      "Fixture content portal",
    ));
    steps.push(await measureStep(
      page,
      requests,
      "browser-forward",
      () => page.goForward({ waitUntil: "domcontentloaded" }),
      "Fixture content portal-next",
    ));
    return { steps, totals: requestCounts(requests) };
  } finally {
    await context.close();
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function summarize(runs) {
  return runs[0].steps.map((step, index) => ({
    name: step.name,
    medianVisibleContentMs: median(runs.map(run => run.steps[index].visibleContentMs)),
    medianLoadingFallbackAppearances: median(
      runs.map(run => run.steps[index].loadingFallbackAppearances),
    ),
    medianRequests: {
      auth: median(runs.map(run => run.steps[index].requests.auth)),
      role: median(runs.map(run => run.steps[index].requests.role)),
      page: median(runs.map(run => run.steps[index].requests.page)),
    },
  }));
}

test("matched original and current portal lifecycle comparison", async ({ browser }, testInfo) => {
  const baseURL = testInfo.project.use.baseURL;
  // Prime Vite transforms before measuring either lifecycle.
  for (const variant of ["original-lifecycle", "current-lifecycle"]) {
    const warmContext = await browser.newContext({ baseURL });
    const warmPage = await warmContext.newPage();
    await installFixture(warmPage, variant);
    await warmPage.goto("/portal", { waitUntil: "domcontentloaded" });
    await expect(warmPage.getByRole("heading", { name: "Fixture content portal", exact: true }))
      .toBeVisible({ timeout: 100_000 });
    await warmContext.close();
  }

  const variants = {};
  for (const variant of ["original-lifecycle", "current-lifecycle"]) {
    const runs = [];
    for (let repetition = 0; repetition < REPETITIONS; repetition += 1) {
      runs.push(await runSequence(browser, baseURL, variant));
    }
    variants[variant] = { runs, summary: summarize(runs) };
  }

  const report = {
    measuredAt: new Date().toISOString(),
    environment: "same already-running development preview with controlled API interception; not production",
    criticalFixtureDelayMs: CRITICAL_DELAY_MS,
    repetitions: REPETITIONS,
    restoration: "Original pathname-scoped session lifecycle restored only in transformed browser modules",
    variants,
  };
  mkdirSync("test-results", { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
  await testInfo.attach("lifecycle-comparison", {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json",
  });

  const originalNavigation = variants["original-lifecycle"].summary.slice(2);
  const currentNavigation = variants["current-lifecycle"].summary.slice(2);
  expect(originalNavigation.every(step => step.medianRequests.auth === 1)).toBe(true);
  expect(currentNavigation.every(step => step.medianRequests.auth === 0)).toBe(true);
  expect(
    currentNavigation.every(step => step.medianLoadingFallbackAppearances === 0),
  ).toBe(true);
});