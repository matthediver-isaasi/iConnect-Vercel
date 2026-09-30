import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const indexSource = fs.readFileSync(
  new URL('../entities/[entity]/index.js', import.meta.url), 'utf8',
);
const idSource = fs.readFileSync(
  new URL('../entities/[entity]/[id].js', import.meta.url), 'utf8',
);

test('generic entity routes cannot create or mutate the CSV directory setting', () => {
  for (const source of [indexSource, idSource]) {
    assert.match(source, /DEDICATED_ORGANISATION_DIRECTORY_SETTINGS/);
    assert.match(source, /'org_directory_allow_csv_download'/);
    assert.match(source, /'org_directory_filterable_back_fields'/);
    assert.match(source, /Organisation directory settings must be managed through their dedicated endpoint/);
  }
  // Collection POST checks submitted keys. Item PATCH/PUT/DELETE checks both
  // a forged submitted key and the tenant-scoped existing row's key.
  assert.match(indexSource, /req\.method === 'POST'[\s\S]*DEDICATED_ORGANISATION_DIRECTORY_SETTINGS\.has\(req\.body\?\.setting_key\)/);
  assert.match(idSource, /\['PATCH', 'PUT', 'DELETE'\]\.includes\(req\.method\)[\s\S]*DEDICATED_ORGANISATION_DIRECTORY_SETTINGS\.has\(req\.body\?\.setting_key\)[\s\S]*DEDICATED_ORGANISATION_DIRECTORY_SETTINGS\.has\(directorySetting\?\.\[0\]\?\.setting_key\)/);
});