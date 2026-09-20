import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

const createEvent = read("client/src/pages/CreateEvent.jsx");
const editEvent = read("client/src/pages/EditEvent.jsx");
const complexEvent = read("client/src/pages/CreateComplexEvent.jsx");
const field = read("client/src/components/events/EventPeopleDisplayModeField.jsx");

const expectDefaultsAndSave = (source, name) => {
  assert.match(source, /speaker_display_mode:\s*"expanded"/, `${name} defaults speakers to expanded`);
  assert.match(source, /sponsor_display_mode:\s*"expanded"/, `${name} defaults sponsors to expanded`);
  assert.match(
    source,
    /speaker_display_mode:\s*formData\.speaker_display_mode\s*\|\|\s*"expanded"/,
    `${name} saves speaker display mode`,
  );
  assert.match(
    source,
    /sponsor_display_mode:\s*formData\.sponsor_display_mode\s*\|\|\s*"expanded"/,
    `${name} saves sponsor display mode`,
  );
};

test("display mode field exposes the exact modes and labels with expanded fallback", () => {
  assert.match(field, /HIDDEN:\s*"hidden"/);
  assert.match(field, /COLLAPSED:\s*"collapsed"/);
  assert.match(field, /EXPANDED:\s*"expanded"/);
  assert.match(field, /Hide on event registration page/);
  assert.match(field, /Show but open collapsed/);
  assert.match(field, /Show and open expanded/);
  assert.match(field, /:\s*EVENT_PEOPLE_DISPLAY_MODES\.EXPANDED;/);
});

test("simple create defaults and saves both display modes", () => {
  expectDefaultsAndSave(createEvent, "CreateEvent");
  assert.match(createEvent, /field="speaker"[\s\S]*?formData\.speaker_display_mode/);
  assert.match(createEvent, /field="sponsor"[\s\S]*?formData\.sponsor_display_mode/);
});

test("simple edit loads legacy defaults and saves both display modes", () => {
  expectDefaultsAndSave(editEvent, "EditEvent");
  assert.match(editEvent, /speaker_display_mode:\s*event\.speaker_display_mode\s*\|\|\s*"expanded"/);
  assert.match(editEvent, /sponsor_display_mode:\s*event\.sponsor_display_mode\s*\|\|\s*"expanded"/);

  const sponsorArea = editEvent.slice(
    editEvent.indexOf("{/* Event Sponsors - Collapsible */}"),
    editEvent.indexOf("{/* Event Filter Tags", editEvent.indexOf("{/* Event Sponsors - Collapsible */}")),
  );
  assert.ok(
    sponsorArea.indexOf('field="sponsor"') < sponsorArea.indexOf("{sponsorsExpanded &&"),
    "sponsor display mode remains editable without opening the assignment editor",
  );
});

test("complex create/edit defaults, loads, saves, and dirty-resets display modes", () => {
  expectDefaultsAndSave(complexEvent, "CreateComplexEvent");
  assert.match(complexEvent, /speaker_display_mode:\s*existingEvent\.speaker_display_mode\s*\|\|\s*"expanded"/);
  assert.match(complexEvent, /sponsor_display_mode:\s*existingEvent\.sponsor_display_mode\s*\|\|\s*"expanded"/);

  const snapshot = complexEvent.slice(
    complexEvent.indexOf("const buildSnapshot"),
    complexEvent.indexOf("const isDirty", complexEvent.indexOf("const buildSnapshot")),
  );
  assert.match(snapshot, /JSON\.stringify\(\{\s*formData,/, "display modes participate in dirty state via formData");
  assert.match(complexEvent, /baselineSnapshotRef\.current\s*=\s*buildSnapshot\(\)/, "saved values reset dirty baseline");
  assert.doesNotMatch(complexEvent, /button-toggle-people-display-section/);

  const sponsorArea = complexEvent.slice(
    complexEvent.indexOf("{/* Event Sponsors - Collapsible */}"),
    complexEvent.indexOf("<SEOSettings", complexEvent.indexOf("{/* Event Sponsors - Collapsible */}")),
  );
  assert.ok(
    sponsorArea.indexOf('field="sponsor"') < sponsorArea.indexOf("{sponsorsExpanded &&"),
    "complex sponsor mode is independent of opening assignment",
  );

  const speakerModeIndex = complexEvent.indexOf('field="speaker"');
  const sponsorCardIndex = complexEvent.indexOf("{/* Event Sponsors - Collapsible */}");
  const sessionDialogIndex = complexEvent.indexOf("<Dialog open={sessionDialogOpen");
  assert.ok(speakerModeIndex > 0, "complex event details expose speaker display mode");
  assert.ok(
    speakerModeIndex < sponsorCardIndex,
    "speaker display mode sits alongside the event-level sponsor card",
  );
  assert.ok(
    speakerModeIndex < sessionDialogIndex,
    "event-level speaker display mode must not be placed in the session dialog",
  );
  const sessionDialog = complexEvent.slice(sessionDialogIndex);
  assert.doesNotMatch(
    sessionDialog,
    /EventPeopleDisplayModeField[\s\S]*?field="speaker"/,
    "session assignment UI must not own event-level display mode",
  );
});