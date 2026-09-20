import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import fs from "node:fs";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import {
  DISPLAY_MODES,
  LARGE_SPEAKERS,
  complexEvent,
  initializeTask4629Page,
  simpleEvent,
  sponsorPayload,
} from "./fixtures/task-4629-event-display.fixture.mjs";

/*
 * Task 4629 uses the real EventDetailsExperience, ComplexEventDetailExperience,
 * and EventSponsorsCard. All APIs are in-memory and every non-GET fetch is
 * rejected and recorded, so this suite cannot write to a tenant or provider.
 */
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
      getComplexEventSessions: async id => state().empty ? [] : [{
        id: "session-" + id, title: "Fixture keynote session",
        start_time: "2027-06-10T09:00:00.000Z", end_time: "2027-06-10T10:00:00.000Z",
        speaker_ids: window.__task4629Speakers.map(item => item.id), track_names: [],
      }],
      listSpeakers: async ids => state().empty ? [] : window.__task4629Speakers.filter(item => ids.includes(item.id)),
      listSystemSettings: async () => state().placement === "after_date"
        ? [{ setting_key: "event_sponsors_placement", setting_value: "after_date" }]
        : [],
      getEventSponsors: async () => state().empty ? { sponsors: [], categories: [], assignments: [] } : window.__task4629Sponsors,
      getEventAllocationContext: async () => null,
      checkMemberEmail: async () => ({ is_member: false }),
    };
  `,
  "@/api/supabaseClient": `
    const result = { data: [], error: null };
    const chain = new Proxy({}, {
      get(_target, key) {
        if (key === "then") return (resolve) => resolve(result);
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
      return <div data-testid="fixture-payment-controls">
        <label>Booking note <input aria-label="Booking note" /></label>
        <button type="button" onClick={() => window.__task4629.paymentInteractions++}>Continue booking</button>
      </div>;
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
    name: "task-4629-isolated-registration-pages",
    setup(api) {
      api.onResolve({ filter: /(?:^|\/)(PaymentOptions|ColleagueSelector|AttendeeOptionsSelector|PageTour|TourButton|BookmarkButton)$/ }, (args) => {
        const name = args.path.split("/").pop();
        const keys = {
          PaymentOptions: "@/components/booking/PaymentOptions",
          ColleagueSelector: "@/components/booking/ColleagueSelector",
          AttendeeOptionsSelector: "@/components/booking/AttendeeOptionsSelector",
          PageTour: "@/components/tour/PageTour",
          TourButton: "@/components/tour/TourButton",
          BookmarkButton: "@/components/bookmarks/BookmarkButton",
        };
        return { path: keys[name], namespace: "task4629-stub" };
      });
      api.onResolve({ filter: /^@\// }, (args) => {
        if (stubs[args.path]) return { path: args.path, namespace: "task4629-stub" };
        return { path: resolveSource(path.resolve("client/src", args.path.slice(2))) };
      });
      api.onResolve({ filter: /^@shared\// }, (args) => ({
        path: resolveSource(path.resolve("shared", args.path.slice("@shared/".length))),
      }));
      api.onLoad({ filter: /.*/, namespace: "task4629-stub" }, (args) => ({
        contents: stubs[args.path],
        loader: "jsx",
        resolveDir: process.cwd(),
      }));
      api.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "css" }));
    },
  };
}

