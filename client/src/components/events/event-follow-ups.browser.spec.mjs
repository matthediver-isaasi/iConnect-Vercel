import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { existsSync } from "node:fs";
import path from "node:path";
import { eventEmailSurfaceFixtureSource } from "./eventEmailSurfaceFixtures.mjs";

let script;
test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `${eventEmailSurfaceFixtureSource()}
        import {createRoot} from "react-dom/client";
        window.emailFixtureToasts = [];
        const fixtures = {CreateEvent: CreateEventFixture, EditEvent: EditEventFixture, CreateComplexEvent: CreateComplexEventFixture};
        const Surface = fixtures[window.fixtureSurface];
        createRoot(document.getElementById("root")).render(<Surface {...window.fixtureProps}/>);
      `,
      resolveDir: process.cwd(), loader: "jsx",
    },
    bundle: true, write: false, jsx: "automatic", define: {"process.env.NODE_ENV": '"test"'},
    plugins: [{name: "isolated-email-browser", setup(builder) {
      builder.onResolve({filter: /CampaignEventSurveySettings$/}, () => ({path: "survey", namespace: "fixture"}));
      builder.onResolve({filter: /^sonner$/}, () => ({path: "toast", namespace: "fixture"}));
      builder.onLoad({filter: /.*/, namespace: "fixture"}, ({path: name}) => ({
        contents: name === "toast"
          ? "export const toast = {success: m => window.emailFixtureToasts.push(m), error: m => window.emailFixtureToasts.push(m)};"
          : "export default () => null;",
      }));
      builder.onResolve({filter: /^@\//}, args => {
        const base = path.resolve("client/src", args.path.slice(2));
        return {path: [base, `${base}.jsx`, `${base}.js`, `${base}.tsx`, `${base}.ts`].find(file => existsSync(file)) || base};
      });
      builder.onLoad({filter: /\.css$/}, () => ({contents: "", loader: "js"}));
    }}],
  });
  script = result.outputFiles[0].text;
});

const confirmation = {id: "confirmation", email_type: "booking_confirmation", subject: "Booking confirmed", body: "Thank you for booking.", is_enabled: true, timing_type: null};
const reminder = {id: "reminder", email_type: "reminder", subject: "Before the event", body: "{{agenda_schedule}}", is_enabled: true, timing_type: "1_day_before", custom_unit: "hours"};
const targets = [
  {sessionId: "day:2036-06-12", sessionDate: "2036-06-12T20:00:00Z", description: "Programme day 12 June"},
  {sessionId: "day:2036-06-13", sessionDate: "2036-06-13T17:30:00Z", description: "Programme day 13 June"},
];
async function boot(page, surface, props) {
  await page.goto("/");
  await page.evaluate(({surface, props}) => { window.fixtureSurface = surface; window.fixtureProps = props; }, {surface, props});
  await page.addScriptTag({content: script});
}
async function isolate(page) {
  let saved = [], previews = [], writes = [], errors = [], failPreview = false;
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    // Fail closed: nothing may escape to the app, a tenant, or an email provider.
    if (url.hostname !== "event-follow-ups.test") return route.abort();
    if (url.pathname === "/api/event-emails/fixture-event" && request.method() === "PUT") {
      const body = request.postDataJSON();
      writes.push({path: url.pathname, body});
      saved = body.emails.map((email, index) => ({...email, id: `saved-${index}`, isNew: false}));
      return route.fulfill({json: saved});
    }
    if (url.pathname === "/api/event-emails/fixture-event/reschedule" && request.method() === "POST") {
      writes.push({path: url.pathname});
      return route.fulfill({json: {requeued: 5, bookingsScheduled: 2, preserved: 1, cancelled: 1}});
    }
    if (url.pathname === "/api/event-emails/fixture-event/preview" && request.method() === "POST") {
      const body = request.postDataJSON();
      previews.push(body);
      if (failPreview) return route.fulfill({status: 503, json: {error: "Sample rendering unavailable"}});
      const followUp = body.reminder.email_type === "follow_up";
      const eligible = followUp && body.reminder.follow_up_scope !== "event" && !body.ticketClassId ? [] : targets;
      const selected = eligible.find(target => target.sessionId === body.sessionId) || eligible[0];
      return route.fulfill({json: {
        subject: selected ? `Sample: ${selected.description}` : "",
        html: selected ? `<p>Jane Example — ${selected.description}</p>` : "",
        reminderContext: {
          isFollowUp: followUp, scope: body.reminder.follow_up_scope, timezone: "Europe/London",
          entries: eligible.map(target => ({...target, id: target.sessionId, sendAt: target.sessionDate})),
          selectedId: selected?.sessionId, sendAt: selected?.sessionDate,
          ticketClasses: followUp ? [{id: "single-track", name: "Single-track pass"}, {id: "full-programme", name: "Full programme pass"}] : [],
          selectedTicketClassId: body.ticketClassId,
          emptyReason: selected ? null : "Choose a sample ticket class to preview entitled day/session follow-ups.",
          warnings: followUp ? [{reason: "One programme entry has no explicit end time."}] : [],
        },
      }});
    }
    if (url.pathname.startsWith("/api/")) throw new Error(`Unexpected API call ${request.method()} ${url.pathname}`);
    return route.fulfill({contentType: "text/html", body: `<!doctype html><html><head><style>
      body { margin: 24px; font-family: sans-serif; color: #26384a; background: #f3f5f7; }
      button,input,textarea { margin: 4px; } button { cursor:pointer; }
      [role=dialog] { position:fixed; inset:4%; padding:20px; overflow:auto; background:#f7fafc; z-index:50; }
      [role=listbox] { background:#f7fafc; padding:8px; border:1px solid #8997a5; }
      [role=option] { padding:6px; } [data-testid=fixture-emails] { display:none; }
      </style></head><body><div id="root"></div></body></html>`});
  });
  return {saved: () => saved, previews, writes, errors, failPreview: value => { failPreview = value; }};
}
const emailRows = page => page.getByTestId("fixture-emails").textContent().then(JSON.parse);
async function select(page, testId, name) {
  await page.getByTestId(testId).click();
  await page.getByRole("option", {name, exact: true}).click();
}

