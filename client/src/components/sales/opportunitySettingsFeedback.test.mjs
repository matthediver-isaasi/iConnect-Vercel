import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { showOpportunitySettingsError } from "./opportunitySettingsFeedback.js";

for (const [message, code] of [
  ["Cannot deactivate a stage used by opportunities", undefined],
  ["Cannot change won/lost classification of a stage used by opportunities", undefined],
  ["Cannot deactivate a stage used by opportunities", "P0001"],
]) {
  test(`occupied stage shows its real reason and preserves draft (${code || message})`, async () => {
    const notices = [];
    await showOpportunitySettingsError({ status: 409, message, payload: { code } }, {
      reloadSettings: () => assert.fail("Must not discard draft for a validation conflict"),
      toast: notice => notices.push(notice),
    });
    assert.deepEqual(notices, [{ title: "Could not save settings", description: message, variant: "destructive" }]);
  });
}

test("only a genuine stale-order conflict reloads settings before notifying", async () => {
  const events = [];
  await showOpportunitySettingsError({ status: 409, payload: { code: "STALE_UPDATE" } }, {
    reloadSettings: async () => { events.push("reloaded"); },
    toast: notice => events.push(notice),
  });
  assert.equal(events[0], "reloaded");
  assert.equal(events[1].title, "Stage order changed elsewhere");
});

test("ordinary errors retain their actual message", async () => {
  let notice;
  await showOpportunitySettingsError({ status: 500, message: "Failed to handle opportunity settings" }, {
    reloadSettings: () => assert.fail("Unexpected reload"),
    toast: value => { notice = value; },
  });
  assert.equal(notice.description, "Failed to handle opportunity settings");
});

test("settings mutation uses the tested feedback handler", () => {
  const source = readFileSync(new URL("./OpportunitiesWorkspace.jsx", import.meta.url), "utf8");
  assert.match(source, /onError: \(error\) => showOpportunitySettingsError\(error,/);
  assert.match(source, /reloadSettings: \(\) => qc\.refetchQueries\(\{ queryKey: \["opportunity-settings"\] \}\)/);
});
