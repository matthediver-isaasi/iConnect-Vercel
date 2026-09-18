import { expect } from "@playwright/test";

export const FORM_SLUG = "task-4526-picker-form";
export const PAGE_SLUG = "task-4526-picker-canvas";
export const TYPES = ["standard", "category", "organisation", "relationship", "country", "multicountry"];
const options = Array.from({ length: 40 }, (_, i) => `Fixture option ${String(i + 1).padStart(2, "0")}`);

export function pickerForm({ kind = "standard", tall = false, upper = false } = {}) {
  const types = {
    standard: { type: "dropdown", options },
    category: { type: "category_dropdown", category_id: "fixture-category" },
    organisation: { type: "organisation_dropdown" },
    relationship: { type: "relationship_dropdown", parent_field_id: "parent", relationship_definition_id: "fixture-relationship" },
    "relationship-multi": { type: "relationship_dropdown", parent_field_id: "parent", relationship_definition_id: "fixture-relationship", selection_mode: "multiple" },
    country: { type: "country" },
    multicountry: { type: "countries" },
  };
  return {
    id: "task-4526-form",
    slug: FORM_SLUG,
    name: "Picker geometry fixture",
    description: "Isolated browser fixture. No submissions.",
    form_type: "application",
    layout_type: "standard",
    require_authentication: false,
    is_active: true,
    prefill_source: "none",
    pages: [],
    fields: [
      ...(kind.startsWith("relationship") ? [{
        id: "parent", type: "dropdown", label: "Relationship parent",
        options: ["parent-one"], default_value: "parent-one",
      }] : []),
      ...(tall && !upper ? Array.from({ length: 12 }, (_, i) => ({
        id: `text-${i}`, type: "text", label: `Spacing field ${i + 1}`,
      })) : []),
      { id: "picker", label: "Fixture picker", ...types[kind] },
      ...(tall && upper ? Array.from({ length: 12 }, (_, i) => ({
        id: `text-${i}`, type: "text", label: `Spacing field ${i + 1}`,
      })) : []),
    ],
    visibility_rules: [],
    entity_pipelines: { members: [], organisations: [] },
    structured_actions: { version: 1, actions: [] },
    submit_button_text: "Do not submit",
  };
}

function block(id, type, y, h, content) {
  const geom = { x: 40, y, w: 920, h };
  return {
    id, type, geom,
    bp: { desktop: geom, tablet: { x: 24, y, w: 720, h }, mobile: { x: 8, y, w: 359, h } },
    content, style: {},
  };
}

function canvasPage() {
  return {
    id: "task-4526-page", slug: PAGE_SLUG, name: "Picker Canvas fixture",
    status: "published", builder_type: "canvas", public_chrome: "none",
    canvas_design: { version: 1, root: { sections: [{ id: "root", children: [
      block("picker-intro", "text", 40, 60, { html: "<h1>Picker sizing fixture</h1>" }),
      ...[160, 760].map((y, i) => block(`picker-form-${i}`, "form-embed", y, 420, {
        formSlug: FORM_SLUG, mode: "iframe", title: `Picker form ${i + 1}`,
      })),
      block("picker-downstream", "text", 1360, 80, { html: "<h2>Downstream fixture content</h2>" }),
    ] }] } },
  };
}

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

export async function installPickerFixture(page, fixture = {}) {
  const baseURL = process.env.PLAYWRIGHT_BASE_URL
    || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "http://127.0.0.1:5000");
  const origin = new URL(baseURL).origin;
  const state = { blockedWrites: [], pageErrors: [], optionReads: [] };
  page.on("pageerror", error => state.pageErrors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("cookie-consent", "declined");
    window.__fixtureResizeMessages = [];
    window.addEventListener("message", event => {
      if (event.data?.type?.startsWith("iconn-form")) {
        window.__fixtureResizeMessages.push({ ...event.data });
      }
    });
  });
  // Fail closed: nothing except local GET assets and explicit fixture handlers
  // can reach the network. Option POSTs below are intercepted read operations.
  await page.context().route("**/*", route => {
    const request = route.request();
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      state.blockedWrites.push(`${request.method()} ${request.url()}`);
      return json(route, { error: "Fixture blocks every unhandled write" }, 599);
    }
    if (new URL(request.url()).origin !== origin) return route.abort();
    return route.continue();
  });
  await page.context().route(/\/(?:rest|auth)\/v1\//, route => {
    if (!["GET", "HEAD", "OPTIONS"].includes(route.request().method())) {
      state.blockedWrites.push(`${route.request().method()} ${route.request().url()}`);
      return json(route, { error: "Fixture blocks database writes" }, 599);
    }
    return json(route, []);
  });
  if (page.context().routeWebSocket) {
    await page.context().routeWebSocket(/.*/, socket => socket.close());
  }
  await page.context().route("**/api/**", route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    if (path === "/api/public/organisations" && request.method() === "POST") {
      const body = request.postDataJSON();
      if (body.formSlug === FORM_SLUG && body.fieldId === "picker") {
        state.optionReads.push(path);
        return json(route, options.map((name, i) => ({ id: `org-${i}`, name })));
      }
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      state.blockedWrites.push(`${request.method()} ${path}`);
      return json(route, { error: "Fixture blocks every unhandled write" }, 599);
    }
    if (path === `/api/public/form/${FORM_SLUG}`) return json(route, pickerForm(fixture));
    if (path === `/api/public/form/${FORM_SLUG}/relationship-options`) {
      state.optionReads.push(path);
      return json(route, options.map((label, i) => ({ id: `related-${i}`, label })));
    }
    if (path === "/api/public/resource-categories") {
      return json(route, [{ id: "fixture-category", name: "Fixture category", subcategories: options }]);
    }
    if (path === `/api/public/page/${PAGE_SLUG}`) return json(route, { page: canvasPage(), elements: [], symbols: [] });
    if (path === "/api/auth/me") return json(route, null, 401);
    if (path === "/api/auth/tenant-user-me") return json(route, { user: null }, 401);
    if (path === "/api/public/microsites") return json(route, { microsites: [] });
    if (path === "/api/public/tenant-branding") return json(route, {
      success: true, branding: { name: "Picker fixture", primaryColor: "#155e75", footerSource: "standard" },
    });
    return json(route, []);
  });
  return state;
}

