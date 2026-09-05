import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("contextual create dialog uses generic field controls and transactional creation", async () => {
  const source = await readFile(new URL("./ContextualRecordCreateDialog.jsx", import.meta.url), "utf8");
  assert.match(source, /RecordFieldControl/);
  assert.match(source, /contextualPrimaryNameSuggestion/);
  assert.match(source, /primaryNameOverridden/);
  assert.match(source, /Suggested from the linked records\. You can change this name\./);
  assert.match(source, /related_record_id: relatedRecord\.id/);
  assert.match(source, /createWithRelationships/);
  assert.match(source, /originating_relationship/);
  assert.match(source, /initial_relationships/);
  assert.match(source, /oppositeSide\(originSide\)/);
  assert.doesNotMatch(source, /relationshipRoutes\.picker\(objectId/);
  assert.match(source, /loadRelationshipDefinitions\(targetObject\.id\)/);
  assert.match(source, /metadataError \? \(/);
  assert.match(source, /relationshipSelectorKey\(selector\.definition\.id, selector\.side\)/);
  assert.match(source, /isRequiredInitialRelationship\(selector\.definition, selector\.side\)/);
  assert.match(source, /relationshipSelectorKey\(definition\.id, side\) !== originKey/);
  assert.match(source, /Record details/);
  assert.match(source, /Parent relationship/);
  assert.match(source, /Additional relationships/);
  assert.match(source, /initialRelationshipLabel\(selector\.definition, selector\.side\)/);
  assert.match(source, /\.flatMap\(\(\{ definition, side \}\)/);
});

test("initial relationship selector searches and paginates bounded candidate results", async () => {
  const source = await readFile(new URL("./InitialRelationshipSelector.jsx", import.meta.url), "utf8");
  assert.match(source, /initialRelationshipCandidates/);
  assert.match(source, /Loading eligible records/);
  assert.match(source, />Retry</);
  assert.match(source, /SEARCH_DELAY_MS = 250/);
  assert.match(source, /debouncedSearch/);
  assert.match(source, /pageSize: PAGE_SIZE/);
  assert.match(source, /search: debouncedSearch/);
  assert.match(source, /Page \{page\} of \{pages\}/);
  assert.match(source, /selected\.map/);
  assert.match(source, /relationshipCandidateLabel/);
  assert.match(source, /Previous \$\{label\} page/);
  assert.match(source, /Next \$\{label\} page/);
  assert.match(source, /Required/);
  assert.match(source, /Optional/);
  assert.match(source, /You can leave this empty/);
});

test("related panels gate contextual creation through the endpoint eligibility helper", async () => {
  const source = await readFile(new URL("./RelatedRecordsPanel.jsx", import.meta.url), "utf8");
  assert.match(source, /contextualCreateEligibility/);
  assert.match(source, /ContextualRecordCreateDialog/);
  assert.match(source, /originRecord=\{record\}/);
});