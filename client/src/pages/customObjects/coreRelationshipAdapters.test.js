import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const adapters = [
  ["Organisation", new URL("../../components/OrganisationDetailView.jsx", import.meta.url)],
  ["routed Member", new URL("../MemberDetail.jsx", import.meta.url)],
  ["Organisation Group", new URL("../../components/OrganisationGroupDetailView.jsx", import.meta.url)],
];

test("all core detail adapters use the shared relationship renderer", async () => {
  for (const [name, path] of adapters) {
    const source = await readFile(path, "utf8");
    assert.match(source, /useRelatedRecordDefinitions/, `${name} must use shared metadata adapter`);
    assert.match(source, /<RelatedRecordsPanel/, `${name} must use shared row renderer`);
    assert.doesNotMatch(source, /(?:Department|Qualification|Chapter)Related/, `${name} must stay object-agnostic`);
  }
});

test("the reusable member detail view also uses the generic surface", async () => {
  const source = await readFile(
    new URL("../../components/MemberDetailView.jsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /useRelatedRecordDefinitions/);
  assert.match(source, /<RelatedRecordsPanel/);
});

test("the routed member overview embeds configured relationships without removing tabs", async () => {
  const source = await readFile(
    new URL("../MemberDetail.jsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /relatedRecords\.isSuccess \? relatedRecords\.panels : null/);
  assert.match(source, /field\.type === 'relationship'/);
  assert.match(source, /<RelatedRecordsPanel[\s\S]*?embedded/);
  assert.match(source, /relationshipTabValue\(definition, side\)/);
});

test("organisation groups preserve the old surface when definitions are empty", async () => {
  const source = await readFile(
    new URL("../../components/OrganisationGroupDetailView.jsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /relatedRecords\.panels\.length === 0 \? renderOverview\(\)/);
});