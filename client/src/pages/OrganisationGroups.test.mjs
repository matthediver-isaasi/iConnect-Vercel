import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// Exercise the page's actual query function with the real admin helper and SDK.
// All HTTP is replaced locally: these tests never contact an application or DB.
const source = await readFile(new URL("./OrganisationGroups.jsx", import.meta.url), "utf8");
const detailSource = await readFile(
  new URL("../components/OrganisationGroupDetailView.jsx", import.meta.url), "utf8",
);
const queryBody = source.match(
  /queryKey: \["organisation-groups-orgs"\],[\s\S]*?queryFn: \(\) => ([^\n]+),/,
)?.[1];
assert.ok(queryBody, "Organisation Groups organisation query must be present");

const bundle = await build({
  entryPoints: [resolve("client/src/lib/adminOrgList.js")],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  packages: "external",
});
const outputPath = resolve("tmp", `organisation-groups-query-${process.pid}.mjs`);
await mkdir(resolve("tmp"), { recursive: true });
await writeFile(outputPath, bundle.outputFiles[0].text);
let adminList;
try {
  adminList = await import(pathToFileURL(outputPath).href);
} finally {
  await unlink(outputPath);
}
const query = new Function(
  "listAllOrganizationsForAdmin",
  `return () => ${queryBody};`,
)(adminList.listAllOrganizationsForAdmin);

const groupId = "fixture-imported-group";
const orgs = [
  ...Array.from({ length: 14 }, (_, i) => ({
    id: `live-${i}`, name: `Live ${i}`, application_status: "Live",
  })),
  ...Array.from({ length: 6 }, (_, i) => ({
    id: `null-${i}`, name: `No status ${i}`, application_status: null,
  })),
  { id: "atu", name: "ATU", application_status: "Full application received" },
  { id: "nci", name: "NCI", application_status: "Verified" },
].map(org => ({ ...org, organization_group_id: groupId }));

function installFetch(t, rows, { failOffset = null } = {}) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const url = new URL(input, "https://fixture.invalid");
    assert.equal(url.pathname, "/api/entities/Organization");
    assert.equal(options.credentials, "include");
    const params = url.searchParams;
    const offset = Number(params.get("offset") || 0);
    requests.push(params);
    if (offset === failOffset) {
      return new Response(JSON.stringify({ error: "Fixture page failed" }), { status: 500 });
    }
    const visible = params.get("skipDirectoryFilters") === "true"
      ? rows : rows.filter(org => org.application_status === "Live");
    return Response.json(visible.slice(offset, offset + Number(params.get("limit") || 1000)));
  });
  return requests;
}

test("group query requests all 22 assigned organisations, not just the 14 Live directory entries", async t => {
  const requests = installFetch(t, orgs);
  const result = await query();
  assert.equal(result.length, 22);
  assert.equal(result.filter(org => org.application_status === null).length, 6);
  assert.deepEqual(result.filter(org => ["atu", "nci"].includes(org.id)).map(org => org.id), ["atu", "nci"]);
  assert.equal(requests[0].get("skipDirectoryFilters"), "true");
  assert.equal(requests[0].get("limit"), "1000");
  assert.deepEqual(JSON.parse(requests[0].get("sort")), { name: "asc", id: "asc" });
  // Both list counts and the detail receive this same query result.
  const countBody = source.match(/const orgsByGroup = useMemo\(\(\) => \{([\s\S]*?)\}, \[orgs\]\);/)?.[1];
  assert.ok(countBody);
  assert.equal(new Function("orgs", countBody)(result)[groupId].length, 22);
  const detailRows = detailSource.match(/const memberOrgs = ([^\n]+);/)?.[1];
  assert.ok(detailRows);
  assert.equal(new Function("orgs", "groupId", `return ${detailRows};`)(result, groupId).length, 22);
  assert.match(source, /<OrganisationGroupDetailView[\s\S]*?orgs=\{orgs\}/);
});

test("group query delegates pagination to listAll and preserves bypass and stable sort on every page", async t => {
  const rows = Array.from({ length: 1022 }, (_, i) => ({
    id: String(i).padStart(4, "0"), name: "Duplicate name", organization_group_id: groupId,
  }));
  const requests = installFetch(t, rows);
  const result = await query();
  assert.equal(result.length, 1022);
  assert.equal(new Set(result.map(org => org.id)).size, 1022);
  assert.deepEqual(requests.map(params => Number(params.get("offset") || 0)), [0, 1000]);
  for (const params of requests) {
    assert.equal(params.get("skipDirectoryFilters"), "true");
    assert.equal(params.get("limit"), "1000");
    assert.deepEqual(JSON.parse(params.get("sort")), { name: "asc", id: "asc" });
  }
});

test("a later page failure rejects instead of displaying a silently truncated group", async t => {
  installFetch(t, Array.from({ length: 1001 }, (_, i) => ({ id: String(i) })), { failOffset: 1000 });
  await assert.rejects(query(), /Fixture page failed/);
});