for (const surface of ["CreateEvent", "EditEvent", "CreateComplexEvent"]) {
  for (const editing of surface === "CreateEvent" ? [false] : surface === "EditEvent" ? [true] : [false, true]) {
    test(`${surface} ${editing ? "edit" : "create"}: add, coexist, save, reopen, preview and explicitly schedule`, async ({page}) => {
      const fixture = await isolate(page);
      await boot(page, surface, {editing, programme: true, initial: [confirmation, reminder], templates: [
        {id: "thanks", name: "After the programme", subject: "Thanks for joining", body: "Thank you {{follow_up_target}}"},
      ]});
      await page.getByTestId("button-add-follow-up-email").click();
      await page.getByTestId("button-add-follow-up-email").click();
      const [, , first, second] = await emailRows(page);
      await select(page, `select-follow-up-scope-${first.id}`, "After each programme day");
      await page.getByTestId(`input-follow-up-delay-${first.id}`).fill("1.5");
      await select(page, `select-follow-up-unit-${first.id}`, "Days");
      await select(page, `select-template-${first.id}`, "After the programme");
      await page.getByTestId(`switch-email-enabled-${second.id}`).click();
      await expect(page.getByTestId(`input-email-subject-${first.id}`)).toHaveValue("Thanks for joining");
      await expect(page.getByTestId(`input-follow-up-delay-${second.id}`)).toHaveValue("0");
      expect(fixture.writes).toHaveLength(0);
      await page.getByTestId(editing ? "button-save-emails" : "fixture-create").click();
      await expect.poll(() => fixture.saved().length).toBe(4);
      expect(fixture.writes).toHaveLength(1);
      expect(fixture.saved()[2]).toMatchObject({follow_up_scope: "day", follow_up_delay: 1.5, follow_up_unit: "days"});
      expect(fixture.saved()[3].is_enabled).toBe(false);
      expect(fixture.saved()[0].timing_type).toBeNull();
      expect(fixture.saved()[1].timing_type).toBe("1_day_before");
      const reopened = surface === "CreateComplexEvent" ? surface : "EditEvent";
      await boot(page, reopened, {editing: true, programme: true, initial: fixture.saved()});
      await expect(page.getByTestId("input-follow-up-delay-saved-2")).toHaveValue("1.5");
      await expect(page.getByTestId("switch-email-enabled-saved-3")).toHaveAttribute("aria-checked", "false");
      await page.getByTestId("button-preview-email-saved-2").click();
      await expect(page.getByRole("status")).toContainText("Choose a sample ticket class");
      await page.getByLabel("Sample ticket entitlement").selectOption("full-programme");
      await expect(page.getByLabel("Follow-up target")).toHaveValue(targets[0].sessionId);
      await page.getByLabel("Follow-up target").selectOption(targets[1].sessionId);
      await expect(page.getByTestId("email-preview-subject")).toContainText("13 June");
      expect(fixture.previews.at(-1)).toMatchObject({ticketClassId: "full-programme", sessionId: targets[1].sessionId, reminder: {email_type: "follow_up", follow_up_scope: "day"}});
      await expect(page.getByText("One programme entry has no explicit end time.")).toBeVisible();
      await expect(page.getByText(/Legacy date-only entries/)).toHaveCount(0);
      await expect(page.frameLocator('[data-testid="email-preview-frame"]').getByText(/Jane Example/)).toBeVisible();
      expect(fixture.writes).toHaveLength(1);
      await page.getByRole("button", {name: "Close", exact: true}).click();
      await page.getByTestId("button-preview-email-saved-1").click();
      await expect(page.getByText(/Legacy date-only entries/)).toBeVisible();
      await page.getByRole("button", {name: "Close", exact: true}).click();
      await page.getByTestId("button-requeue-reminders").click();
      await expect.poll(() => fixture.writes.length).toBe(2);
      expect(fixture.writes[1].path).toMatch(/\/reschedule$/);
      await expect.poll(() => page.evaluate(() => window.emailFixtureToasts.at(-1))).toContain("reminder/follow-up");
      expect(fixture.errors).toEqual([]);
    });
  }
}

test("ordinary events expose event scope only, and preview errors retry without writes", async ({page}) => {
  const fixture = await isolate(page);
  await boot(page, "EditEvent", {editing: true});
  await page.getByTestId("button-add-follow-up-email").click();
  const [email] = await emailRows(page);
  await page.getByTestId(`select-follow-up-scope-${email.id}`).click();
  await expect(page.getByRole("option")).toHaveCount(1);
  await page.getByRole("option", {name: "After event", exact: true}).click();
  fixture.failPreview(true);
  await page.getByTestId(`button-preview-email-${email.id}`).click();
  await expect(page.getByTestId("email-preview-error")).toContainText("Sample rendering unavailable");
  fixture.failPreview(false);
  await page.getByRole("button", {name: "Retry preview"}).click();
  await expect(page.getByTestId("email-preview-subject")).toContainText("Programme day");
  expect(fixture.writes).toHaveLength(0);
  expect(fixture.errors).toEqual([]);
});
