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
