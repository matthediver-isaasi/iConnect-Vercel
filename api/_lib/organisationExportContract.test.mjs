import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  organisationExportCountError,
  parseExpectedOrganisationExportTotal,
  shouldRejectEmptyOrganisationExport,
} from './organisationExportContract.js';

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
const list = read('../../client/src/pages/OrganisationsList.jsx');
const exported = read('../admin/organisations/export-csv.js');

test('organisation export count contract rejects empty and mismatched POST results', () => {
  assert.equal(parseExpectedOrganisationExportTotal('POST', 925), 925);
  assert.match(organisationExportCountError(925, 0), /found no organisations/);
  assert.match(organisationExportCountError(925, 924), /found 924 organisations/);
  assert.equal(organisationExportCountError(925, 925), null);
  assert.equal(shouldRejectEmptyOrganisationExport('POST', 0), true);
});

test('ordinary and filtered organisation exports carry the displayed total', () => {
  assert.match(list, /const selectableTotal = pagination\.selectableTotal \?\? pagination\.total/);
  assert.match(list, /body\.expectedTotal = selectableTotal/);
  assert.match(list, /params\.set\('search', debouncedSearch\.trim\(\)\)/);
  assert.match(list, /params\.set\('group', groupFilter\)/);
  assert.match(list, /params\.set\('coreFilters', coreFiltersParam\)/);
  assert.match(list, /params\.set\('customFieldFilters', customFiltersParam\)/);
  assert.match(exported, /organisationExportCountError\(expectedTotal, actualTotal\)/);
});

test('select-all count excludes the visible but non-selectable primary organisation', () => {
  const paginated = read('../admin/organizations/paginated.js');
  assert.match(paginated, /applyFilters\(selectableCountQuery\)\.neq\('is_primary', true\)/);
  assert.match(paginated, /selectableTotal: selectableCount \|\| 0/);
  assert.match(list, /Export CSV \{selectAllFiltered \? `\(\$\{selectableTotal\}\)`/);
  assert.match(exported, /if \(excludePrimary === 'true'\)/);
});

test('explicit selections and dashboard drill-down scopes use the POST body', () => {
  assert.match(list, /body\.selectedIds = selectedOrgs/);
  assert.match(list, /body\.expectedTotal = selectedOrgs\.length/);
  assert.match(list, /body\.drillIds = drillIdsParam/);
  assert.match(list, /method: 'POST'/);
  assert.match(exported, /req\.body\?\.selectedIds/);
  assert.match(exported, /req\.body\?\.drillIds/);
  assert.match(exported, /if \(drillIds\.length > 0\) q = q\.in\('id', drillIds\)/);
});

test('organisation export rejects bad counts before starting the download', () => {
  const countValidation = exported.indexOf('const countError = organisationExportCountError');
  const headers = exported.indexOf("res.setHeader('Content-Type'");
  assert.ok(countValidation >= 0 && headers > countValidation);
  assert.match(exported, /res\.status\(409\)\.json\(\{ error: countError, expectedTotal, actualTotal \}\)/);
  assert.match(exported, /res\.status\(422\)\.json\(\{ error: 'There are no organisations to export/);
  assert.match(list, /await response\.json\(\)\.catch/);
});