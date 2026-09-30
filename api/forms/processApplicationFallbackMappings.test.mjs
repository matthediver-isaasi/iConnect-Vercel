import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./process-application.js', import.meta.url), 'utf8');

test('all modern application mapping paths validate and coalesce explicit fallback groups', () => {
  const validationCalls = source.match(/assertValidExplicitFallbackGroups\(/g) || [];
  const coalesceCalls = source.match(/coalesceExplicitFallbackMappings\(/g) || [];
  assert.ok(validationCalls.length >= 3, 'top-level, primary pipeline, and additional-member arrays must validate');
  assert.ok(coalesceCalls.length >= 3, 'top-level, primary pipeline, and additional-member arrays must coalesce');
});

test('modern field mapping writes extract selected address components before assignment', () => {
  const extractionCalls = source.match(/extractMappingSourceComponent\(/g) || [];
  assert.ok(extractionCalls.length >= 4, 'top-level, primary pipeline, and additional-member identity and writes must extract components');
  assert.match(source, /value = extractMappingSourceComponent\(mapping, form_values\[source_field_id\]\)/);
  assert.match(source, /value = extractMappingSourceComponent\(mapping, form_values\[mapping\.source_field_id\]\)/);
  assert.match(source, /memberEmail = extractMappingSourceComponent\(emailMapping, form_values\[emailMapping\.source_field_id\]\)/);
  assert.match(source, /memberEmail = applyTransformation\(memberEmail, emailMapping\.transformation\)/);
});

test('top-level and entity-pipeline mappings enforce the persisted address component contract', () => {
  const validationCalls = source.match(/assertValidAddressLookupMappingComponents\(/g) || [];
  assert.ok(validationCalls.length >= 3, 'top-level, primary pipeline, and additional members must validate address components');
  assert.match(source, /code === 'INVALID_FORM_ADDRESS_COMPONENT_MAPPING'/);
});

test('additional-member identity and writes use the coalesced visible mappings', () => {
  assert.match(source, /additionalMemberMappingSelection = selectMappingsForSubmission\(memberConfig\.mappings/);
  assert.match(source, /const effectiveMemberMappings = coalesceExplicitFallbackMappings\(\s*additionalMemberMappingSelection\.includedMappings,\s*form_values,\s*hiddenSubmissionFieldIds/);
  assert.match(source, /const emailMapping = effectiveMemberMappings\.find/);
  assert.match(source, /for \(const mapping of effectiveMemberMappings\)/);
  assert.match(source, /email fallback resolved to explicit clear/);
  assert.match(source, /if \(mapping\.source_type === 'clear'\) \{\s*value = '__clear__'/);
});

test('all modern mapping arrays filter opted-in hidden sources before fallback resolution', () => {
  const selectionCalls = source.match(/selectMappingsForSubmission\(/g) || [];
  assert.ok(selectionCalls.length >= 3, 'top-level, shared primary, and additional mapping arrays must select against persisted visibility');
  assert.match(source, /partitionIgnoredHiddenMappings\(mappings, hiddenSubmissionFieldIds\)/);
  assert.match(source, /topLevelMappingSelection\.includedMappings/);
  assert.match(source, /mappingSelection\.includedMappings/);
  assert.match(source, /additionalMemberMappingSelection\.includedMappings/);
  assert.match(source, /kind: 'hidden_mapping_ignored'/);
});

test('create and upsert pipelines record explicit no-ops when hidden mappings remove identity', () => {
  assert.match(source, /primaryIdentityLostOnlyToHiddenMapping\(primaryOrgMappingSelection, 'organization'\)/);
  assert.match(source, /primaryIdentityLostOnlyToHiddenMapping\(primaryMemberMappingSelection, 'member'\)/);
  assert.match(source, /selectionLostIdentityOnlyToHiddenMapping\(additionalMemberMappingSelection, 'member'\)/);
  const skipNotes = source.match(/kind: 'entity_pipeline_skipped_hidden_identity'/g) || [];
  assert.ok(skipNotes.length >= 3, 'primary member, primary organisation, and additional members need explicit skip outcomes');
});

test('all organisation dropdown mapping modes share not-listed name resolution', () => {
  assert.match(source, /const resolveOrgDropdownMapping = \(sourceFieldId, targetField\)/);
  const resolutionCalls = source.match(/resolveOrgDropdownMapping\(/g) || [];
  assert.equal(resolutionCalls.length, 4, 'modern, legacy fallback, array pipeline, and legacy object pipeline mappings must resolve identically');
  assert.match(source, /if \(resolved\?\.organizationName\) \{\s*assignOrganizationCore\(orgData, 'name', resolved\.organizationName,/);
  assert.match(source, /if \(resolved\?\.organizationName\) \{\s*assignOrganizationCore\(dataObj, 'name', resolved\.organizationName,/);
  assert.match(source, /else if \(resolved\?\.organizationId && !dropdownSelectedOrgId\)/);
  assert.match(source, /if \(!pipelineEntry\.mappings && pipelineEntry\.field_mappings\)[\s\S]*resolveOrgDropdownMapping\(fieldId, dbKey\)[\s\S]*used_not_listed_name/);
  assert.match(source, /if \(!orgData\.name\) \{[\s\S]*code: 'MISSING_ORG_NAME'/);
});