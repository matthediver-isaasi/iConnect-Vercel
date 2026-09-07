import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseInternalEventTypes } from "./internalEventTypes.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("internal event type options parse safely and case-insensitively deduplicate", () => {
  assert.deepEqual(parseInternalEventTypes('[" Finance ","finance","Member","",7]'), ["Finance", "Member"]);
  assert.deepEqual(parseInternalEventTypes("not-json"), []);
  assert.deepEqual(parseInternalEventTypes(null), []);
});

test("simple and complex event forms persist nullable internal classifications", () => {
  const create = read("client/src/pages/CreateEvent.jsx");
  const edit = read("client/src/pages/EditEvent.jsx");
  const complex = read("client/src/pages/CreateComplexEvent.jsx");
  assert.match(create, /internal_event_type:\s*isGroupLimited \? null : \(formData\.internal_event_type \|\| null\)/);
  assert.match(edit, /internal_event_type:\s*event\.internal_event_type \|\| ""/);
  assert.match(edit, /internal_event_type:\s*isGroupLimited \? null : \(formData\.internal_event_type \|\| null\)/);
  assert.match(complex, /internal_event_type:\s*existingEvent\.internal_event_type \|\| ""/);
  assert.match(complex, /internal_event_type:\s*isGroupLimited \? null : \(formData\.internal_event_type \|\| null\)/);
});

test("group administrators cannot set the private classification", () => {
  const source = read("api/_lib/groupAdminEventWrite.js");
  assert.match(source, /if \('internal_event_type' in out\) out\.internal_event_type = null;/);
});

test("public settings and event endpoints never expose internal classifications", () => {
  for (const path of [
    "api/public/system-settings.js",
    "api/public/event.js",
    "api/public/complex-event.js",
  ]) {
    assert.doesNotMatch(read(path), /internal_event_type|internal_event_types/, `${path} must remain private`);
  }
});

test("authenticated generic APIs keep classifications admin-only", () => {
  const listApi = read("api/entities/[entity]/index.js");
  const itemApi = read("api/entities/[entity]/[id].js");
  assert.match(listApi, /row\.setting_key !== 'internal_event_types'/);
  assert.match(listApi, /delete safeRow\.internal_event_type/);
  assert.match(listApi, /sanitizedBody\.setting_key === 'internal_event_types'/);
  assert.match(itemApi, /data\?\.setting_key === 'internal_event_types'/);
  assert.match(itemApi, /delete data\.internal_event_type/);
  assert.match(itemApi, /delete responseData\.internal_event_type/);
  assert.match(itemApi, /targetSetting\?\.setting_key === 'internal_event_types'/);
  assert.match(itemApi, /req\.method === 'DELETE'[\s\S]*targetSetting\?\.setting_key === 'internal_event_types'/);
});

test("simple group-event creation hides the internal selector", () => {
  const source = read("client/src/pages/CreateEvent.jsx");
  const selector = source.indexOf('data-testid="select-internal-event-type"');
  const gate = source.lastIndexOf('{!isGroupLimited && (', selector);
  assert.ok(gate >= 0 && selector - gate < 500, "internal selector must have a direct group-limited gate");
});