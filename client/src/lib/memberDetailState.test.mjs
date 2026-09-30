import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_QUERY_LIST,
  memberPageForPath,
  memberTabFromSearch,
  preferenceValuesToState,
  preserveEqualState,
  searchForMemberTab,
} from "./memberDetailState.mjs";

test("disabled optional queries use one stable empty value", () => {
  assert.equal(EMPTY_QUERY_LIST, EMPTY_QUERY_LIST);
  const current = {};
  assert.equal(preserveEqualState(current, preferenceValuesToState([], EMPTY_QUERY_LIST)), current);
});

test("member and organisation preference state is derived deterministically", () => {
  const fields = [{ id: "country", field_type: "countries" }, { id: "title", field_type: "text" }];
  const values = [
    { field_id: "country", value: '["GB","IE"]' },
    { field_id: "title", value: "Director" },
  ];
  const current = { country: ["GB", "IE"], title: "Director" };
  assert.deepEqual(preferenceValuesToState(fields, values), current);
  assert.equal(preserveEqualState(current, preferenceValuesToState(fields, values)), current);
});

test("category-style arrays no-op when their derived state is unchanged", () => {
  const current = [{ category_id: "one", subcategory_name: "Alpha" }];
  assert.equal(preserveEqualState(current, [{ category_id: "one", subcategory_name: "Alpha" }]), current);
  assert.notEqual(preserveEqualState(current, []), current);
});

test("all configured member aliases classify list and detail chrome consistently", () => {
  for (const alias of ["members", "contacts", "individuals", "people"]) {
    assert.equal(memberPageForPath(`/${alias}`), "MembersList");
    assert.equal(memberPageForPath(`/${alias}/first-member`), "MemberDetail");
    assert.equal(memberPageForPath(`/${alias}/second-member`), "MemberDetail");
  }
  assert.equal(memberPageForPath("/events"), null);
});

test("list, sidebar, history, and detail-to-detail transitions reclassify immediately", () => {
  const history = [
    "/members",
    "/members/first-member",
    "/members",
    "/events",
    "/members/second-member",
    "/members/first-member",
  ];
  assert.deepEqual(
    history.map(memberPageForPath),
    ["MembersList", "MemberDetail", "MembersList", null, "MemberDetail", "MemberDetail"],
  );
});

test("member tabs round-trip through URL search and browser-history inputs", () => {
  const roles = searchForMemberTab("?source=list", "roles");
  assert.equal(roles.toString(), "source=list&tab=roles");
  assert.equal(memberTabFromSearch(roles), "roles");
  const overview = searchForMemberTab(roles, "overview");
  assert.equal(overview.toString(), "source=list");
  assert.equal(memberTabFromSearch(overview), "overview");
});