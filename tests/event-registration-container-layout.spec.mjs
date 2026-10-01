import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import fs from "node:fs";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import {
  LARGE_SPEAKERS,
  complexEvent,
  complexSessions,
  initializeTask4629Page,
  simpleEvent,
  sponsorPayload,
} from "./fixtures/task-4629-event-display.fixture.mjs";

// Same real-experience/esbuild harness as task 4629. Data/payment/realtime
// dependencies are isolated; no app server, credentials, tenant, or DB is used.
// Unlike the original display suite, keep the actual imported CSS bundle.
function resolveSource(base) {
  for (const candidate of [
    base, `${base}.jsx`, `${base}.js`, `${base}.mjs`, `${base}.ts`, `${base}.tsx`,
    path.join(base, "index.jsx"), path.join(base, "index.js"),
    path.join(base, "index.mjs"), path.join(base, "index.ts"), path.join(base, "index.tsx"),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return base;
}

const stubs = {
  "@/api/base44Client": `
    const empty = async () => [];
    const entity = { list: empty, filter: empty, get: async () => null };
    export const base44 = {
      entities: new Proxy({}, { get: () => entity }),
      functions: { invoke: async () => ({ data: [] }) },
    };
  `,
  "@/api/publicClient": `
    const state = () => window.__task4629;
    const current = id => structuredClone(state().events[id]);
    export const publicClient = {
      getComplexEvent: async id => current(id),
      getComplexEventBySlug: async slug => current(slug),
      getComplexEventSessions: async () => window.__layoutSessions,
      listSpeakers: async ids => window.__task4629Speakers.filter(item => ids.includes(item.id)),
      listSystemSettings: async () => [],
      getEventSponsors: async () => window.__task4629Sponsors,
      getEventAllocationContext: async () => null,
      checkMemberEmail: async () => ({ is_member: false }),
    };
  `,
  "@/api/supabaseClient": `
    const result = { data: [], error: null };
    const chain = new Proxy({}, {
      get(_target, key) {
        if (key === "then") return resolve => resolve(result);
        if (["insert", "update", "upsert", "delete", "rpc"].includes(key)) {
          return () => { throw new Error("Layout fixture rejects database writes"); };
        }
        return () => chain;
      },
    });
    export const isSupabaseConfigured = false;
    export const supabase = { from: () => chain, channel: () => chain, removeChannel: () => {} };
  `,
  "@/hooks/useEventsData": `
    import { useQuery } from "@tanstack/react-query";
    export function useEventData(id) {
      return useQuery({
        queryKey: ["fixture-simple-event", id],
        queryFn: async () => structuredClone(window.__task4629.events[id]),
        enabled: !!id,
      });
    }
    export function useEventDataBySlug() { return { data: null, isLoading: false }; }
    export function useMyGroupIds() { return { data: [], isFetched: true }; }
  `,
  "@/hooks/useMemberAccess": `
    export const useMemberAccess = () => ({
      memberInfo: null, organizationInfo: null, memberRole: null,
      authResolved: true, isAdmin: false, isFeatureExcluded: () => false,
      reloadMemberInfo: async () => {}, refreshOrganizationInfo: async () => {},
    });
  `,
  "@/hooks/useSpeakerModuleName": `
    export const useSpeakerModuleName = () => ({ singular: "Speaker", plural: "Speakers" });
  `,
  "@/hooks/useEventSeatRealtime": `export const useEventSeatRealtime = () => ({ isConnected: false });`,
  "@/hooks/useTicketAvailabilityRealtime": `
    export const useTicketAvailabilityRealtime = () => ({
      isConnected: false, ticketClassAvailability: {}, getTicketClassAvailability: () => null,
    });
  `,
  "@/hooks/useComplexEventTicketAvailabilityRealtime": `
    export const useComplexEventTicketAvailabilityRealtime = () => ({
      isConnected: false, getTicketClassAvailability: () => null,
    });
  `,
  "@/components/booking/PaymentOptions": `
    export default function FixturePaymentOptions() {
      return <div data-testid="fixture-payment-controls">Isolated payment controls</div>;
    }
  `,
  "@/components/booking/ColleagueSelector": `export default function ColleagueSelector() { return null; }`,
  "@/components/booking/AttendeeOptionsSelector": `export default function AttendeeOptionsSelector() { return null; }`,
  "@/components/bookmarks/BookmarkButton": `export default function BookmarkButton() { return null; }`,
  "@/components/tour/PageTour": `export default function PageTour() { return null; }`,
  "@/components/tour/TourButton": `export default function TourButton() { return null; }`,
};

function fixturePlugin() {
  return {
    name: "isolated-event-registration-container-layout",
    setup(api) {
      api.onResolve({ filter: /(?:^|\/)(PaymentOptions|ColleagueSelector|AttendeeOptionsSelector|PageTour|TourButton|BookmarkButton)$/ }, args => {
        const name = args.path.split("/").pop();
        const key = Object.keys(stubs).find(candidate => candidate.endsWith(`/${name}`));
        return { path: key, namespace: "layout-stub" };
      });
      api.onResolve({ filter: /^@\// }, args => stubs[args.path]
        ? { path: args.path, namespace: "layout-stub" }
        : { path: resolveSource(path.resolve("client/src", args.path.slice(2))) });
      api.onResolve({ filter: /^@shared\// }, args => ({
        path: resolveSource(path.resolve("shared", args.path.slice("@shared/".length))),
      }));
      api.onLoad({ filter: /.*/, namespace: "layout-stub" }, args => ({
        contents: stubs[args.path], loader: "jsx", resolveDir: process.cwd(),
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
        import { BrowserRouter } from "react-router-dom";
        import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
        import { EventDetailsExperience } from "./client/src/pages/EventDetails.jsx";
        import { ComplexEventDetailExperience } from "./client/src/pages/ComplexEventDetail.jsx";
        const queryClient = new QueryClient({
          defaultOptions: { queries: { retry: false, staleTime: Infinity } },
        });
        const Experience = window.__task4629.pageType === "simple"
          ? EventDetailsExperience : ComplexEventDetailExperience;
        createRoot(document.getElementById("root")).render(
          <QueryClientProvider client={queryClient}>
            <BrowserRouter>
              <Experience eventId={window.__task4629.currentEventId} embedded={window.__layoutEmbedded} />
            </BrowserRouter>
          </QueryClientProvider>
        );
      `,
      resolveDir: process.cwd(),
      loader: "jsx",
    },
    bundle: true,
    write: false,
    outfile: "event-registration-container-layout-fixture.js",
    jsx: "automatic",
    plugins: [fixturePlugin()],
    define: { "process.env.NODE_ENV": '"test"', "import.meta.env.DEV": "false" },
  });
  script = result.outputFiles.find(file => file.path.endsWith(".js")).text;
  const importedCss = result.outputFiles.filter(file => file.path.endsWith(".css"))
    .map(file => file.text).join("\n");
  expect(importedCss, "Bundle must include the actual shared container stylesheet")
    .toContain("@container event-registration");
  const utilityCss = (await postcss([tailwindcss({
    content: [
      "client/src/pages/EventDetails.jsx",
      "client/src/pages/ComplexEventDetail.jsx",
      "client/src/components/events/{EventDisclosure,EventSponsorsCard,ComplexEventSchedule}.jsx",
      "client/src/components/ui/{avatar,badge,button,card,checkbox,dialog,input,label,radio-group,tabs,tooltip}.jsx",
    ],
    corePlugins: { preflight: true },
  })]).process("@tailwind base; @tailwind components; @tailwind utilities;", { from: undefined })).css;
  // Put utilities last to also catch accidental viewport-column cascade conflicts.
  css = `${importedCss}\n${utilityCss}`;
});

async function mount(page, { pageType, embedded = true, width = 375 }) {
  // A catch-all blocks every request not fulfilled by the fixture route.
  await page.context().route("**/*", route => route.abort("blockedbyclient"));
  const makeEvent = pageType === "simple" ? simpleEvent : complexEvent;
  const event = makeEvent(`container-${pageType}`);
  await initializeTask4629Page(page, { pageType, event });
  await page.evaluate(({ embedded, width, speakers, sponsors, sessions }) => {
    window.__layoutEmbedded = embedded;
    window.__task4629Speakers = speakers;
    window.__task4629Sponsors = sponsors;
    window.__layoutSessions = sessions;
    const root = document.getElementById("root");
    root.style.width = embedded ? `${width}px` : "100%";
    root.style.maxWidth = "100%";
  }, { embedded, width, speakers: LARGE_SPEAKERS, sponsors: sponsorPayload(), sessions: complexSessions(event.id) });
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(event.title);
  await expect(page.getByTestId("button-speaker-speaker-16")).toBeAttached();
  await expect(pageType === "simple"
    ? page.getByTestId("fixture-payment-controls")
    : page.getByTestId("booking-section")).toBeAttached();
}

test.beforeEach(async ({ page }) => {
  page.__layoutErrors = [];
  page.on("pageerror", error => page.__layoutErrors.push(error.message));
});

test.afterEach(async ({ page }) => {
  expect(page.__layoutErrors, "Real experience must not throw").toEqual([]);
  expect(await page.evaluate(() => window.__task4629?.writes || [])).toEqual([]);
});

async function setEmbedWidth(page, width) {
  await page.locator("#root").evaluate((root, value) => {
    root.style.width = `${value}px`;
    window.scrollTo(0, 0);
  }, width);
}

function gridLocator(page, embedded) {
  return embedded ? page.locator(".event-registration-grid")
    : page.locator("#root .grid").filter({ has: page.getByRole("heading", { level: 1 }) }).first();
}

async function layoutMetrics(page, embedded) {
  return gridLocator(page, embedded).evaluate(grid => {
    const [main, sidebar] = grid.children;
    const metrics = node => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width,
        position: style.position, top: style.top, maxHeight: style.maxHeight,
        overflowY: style.overflowY, paddingRight: style.paddingRight,
        column: style.gridColumn, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
        scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
      };
    };
    const root = grid.closest(".event-registration-embed");
    return {
      tracks: getComputedStyle(grid).gridTemplateColumns.split(/\s+/).length,
      main: metrics(main), sidebar: metrics(sidebar),
      grid: metrics(grid),
      containerType: root ? getComputedStyle(root).containerType : null,
      containerName: root ? getComputedStyle(root).containerName : null,
    };
  });
}

async function expectNoOverflow(page, embedded) {
  const metrics = await layoutMetrics(page, embedded);
  for (const key of ["main", "sidebar", "grid"]) {
    expect(metrics[key].scrollWidth, `${key} horizontal overflow`).toBeLessThanOrEqual(metrics[key].clientWidth + 1);
  }
  const overflow = await page.locator("#root").evaluate(root => ({
    root: root.scrollWidth - root.clientWidth,
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
  expect(overflow.root, "embed/standalone wrapper horizontal overflow").toBeLessThanOrEqual(1);
  expect(overflow.document, "document horizontal overflow").toBeLessThanOrEqual(1);
  expect(overflow.body, "body horizontal overflow").toBeLessThanOrEqual(1);
}

async function expectLayout(page, { embedded = true, desktop = false, pageType }) {
  await expect.poll(async () => (await layoutMetrics(page, embedded)).tracks).toBe(desktop ? 3 : 1);
  const metrics = await layoutMetrics(page, embedded);
  if (embedded) {
    expect(metrics.containerType).toBe("inline-size");
    expect(metrics.containerName).toBe("event-registration");
  }
  if (desktop) {
    // At the document top, a short sticky sidebar can move down to top:16px
    // while a grid-height main is constrained by its containing block.
    expect(Math.abs(metrics.main.y - metrics.sidebar.y)).toBeLessThanOrEqual(pageType === "complex" ? 16 : 1);
    expect(metrics.sidebar.x).toBeGreaterThan(metrics.main.right);
    expect(metrics.main.width).toBeGreaterThan(metrics.sidebar.width * 1.8);
    expect(metrics.main.column).toBe("span 2 / span 2");
  } else {
    expect(Math.abs(metrics.main.x - metrics.sidebar.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics.main.width - metrics.sidebar.width)).toBeLessThanOrEqual(1);
    expect(metrics.sidebar.y).toBeGreaterThanOrEqual(metrics.main.bottom + 31);
    expect(metrics.main.column).toBe("auto");
  }
  if (pageType === "complex") {
    for (const key of ["main", "sidebar"]) {
      expect(metrics[key].position).toBe(desktop ? "sticky" : "static");
      expect(metrics[key].maxHeight).toBe(desktop ? `${page.viewportSize().height - 32}px` : "none");
      expect(metrics[key].overflowY).toBe(desktop ? "auto" : "visible");
      expect(metrics[key].top).toBe(desktop ? "16px" : "auto");
    }
    expect(metrics.main.paddingRight).toBe(desktop ? "8px" : "0px");
    if (desktop) {
      expect(metrics.main.scrollHeight, "Long content must have desktop internal scrolling")
        .toBeGreaterThan(metrics.main.clientHeight);
    } else {
      expect(metrics.main.scrollHeight, "Stacked content must not keep a desktop height clamp")
        .toBeLessThanOrEqual(metrics.main.clientHeight + 1);
    }
  }
  await expectNoOverflow(page, embedded);
}

async function expectNestedTracks(page, selector, tracks) {
  const grids = page.locator(selector);
  expect(await grids.count(), `${selector} must exercise real content`).toBeGreaterThan(0);
  for (const grid of await grids.all()) {
    await expect.poll(() => grid.evaluate(node => getComputedStyle(node).gridTemplateColumns.split(/\s+/).length))
      .toBe(tracks);
  }
}

for (const pageType of ["simple", "complex"]) {
  test(`${pageType}: narrow embed in 1440px viewport stacks, wide resize uses container desktop, shrink resets`, async ({ page }) => {
    await mount(page, { pageType });
    await expectLayout(page, { pageType });
    await expectNestedTracks(page, ".event-registration-speakers", 1);
    if (pageType === "simple") await expectNestedTracks(page, ".event-registration-options", 1);
    await page.screenshot({ path: `/tmp/event-registration-${pageType}-desktop-narrow.png`, fullPage: true });
    // Resizing the browser alone must not activate a fixed-width embed.
    await page.setViewportSize({ width: 1600, height: 900 });
    await expectLayout(page, { pageType });
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const width of [1100, 1023, 1024, 375]) {
      await setEmbedWidth(page, width);
      await expectLayout(page, { pageType, desktop: width >= 1024 });
      if (width === 1100) {
        await expectNestedTracks(page, ".event-registration-speakers", 2);
        if (pageType === "simple") await expectNestedTracks(page, ".event-registration-options", 2);
        await page.screenshot({ path: `/tmp/event-registration-${pageType}-desktop-wide.png`, fullPage: true });
      }
    }
    await expectNestedTracks(page, ".event-registration-speakers", 1);
    if (pageType === "simple") await expectNestedTracks(page, ".event-registration-options", 1);
    await page.screenshot({ path: `/tmp/event-registration-${pageType}-desktop-shrunk.png`, fullPage: true });
  });

  test(`${pageType}: nested speaker, sponsor, and guest-option breakpoints follow 640px/768px container, not viewport`, async ({ page }) => {
    await mount(page, { pageType });
    for (const width of [639, 640, 767, 768, 375]) {
      await setEmbedWidth(page, width);
      await expectLayout(page, { pageType });
      await expectNestedTracks(page, ".event-registration-speakers", width >= 640 ? 2 : 1);
      await expectNestedTracks(page, ".event-sponsors-grid", width >= 768 ? 4 : width >= 640 ? 3 : 2);
      if (pageType === "simple") {
        await expectNestedTracks(page, ".event-registration-options", width >= 768 ? 2 : 1);
      }
    }
  });

  for (const embedded of [true, false]) {
    test(`${pageType}: real 375px mobile ${embedded ? "embed" : "standalone"} stacks without overflow or sticky`, async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 700 });
      await mount(page, { pageType, embedded });
      await expectLayout(page, { pageType, embedded });
      await page.screenshot({
        path: `/tmp/event-registration-${pageType}-mobile-${embedded ? "embed" : "standalone"}.png`,
        fullPage: true,
      });
    });
  }

  test(`${pageType}: standalone 1440px desktop retains viewport columns and desktop scrolling`, async ({ page }) => {
    await mount(page, { pageType, embedded: false });
    await expect(page.locator(".event-registration-embed")).toHaveCount(0);
    await expectLayout(page, { pageType, embedded: false, desktop: true });
    await page.screenshot({ path: `/tmp/event-registration-${pageType}-standalone-desktop.png`, fullPage: true });
  });
}