export function triggerIn(frame) {
  return frame.locator('button[role="combobox"]').last();
}

export async function openCanvas(page) {
  await page.goto(`/${PAGE_SLUG}`);
  await expect(page.locator('[data-testid="iframe-form-embed"]')).toHaveCount(2);
  const frame = page.frameLocator('[data-testid="iframe-form-embed"]').first();
  await expect(triggerIn(frame)).toBeVisible();
  // Settle intrinsic ResizeObserver reporting before taking the baseline.
  await page.waitForTimeout(350);
  return frame;
}

export async function canvasMetrics(page) {
  return page.evaluate(() => {
    const rect = element => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, bottom: box.bottom };
    };
    const frames = [...document.querySelectorAll('[data-testid="iframe-form-embed"]')].map(iframe => ({
      ...rect(iframe),
      docTop: iframe.getBoundingClientRect().top + scrollY,
      intrinsic: iframe.contentDocument.querySelector("[data-form-embed-content]")?.getBoundingClientRect().height,
    }));
    return {
      frames, scrollY, viewport: { width: innerWidth, height: innerHeight },
      downstream: document.querySelector('[data-cb="picker-downstream"]').getBoundingClientRect().top + scrollY,
      stageHeight: document.querySelector(".canvas-stage").getBoundingClientRect().height,
    };
  });
}

export async function pickerMetrics(frame) {
  return frame.locator("body").evaluate(() => {
    const rect = element => {
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right };
    };
    const trigger = [...document.querySelectorAll('[role="combobox"]')].find(e => e.tagName === "BUTTON" && e.getAttribute("aria-expanded") === "true");
    const menu = document.querySelector('[role="dialog"][data-state="open"], [data-form-picker-menu], [role="listbox"][data-state="open"]');
    return {
      trigger: rect(trigger), menu: rect(menu),
      innerHeight, scrollY, docHeight: document.documentElement.scrollHeight,
      intrinsic: document.querySelector("[data-form-embed-content]")?.getBoundingClientRect().height,
      side: menu?.getAttribute("data-side"),
      dialog: menu?.getAttribute("role") === "dialog" && !menu?.hasAttribute("data-form-picker-menu"),
      scrollable: menu ? [...menu.querySelectorAll("*")].some(element => (
        element.scrollHeight > element.clientHeight + 2 && ["auto", "scroll"].includes(getComputedStyle(element).overflowY)
      )) : false,
    };
  });
}

export async function installExternalHost(page, { height = 320 } = {}) {
  const baseURL = process.env.PLAYWRIGHT_BASE_URL
    || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "http://127.0.0.1:5000");
  // A genuinely different origin, fulfilled entirely by Playwright; no DNS or
  // external request is made. No host resizing implementation is assumed.
  await page.context().route("https://picker-host.invalid/", route => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><style>body{margin:0;font:16px system-ui}iframe{width:100%;height:${height}px;border:0}</style>
      <h1>External host fixture</h1>
      <iframe title="External form" src="${baseURL}/embed/form/${FORM_SLUG}"></iframe>
      <p>External downstream content</p>`,
  }));
  await page.goto("https://picker-host.invalid/");
  const frame = page.frameLocator("iframe");
  await expect(triggerIn(frame)).toBeVisible();
  return frame;
}

export async function simulateVisualViewport(page, { height, offsetTop = 0 }) {
  await page.evaluate(({ height, offsetTop }) => {
    if (!window.__fixtureVisualViewport) {
      const visual = new EventTarget();
      Object.assign(visual, { width: innerWidth, height, offsetTop, offsetLeft: 0, scale: 1 });
      Object.defineProperty(window, "visualViewport", { configurable: true, value: visual });
      window.__fixtureVisualViewport = visual;
    }
    Object.assign(window.__fixtureVisualViewport, { height, offsetTop, width: innerWidth });
    window.__fixtureVisualViewport.dispatchEvent(new Event("resize"));
    window.__fixtureVisualViewport.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
  }, { height, offsetTop });
}

export async function settleMenu(frame) {
  await expect(frame.locator('[role="listbox"], [role="dialog"]').last()).toBeVisible();
  await frame.locator("body").evaluate(async () => {
    await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {})));
  });
}