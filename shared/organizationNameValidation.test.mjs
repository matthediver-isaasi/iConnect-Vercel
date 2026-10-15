import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {organizationNameError} from './organizationNameValidation.js';

test('explicit empty, whitespace, null and non-string organisation names are rejected',()=>{
  for(const name of ['', '   ', '\n\t', '\u00a0', null, undefined, 0, false, [], {}, ['Hospital']]){
    assert.equal(organizationNameError({name}),'Organisation name is required');
  }
});
test('partial updates that omit name remain valid and unchanged',()=>{
  for(const body of [{},{logo_url:'image.png'},{guest_access_enabled:true},{invoicing_address:'New address'}]){
    const before=structuredClone(body);
    assert.equal(organizationNameError(body),null);
    assert.deepEqual(body,before);
  }
});
test('valid names including Unicode and surrounding spaces are preserved',()=>{
  for(const name of ['BNMS', 'Hôpital Général', '病院', ' Hospital ']){
    const body={name};
    assert.equal(organizationNameError(body),null);assert.equal(body.name,name);
  }
});
test('organisation update endpoint rejects invalid names before its database mutation',()=>{
  const source=readFileSync(new URL('../api/entities/[entity]/[id].js',import.meta.url),'utf8');
  const gate=source.indexOf("if (entityNormalized === 'organization') {\n        const nameError = organizationNameError(req.body);");
  assert.ok(gate>0);
  assert.ok(source.indexOf('if (nameError) return res.status(400).json({ error: nameError });',gate)>gate);
  const mutation=source.indexOf('.update(sanitizedBody)',gate);
  assert.ok(mutation>gate);
});
test('editor validates before either new or existing organisation save',()=>{
  const source=readFileSync(new URL('../client/src/components/OrganisationDetailView.jsx',import.meta.url),'utf8');
  const save=source.slice(source.indexOf('const handleSave = async () => {'));
  const validation=save.indexOf("typeof formData.name !== 'string' || !formData.name.trim()");
  assert.ok(validation>=0&&validation<save.indexOf('if (isNew)'));
});

test('secondary admin endpoint validates names before building the update', () => {
  const source = readFileSync(new URL('../api/admin/organizations/[id].js', import.meta.url), 'utf8');
  const gate = source.indexOf('organizationNameError(rawUpdates)');
  assert.ok(gate > 0 && gate < source.indexOf('.update(updates)'));
  assert.ok(source.includes('if (nameError) return res.status(400).json({ error: nameError });'));
});

test('name-matching SQL import skips absent identifiers and coalesces blank names on update', () => {
  const source = readFileSync(new URL('../supabase/functions/import_organizations.sql', import.meta.url), 'utf8');
  assert.match(source, /IF rec.name IS NULL OR trim\(rec.name\) = '' THEN\s+skipped_count := skipped_count \+ 1;\s+CONTINUE;/);
  assert.match(source, /name\s+= COALESCE\(NULLIF\(trim\(rec.name\), ''\), name\)/);
});

test('member self-service organisation updates do not allow name changes', () => {
  const source = readFileSync(new URL('../api/my-organization.js', import.meta.url), 'utf8');
  const fields = source.match(/const allowedFields = \[([\s\S]*?)\];/)[1];
  assert.doesNotMatch(fields, /['"]name['"]/);
});