let script;
let css;

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import React, { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { BrowserRouter } from "react-router-dom";
        import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
        import { EventDetailsExperience } from "./client/src/pages/EventDetails.jsx";
        import { ComplexEventDetailExperience } from "./client/src/pages/ComplexEventDetail.jsx";

        const queryClient = new QueryClient({
          defaultOptions: { queries: { retry: false, staleTime: 0 } },
        });
        function Harness() {
          const [eventId, setEventId] = useState(window.__task4629.currentEventId);
          const client = useQueryClient();
          const refresh = async () => {
            await client.invalidateQueries();
            await client.refetchQueries({ type: "active" });
          };
          const navigate = () => {
            const ids = Object.keys(window.__task4629.events);
            setEventId(ids.find(id => id !== eventId) || eventId);
          };
          return <>
            <nav>
              <button data-testid="fixture-refresh" onClick={refresh}>Refresh fixture queries</button>
              <button data-testid="fixture-navigate" onClick={navigate}>Navigate fixture event</button>
            </nav>
            {window.__task4629.pageType === "simple"
              ? <EventDetailsExperience eventId={eventId} />
              : <ComplexEventDetailExperience eventId={eventId} />}
          </>;
        }
        createRoot(document.getElementById("root")).render(
          <QueryClientProvider client={queryClient}>
            <BrowserRouter><Harness /></BrowserRouter>
          </QueryClientProvider>
        );
      `,
      resolveDir: process.cwd(),
      loader: "jsx",
    },
    bundle: true,
    write: false,
    outfile: "task-4629-fixture.js",
    jsx: "automatic",
    plugins: [fixturePlugin()],
    define: {
      "process.env.NODE_ENV": '"test"',
      "import.meta.env.DEV": "false",
    },
  });
  script = result.outputFiles.find((file) => file.path.endsWith(".js"))?.text || result.outputFiles[0].text;
  css = (await postcss([tailwindcss({
    content: [
      "client/src/pages/EventDetails.jsx",
      "client/src/pages/ComplexEventDetail.jsx",
      "client/src/components/events/{EventDisclosure,EventSponsorsCard,ComplexEventSchedule}.jsx",
      "client/src/components/ui/{avatar,badge,button,card,checkbox,dialog,input,label,radio-group,tabs,tooltip}.jsx",
    ],
    corePlugins: { preflight: true },
  })]).process("@tailwind base; @tailwind components; @tailwind utilities;", { from: undefined })).css;
});

async function mount(page, options) {
  page.on("pageerror", (error) => console.error("task4629 pageerror:", error.message));
  await initializeTask4629Page(page, options);
  await page.evaluate(({ speakers, sponsors }) => {
    window.__task4629Speakers = speakers;
    window.__task4629Sponsors = sponsors;
  }, { speakers: options.speakers || LARGE_SPEAKERS, sponsors: options.sponsors || sponsorPayload() });
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

function sectionExpectations(mode) {
  return {
    heading: mode !== "hidden",
    content: mode === "expanded",
  };
}

// Computed styles, rather than class strings, catch inherited typography drift.
async function disclosureMetrics(toggle) {
  return toggle.evaluate((button) => {
    const style = getComputedStyle(button);
    const heading = getComputedStyle(button.parentElement);
    const icons = [...button.querySelectorAll("svg")].map((icon) => {
      const rect = icon.getBoundingClientRect();
      return { width: rect.width, height: rect.height, center: rect.y + rect.height / 2 };
    });
    return {
      fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing, gap: style.gap,
      headingSize: heading.fontSize,
      icons: icons.map(({ width, height }) => ({ width, height })),
      iconOffset: Math.abs(icons[0].center - icons[1].center),
    };
  });
}

for (const pageType of ["simple", "complex"]) {
  for (const placement of ["default", "after_date"]) {
    for (const width of [375, 1440]) {
      for (const minimal of [false, true]) {
        test(`section layout ${pageType} ${placement} ${width} ${minimal ? "minimal" : "long"}`, async ({ page }, testInfo) => {
          await page.setViewportSize({ width, height: 900 });
          const event = (pageType === "simple" ? simpleEvent : complexEvent)("layout", "collapsed", "collapsed");
          const sponsors = sponsorPayload();
          sponsors.sponsors[0].name = "LongSponsorName".repeat(12);
          sponsors.categories[0].name = "Principal partners supporting this event and its participants";
          if (minimal) {
            delete event.description;
            delete event.summary;
            event.attached_documents = [];
            sponsors.sponsors.forEach(sponsor => { delete sponsor.description; });
          }
          await mount(page, { pageType, event, placement, sponsors });
          const sponsor = page.getByTestId("card-event-sponsors");
          const speakers = page.getByTestId("button-toggle-speakers");
          const sponsorToggle = page.getByTestId("button-toggle-sponsors");
          for (const state of ["collapsed", "speakers-only", "expanded", "sponsors-only"]) {
            const a = await disclosureMetrics(speakers);
            const b = await disclosureMetrics(sponsorToggle);
            expect(a).toEqual(b);
            expect(a.fontSize).toBe("18px");
            expect(a.fontWeight).toBe("600");
            expect(a.lineHeight).toBe("28px");
            expect(a.gap).toBe("8px");
            expect(a.iconOffset).toBeLessThan(1);
            const titleSize = await page.getByRole("heading", { level: 1 })
              .evaluate(node => parseFloat(getComputedStyle(node).fontSize));
            expect(titleSize).toBeGreaterThan(18);
            const containment = await sponsor.evaluate(node => {
              const style = getComputedStyle(node);
              return { radius: style.borderRadius, shadow: style.boxShadow,
                left: style.borderLeftWidth, right: style.borderRightWidth,
                top: style.borderTopWidth, bottom: style.borderBottomWidth };
            });
            if (pageType === "simple") {
              expect(containment).toEqual({ radius: "0px", shadow: "none", left: "0px", right: "0px", top: "1px", bottom: "0px" });
            } else {
              expect(containment.radius).not.toBe("0px");
              expect(containment.left).toBe("1px");
              const padding = await page.evaluate(() => {
                const sponsor = document.querySelector('[data-testid="card-event-sponsors"]');
                const speakerHeading = document.querySelector('[data-testid="button-toggle-speakers"]').parentElement;
                const speakerCard = speakerHeading.parentElement.parentElement;
                const offset = (card, button) => {
                  const c = card.getBoundingClientRect(), b = button.getBoundingClientRect();
                  return [b.x - c.x, b.y - c.y, c.right - b.right];
                };
                return {
                  sponsor: offset(sponsor, sponsor.querySelector("button")),
                  speaker: offset(speakerCard, speakerHeading.querySelector("button")),
                  gap: speakerCard.getBoundingClientRect().top - sponsor.getBoundingClientRect().bottom,
                };
              });
              expect(padding.sponsor).toEqual(padding.speaker);
              expect(padding.gap).toBeGreaterThanOrEqual(24);
            }
            expect(await sponsor.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
            expect(await sponsor.evaluate(node => node.getBoundingClientRect().width <= window.innerWidth)).toBe(true);
            if (state === "collapsed" || state === "expanded") {
              await sponsor.scrollIntoViewIfNeeded();
              await page.screenshot({ path: testInfo.outputPath(`${state}.png`) });
            }
            if (state === "collapsed") await speakers.click();
            if (state === "speakers-only") await sponsorToggle.click();
            if (state === "expanded") await speakers.click();
          }
          expect(await page.evaluate(() => window.__task4629.writes)).toEqual([]);
        });
      }
    }
  }
}

for (const pageType of ["simple", "complex"]) {
  for (const speakerMode of DISPLAY_MODES) {
    for (const sponsorMode of DISPLAY_MODES) {
      test(`${pageType}: ${speakerMode} speakers and ${sponsorMode} sponsors are independent`, async ({ page }) => {
        const event = pageType === "simple"
          ? simpleEvent(`${pageType}-${speakerMode}-${sponsorMode}`, speakerMode, sponsorMode)
          : complexEvent(`${pageType}-${speakerMode}-${sponsorMode}`, speakerMode, sponsorMode);
        await mount(page, { pageType, event });

        const speakers = sectionExpectations(speakerMode);
        const sponsors = sectionExpectations(sponsorMode);
        await expect(page.getByTestId("button-toggle-speakers")).toHaveCount(speakers.heading ? 1 : 0);
        await expect(page.getByTestId("button-toggle-sponsors")).toHaveCount(sponsors.heading ? 1 : 0);
        if (speakers.content) {
          await expect(page.getByTestId("button-speaker-speaker-1")).toBeVisible();
        } else {
          await expect(page.getByTestId("button-speaker-speaker-1")).toBeHidden();
        }
        if (sponsors.content) {
          await expect(page.getByTestId("sponsor-item-sponsor-1")).toBeVisible();
        } else {
          await expect(page.getByTestId("sponsor-item-sponsor-1")).toBeHidden();
        }

        if (speakers.heading) {
          await expect(page.getByTestId("button-toggle-speakers")).toHaveAttribute("aria-expanded", String(speakers.content));
        }
        if (sponsors.heading) {
          await expect(page.getByTestId("button-toggle-sponsors")).toHaveAttribute("aria-expanded", String(sponsors.content));
        }
        expect(await page.evaluate(() => window.__task4629.writes)).toEqual([]);
      });
    }
  }
}

for (const pageType of ["simple", "complex"]) {
  test(`${pageType} visitor choices survive query refresh and navigation applies next defaults`, async ({ page }) => {
    const makeEvent = pageType === "simple" ? simpleEvent : complexEvent;
    const event = makeEvent(`${pageType}-refresh-a`, "expanded", "collapsed");
    const nextEvent = makeEvent(`${pageType}-refresh-b`, "collapsed", "expanded");
    await mount(page, { pageType, event, nextEvent });

    await page.getByTestId("button-toggle-speakers").click();
    await page.getByTestId("button-toggle-sponsors").click();
    await expect(page.getByTestId("button-toggle-speakers")).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("button-toggle-sponsors")).toHaveAttribute("aria-expanded", "true");

    await page.getByTestId("fixture-refresh").click();
    await expect(page.getByTestId("button-toggle-speakers")).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("button-toggle-sponsors")).toHaveAttribute("aria-expanded", "true");

    await page.getByTestId("fixture-navigate").click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(`${pageType}-refresh-b`);
    await expect(page.getByTestId("button-toggle-speakers")).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("button-toggle-sponsors")).toHaveAttribute("aria-expanded", "true");
  });
}

for (const pageType of ["simple", "complex"]) {
  for (const placement of ["default", "after_date"]) {
    test(`${pageType} sponsor placement ${placement} remains on the configured side of About`, async ({ page }) => {
      const event = pageType === "simple"
        ? simpleEvent(`${pageType}-placement-${placement}`)
        : complexEvent(`${pageType}-placement-${placement}`);
      await mount(page, { pageType, event, placement });
      const aboutTestId = pageType === "simple" ? "text-event-description" : "text-about-heading";
      const ordering = await page.locator(`[data-testid='card-event-sponsors'], [data-testid='${aboutTestId}']`)
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid")));
      expect(ordering).toEqual(placement === "after_date"
        ? ["card-event-sponsors", aboutTestId]
        : [aboutTestId, "card-event-sponsors"]);
    });
  }
}

test("empty speaker and sponsor results leave no headings or whitespace cards on either page", async ({ page }) => {
  for (const pageType of ["simple", "complex"]) {
    const event = pageType === "simple" ? simpleEvent(`empty-${pageType}`) : complexEvent(`empty-${pageType}`);
    await mount(page, { pageType, event, empty: true });
    await expect(page.getByTestId("button-toggle-speakers")).toHaveCount(0);
    await expect(page.getByTestId("button-toggle-sponsors")).toHaveCount(0);
    await expect(page.getByTestId("card-event-sponsors")).toHaveCount(0);
    await page.locator("#root").evaluate((root) => { root.replaceChildren(); });
  }
});

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 375, height: 700 },
]) {
  test(`${viewport.name} large lists toggle by keyboard and retain profile, link, and booking controls`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mount(page, {
      pageType: "simple",
      event: simpleEvent(`large-${viewport.name}`, "collapsed", "collapsed"),
    });

    const speakerToggle = page.getByTestId("button-toggle-speakers");
    await speakerToggle.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("button-speaker-speaker-16")).toBeVisible();
    await page.getByTestId("button-speaker-speaker-1").click();
    await expect(page.getByRole("dialog")).toContainText("Biography for fixture speaker 1.");
    await page.keyboard.press("Escape");

    const sponsorToggle = page.getByTestId("button-toggle-sponsors");
    await sponsorToggle.focus();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("sponsor-item-sponsor-16")).toBeVisible();
    await expect(page.getByTestId("link-sponsor-sponsor-1")).toHaveAttribute("href", "https://example.invalid/sponsor-one");

    const booking = page.getByTestId("fixture-payment-controls");
    await expect(booking).toBeVisible();
    await booking.getByLabel("Booking note").fill("Visitor state remains usable");
    await booking.getByRole("button", { name: "Continue booking" }).click();
    expect(await page.evaluate(() => window.__task4629.paymentInteractions)).toBe(1);
    expect(await page.evaluate(() => window.__task4629.writes)).toEqual([]);
    await page.screenshot({
      path: `/tmp/task-4629-simple-${viewport.name}.png`,
      fullPage: true,
    });
  });
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 375, height: 700 },
]) {
  test(`complex ${viewport.name} large lists support keyboard, profile, sponsor link, and booking controls`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const event = complexEvent(`complex-booking-${viewport.name}`, "collapsed", "collapsed");
    await mount(page, { pageType: "complex", event });

    await page.getByTestId("button-toggle-speakers").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("button-speaker-speaker-16")).toBeVisible();
    await page.getByTestId("button-speaker-speaker-1").click();
    await expect(page.getByRole("dialog")).toContainText("Biography for fixture speaker 1.");
    await expect(page.getByRole("dialog")).toContainText("Fixture keynote session");
    await page.keyboard.press("Escape");

    await page.getByTestId("button-toggle-sponsors").focus();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("sponsor-item-sponsor-16")).toBeVisible();
    await expect(page.getByTestId("link-sponsor-sponsor-1"))
      .toHaveAttribute("href", "https://example.invalid/sponsor-one");

    await expect(page.getByTestId("booking-section")).toBeVisible();
    await expect(page.getByTestId("ticket-class-ticket-public")).toBeVisible();
    await page.getByTestId("button-add-attendee-ticket-public").click();
    await expect(page.getByRole("dialog")).toContainText("Add Attendee");
    await expect(page.getByTestId("input-external-email")).toBeVisible();
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => window.__task4629.writes)).toEqual([]);
    await page.screenshot({
      path: `/tmp/task-4629-complex-${viewport.name}.png`,
      fullPage: true,
    });
  });
}

for (const pageType of ["simple", "complex"]) {
  test(`${pageType} legacy event with absent display modes remains expanded`, async ({ page }) => {
    const event = pageType === "simple"
      ? simpleEvent(`legacy-${pageType}`)
      : complexEvent(`legacy-${pageType}`);
    delete event.speaker_display_mode;
    delete event.sponsor_display_mode;
    await mount(page, { pageType, event });
    await expect(page.getByTestId("button-toggle-speakers")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("button-speaker-speaker-1")).toBeVisible();
    await expect(page.getByTestId("button-toggle-sponsors")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("sponsor-item-sponsor-1")).toBeVisible();
  });
}

test("simple inline agenda speaker attribution remains when event speaker section is hidden", async ({ page }) => {
  const event = simpleEvent("simple-inline-attribution", "hidden", "hidden");
  event.is_training = true;
  event.speaker_ids = [];
  const agenda = [{
    id: "agenda-inline",
    start_date: "2027-06-10",
    start_time: "09:00",
    end_time: "10:00",
    title: "Inline attributed workshop",
    speaker_ids: ["speaker-1"],
  }];
  await mount(page, { pageType: "simple", event, agenda });
  await expect(page.getByTestId("button-toggle-speakers")).toHaveCount(0);
  await expect(page.getByTestId("agenda-speakers-agenda-inline")).toContainText("Fixture Speaker 01");
});

test("complex inline session speaker attribution remains when event speaker section is hidden", async ({ page }) => {
  const event = complexEvent("complex-inline-attribution", "hidden", "hidden");
  event.speaker_ids = [];
  await mount(page, { pageType: "complex", event });
  await expect(page.getByTestId("button-toggle-speakers")).toHaveCount(0);
  await expect(page.getByTestId("session-speaker-speaker-1").first()).toContainText("Fixture Speaker 01");
});