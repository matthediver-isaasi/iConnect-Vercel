import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("contextual create dialog uses generic field controls and transactional creation", async () => {
  const source = await readFile(new URL("./ContextualRecordCreateDialog.jsx", import.meta.url), "utf8");
  assert.match(source, /RecordFieldControl/);
  assert.match(source, /createWithRelationships/);
  assert.match(source, /originating_relationship/);
  assert.match(source, /initial_relationships/);
  assert.match(source, /oppositeSide\(originSide\)/);
  assert.match(source, /initialRelationshipCandidates/);
  assert.doesNotMatch(source, /relationshipRoutes\.picker\(objectId/);
  assert.match(source, /Loading eligible records/);
  assert.match(source, />Retry</);
  assert.match(source, /loadRelationshipDefinitions\(targetObject\.id\)/);
  assert.match(source, /metadataError \? <div/);
  assert.match(source, /relationshipSelectorKey\(selector\.definition\.id, selector\.side\)/);
  assert.match(source, /isRequiredInitialRelationship\(selector\.definition, selector\.side\)/);
  assert.match(source, /relationshipSelectorKey\(definition\.id, side\) !== originKey/);
  assert.match(source, /Record details/);
  assert.match(source, /Parent relationship/);
  assert.match(source, /Additional relationships/);
  assert.match(source, /Required/);
  assert.match(source, /Optional/);
  assert.match(source, /You can leave this empty/);
  assert.match(source, /initialRelationshipLabel\(definition, side\)/);
  assert.match(source, /\.flatMap\(\(\{ definition, side \}\)/);
});

test("related panels gate contextual creation through the endpoint eligibility helper", async () => {
  const source = await readFile(new URL("./RelatedRecordsPanel.jsx", import.meta.url), "utf8");
  assert.match(source, /contextualCreateEligibility/);
  assert.match(source, /ContextualRecordCreateDialog/);
});