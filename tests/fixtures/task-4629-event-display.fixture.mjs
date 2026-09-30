export const DISPLAY_MODES = ["hidden", "collapsed", "expanded"];

const speaker = (index) => ({
  id: `speaker-${index}`,
  full_name: `Fixture Speaker ${String(index).padStart(2, "0")}`,
  job_title: index === 1 ? "Keynote speaker" : "Panel member",
  organization: "Fixture Organisation",
  email: index === 1 ? "speaker.one@example.invalid" : null,
  biography: `Biography for fixture speaker ${index}.`,
});

const sponsor = (index) => ({
  id: `sponsor-${index}`,
  name: `Fixture Sponsor ${String(index).padStart(2, "0")}`,
  description: `Sponsor description ${index}`,
  website_url: index === 1 ? "https://example.invalid/sponsor-one" : null,
  category_id: "category-main",
});

export const LARGE_SPEAKERS = Array.from({ length: 16 }, (_, index) => speaker(index + 1));
export const LARGE_SPONSORS = Array.from({ length: 16 }, (_, index) => sponsor(index + 1));

const ticket = {
  id: "ticket-public",
  name: "Public fixture ticket",
  price: 25,
  visibility_mode: "members_and_public",
  is_unlimited_tickets: true,
  is_default: true,
  role_ids: [],
  member_group_ids: [],
  linked_track_ids: [],
  all_tracks: true,
};

export function simpleEvent(id, speakerMode = "expanded", sponsorMode = "expanded") {
  return {
    id,
    title: `Simple Registration ${id}`,
    summary: "Isolated simple registration fixture",
    description: "<p>Simple event description</p>",
    status: "published",
    event_state: "active",
    start_date: "2027-06-10T09:00:00.000Z",
    end_date: "2027-06-10T10:00:00.000Z",
    timezone: "Europe/London",
    location: "Fixture Hall",
    speaker_ids: LARGE_SPEAKERS.map((item) => item.id),
    speaker_display_mode: speakerMode,
    sponsor_display_mode: sponsorMode,
    is_unlimited_registration: true,
    available_seats: null,
    show_seat_count: false,
    pricing_config: { ticket_classes: [ticket] },
  };
}

export function complexEvent(id, speakerMode = "expanded", sponsorMode = "expanded") {
  return {
    ...simpleEvent(id, speakerMode, sponsorMode),
    title: `Complex Registration ${id}`,
    slug: id,
    tracks: [],
    pricing_config: { ticket_classes: [ticket] },
  };
}

export function complexSessions(eventId) {
  return [{
    id: `session-${eventId}`,
    title: "Fixture keynote session",
    start_time: "2027-06-10T09:00:00.000Z",
    end_time: "2027-06-10T10:00:00.000Z",
    speaker_ids: LARGE_SPEAKERS.map((item) => item.id),
    track_names: [],
  }];
}

export function sponsorPayload() {
  return {
    sponsors: structuredClone(LARGE_SPONSORS),
    categories: [{ id: "category-main", name: "Principal partners" }],
    assignments: LARGE_SPONSORS.map((item) => ({ sponsor_id: item.id })),
  };
}

export async function initializeTask4629Page(page, {
  pageType,
  event,
  nextEvent,
  placement = "default",
  empty = false,
  agenda = [],
}) {
  await page.route("http://task4629.fixture/**", (route) => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: "<!doctype html><html><head></head><body><div id=\"root\"></div></body></html>",
  }));
  await page.goto("http://task4629.fixture/registration");
  await page.evaluate((fixture) => {
    const events = {
      [fixture.event.id]: fixture.event,
      ...(fixture.nextEvent ? { [fixture.nextEvent.id]: fixture.nextEvent } : {}),
    };
    window.__task4629 = {
      pageType: fixture.pageType,
      currentEventId: fixture.event.id,
      events,
      placement: fixture.placement,
      empty: fixture.empty,
      agenda: fixture.agenda,
      writes: [],
      paymentInteractions: 0,
    };
    window.ResizeObserver ??= class ResizeObserver {
      observe() {}
      disconnect() {}
    };
    window.fetch = async (_url, options = {}) => {
      if ((options.method || "GET").toUpperCase() !== "GET") {
        window.__task4629.writes.push({ url: String(_url), method: options.method });
        return new Response(JSON.stringify({ error: "Fixture rejects writes" }), { status: 405 });
      }
      if (String(_url).includes("/api/public/event-agenda")) {
        return new Response(JSON.stringify(window.__task4629.agenda), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    };
  }, { pageType, event, nextEvent, placement, empty, agenda });
}