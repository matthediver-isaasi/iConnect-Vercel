import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Execute the actual save section from both editor parents. This keeps the
// regression bound to production wiring without mounting their unrelated APIs.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function editorSave(page) {
  const source = readFileSync(new URL(`../pages/${page}.jsx`, import.meta.url), "utf8");
  const section = source.match(/\/\/ Save sponsor assignments[\s\S]*?toast.error\('Event saved but sponsor assignments could not be saved'\);\s*\}/)?.[0];
  assert.ok(section, `${page} sponsor save section exists`);
  return new AsyncFunction("base44", "selectedSponsors", "sponsorDetails", "sponsorCategories", "eventId", "isEditMode", "sponsorsLoadFailed", "sponsorsInitialized", "toast", section);
}

function assignmentApi(rows) {
  const writes = [];
  const api = {
    async listAll({ filter }) { return rows.filter(row => row.event_id === filter.event_id && row.event_type === filter.event_type).map(row => ({ ...row })); },
    async update(id, data) { writes.push(["update", id, data]); Object.assign(rows.find(row => row.id === id), data); },
    async create(data) { writes.push(["create", data]); rows.push({ id: `new-${rows.length}`, ...data }); },
    async delete(id) { writes.push(["delete", id]); rows.splice(rows.findIndex(row => row.id === id), 1); },
  };
  return { base44: { entities: { EventSponsorAssignment: api } }, writes };
}

for (const [page, type] of [["EditEvent", "simple"], ["CreateComplexEvent", "complex"]]) {
  const save = editorSave(page);
  test(`${page}: category changes and new sponsors never overwrite another event or copy global categories`, async () => {
    const rows = [
      { id: "a", event_id: "event-a", event_type: type, sponsor_id: "shared", category_id: "a-gold", sponsorship_detail: "Lunch" },
      { id: "b", event_id: "event-b", event_type: type, sponsor_id: "shared", category_id: "b-partner", sponsorship_detail: "Reception" },
    ];
    const { base44, writes } = assignmentApi(rows);
    const errors = [];
    const toast = { warning() {}, error: message => errors.push(message) };
    await save(base44, ["shared", "new-sponsor"], { shared: "Updated lunch" }, { shared: "a-silver", "new-sponsor": null }, "event-a", true, false, true, toast);
    assert.deepEqual(errors, []);
    assert.equal(rows.find(r => r.id === "a").category_id, "a-silver");
    assert.equal(rows.find(r => r.id === "a").sponsorship_detail, "Updated lunch");
    assert.equal(rows.find(r => r.sponsor_id === "new-sponsor").category_id, null);
    assert.deepEqual(rows.find(r => r.id === "b"), { id: "b", event_id: "event-b", event_type: type, sponsor_id: "shared", category_id: "b-partner", sponsorship_detail: "Reception" });
    assert.equal(writes.length, 2);
    // Explicitly clearing a category persists null, retaining sponsor and detail.
    await save(base44, ["shared", "new-sponsor"], { shared: "Updated lunch" }, { shared: null }, "event-a", true, false, true, toast);
    assert.equal(rows.find(r => r.id === "a").category_id, null);
    assert.equal(rows.find(r => r.id === "b").category_id, "b-partner");
  });

  for (const [failed, initialized] of [[true, true], [false, false]]) {
    test(`${page}: ${failed ? "failed" : "pending"} assignment hydration cannot clear assignments`, async () => {
      const rows = [{ id: "a", event_id: "event-a", event_type: type, sponsor_id: "shared", category_id: "gold" }];
      const { base44, writes } = assignmentApi(rows);
      const warnings = [];
      await save(base44, [], {}, {}, "event-a", true, failed, initialized, { warning: message => warnings.push(message), error: assert.fail });
      assert.deepEqual(writes, []);
      assert.equal(rows[0].category_id, "gold");
      assert.equal(warnings.length, 1);
    });
  }
}

test("new complex event saves standalone sponsors as uncategorised", async () => {
  const rows = [];
  const { base44 } = assignmentApi(rows);
  await editorSave("CreateComplexEvent")(base44, ["standalone"], { standalone: "Exhibition" }, {}, "new-event", false, false, false, { warning: assert.fail, error: assert.fail });
  assert.equal(rows[0].category_id, null);
  assert.equal(rows[0].sponsorship_detail, "Exhibition");
  assert.equal(rows[0].event_id, "new-event");
  assert.equal(rows[0].event_type, "complex");
});
