/**
 * Read-only DEST verification for the configured BNMS Department Name
 * organisation-directory source filter. No identity/contact values are read.
 */
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { createOrganisationDirectoryFilters } from "../api/_lib/organisationDirectoryFilters.js";

const TENANT_ID = "ff2df806-b321-4254-b651-3af11fccf1db";
const FIELD_KEY = "object-field:30ad9dde-4b4e-4991-a7a4-8ef2b6b5138e:target:cd1ebfd3-3e16-4091-be5a-99992d926f2f:35e4f2dd-6f22-4875-8d2f-4ffb05b1980f";
const FIELD_LABEL = "Organisation department: Name (Departments)";

if (!process.env.DEST_SUPABASE_URL || !process.env.DEST_SUPABASE_KEY) {
  throw new Error("DEST_SUPABASE_URL and DEST_SUPABASE_KEY are required");
}
const db = createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, {
  auth: { persistSession: false },
});
const checked = async (query, message) => {
  const result = await query;
  if (result.error) throw new Error(`${message}: ${result.error.message}`);
  return result.data || [];
};

// BNMS has no member-role object grant for this source. Select only the ID of
// an existing tenant administrator, matching the route's authorized admin
// branch without reading or reporting identity data.
const tenantUsers = await checked(
  db.from("tenant_user").select("id").eq("tenant_id", TENANT_ID)
    .order("id", { ascending: true }).limit(1),
  "Tenant administrator context",
);
assert.equal(tenantUsers.length, 1);
const service = createOrganisationDirectoryFilters({
  db,
  context: {
    tenantId: TENANT_ID,
    tenantUserId: tenantUsers[0].id,
    roleId: null,
    organizationId: null,
    isAuthenticated: true,
  },
  isAdmin: true,
});

const metadata = await service.metadata();
assert.deepEqual(metadata.fields, [{
  key: FIELD_KEY,
  label: FIELD_LABEL,
  field_type: "text",
  control: "source-choice",
  options: [],
  multi_select: false,
}]);
const options = await service.options({
  action: "options", fieldKey: FIELD_KEY, search: "", page: 1, pageSize: 50, selected: [],
});
assert.equal(options.total, 7);
assert.deepEqual(Object.keys(options).sort(), [
  "options", "page", "pageSize", "selectedOptions", "total", "unavailableSelected",
]);

const search = (filters = {}, extra = {}) => service.search({
  filters, search: "", sort: "asc", page: 1, pageSize: 12, ...extra,
});
const initial = await search();
assert.equal(initial.total, 279);
assert.deepEqual(Object.keys(initial).sort(), [
  "fields", "organizations", "page", "pageSize", "total",
]);
assert.ok(initial.organizations.every((row) =>
  Object.keys(row).sort().join(",") === "id,name"));

const selectionTotals = [];
for (const [index, option] of options.options.entries()) {
  const result = await search({ [FIELD_KEY]: { operator: "eq", value: option.value } });
  assert.ok(result.total > 0);
  const rehydrated = await service.options({
    action: "options",
    fieldKey: FIELD_KEY,
    search: "",
    page: 1,
    pageSize: 3,
    selected: [option.value],
  });
  assert.equal(rehydrated.total, 7);
  assert.equal(rehydrated.options.length, 3);
  assert.deepEqual(rehydrated.selectedOptions, [option]);
  assert.deepEqual(rehydrated.unavailableSelected, []);
  selectionTotals.push({ option: index + 1, total: result.total });
}
assert.deepEqual(await search({}), initial);

const descendingPageOne = await search({}, { sort: "desc", page: 1, pageSize: 5 });
const descendingPageTwo = await search({}, { sort: "desc", page: 2, pageSize: 5 });
const ascendingTail = await search({}, { sort: "asc", page: 3, pageSize: 100 });
assert.equal(descendingPageOne.total, 279);
assert.equal(descendingPageTwo.total, 279);
assert.equal(new Set(
  [...descendingPageOne.organizations, ...descendingPageTwo.organizations].map(({ id }) => id),
).size, 10);
assert.deepEqual(
  descendingPageOne.organizations.map(({ id }) => id),
  ascendingTail.organizations.slice(-5).reverse().map(({ id }) => id),
);

console.log(JSON.stringify({
  context: "existing BNMS tenant administrator; no identity fields read",
  metadataFields: metadata.fields,
  unfilteredTotal: initial.total,
  optionsTotal: options.total,
  selectionTotals,
  clearMatchesUnfiltered: true,
  descendingSortAndPagesVerified: [1, 2],
  organizationFields: ["id", "name"],
  searchResponseFields: Object.keys(initial).sort(),
  optionsResponseFields: Object.keys(options).sort(),
  writes: 0,
}));