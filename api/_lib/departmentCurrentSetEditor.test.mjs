import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import handler from '../forms/[formId]/editor-metadata.js';
import { DEPARTMENT_CURRENT_SET_FORM_ID as formId, DEPARTMENT_CURRENT_SET_TENANT_ID as tenantId } from './departmentCurrentSet.js';
import { loadFormEditorMetadata } from '../../client/src/lib/formEditorMetadata.js';
import { departmentBuilderFields, saveDepartmentBuilderFields, DEPARTMENT_SELECTOR_ID } from '../../client/src/lib/departmentSelectorBuilder.js';
import { departmentSelectorAnchor, showDepartmentSelector } from '../../client/src/lib/departmentSelectorPlacement.js';
import { normalizeFormEditorSave } from '../../client/src/lib/formEditorSave.js';
import { stripGenericServerOwnedFields } from './serverOwnedEntityBoundary.js';

const otherId = '11111111-1111-4111-8111-111111111111';
// The generic Form.list() shape that caused the regression: no derived flag.
const genericForm = { id: formId, tenant_id: tenantId, fields: [], pages: [], layout_type: 'standard' };
const configuration = {
  workforce_container_field_id: 'workforce', equipment_container_field_id: 'equipment',
  department_object_id: 'private-object', respondent_relationship_id: 'private-relationship',
  workforce_fields: { private: 'mapping' },
};
function fixture({ forms = [genericForm], configs = [{ tenant_id: tenantId, form_id: formId, config: configuration }], failure } = {}) {
  const queries = [];
  const db = {
    from(table) {
      const filters = [];
      queries.push({ table, filters });
      return {
        select(columns) { queries.at(-1).columns = columns; return this; },
        eq(key, value) { filters.push([key, value]); return this; },
        async maybeSingle() {
          if (table === 'department_current_set_config' && failure) {
            if (failure === 'throw') throw new Error('offline');
            return { data: null, error: { code: failure } };
          }
          const rows = table === 'form' ? forms : configs;
          return { data: rows.find(row => filters.every(([key, value]) => row[key] === value)) || null, error: null };
        },
      };
    },
  };
  const context = { isAuthenticated: true, tenantId };
  async function request({ contextOverride, admin = true, id = formId, method = 'GET' } = {}) {
    const res = {
      statusCode: 200, headers: {}, body: null,
      setHeader(key, value) { this.headers[key] = value; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await handler({ method, query: { formId: id } }, res, {
      db, getTenantContext: async () => ({ ...context, ...contextOverride }), hasAdminAccess: async () => admin,
    });
    return res;
  }
  const fetchMetadata = async (url, options, intendedTenant) => {
    assert.equal(url, `/api/forms/${formId}/editor-metadata`);
    assert.equal(intendedTenant, tenantId);
    const response = await request();
    return { ok: response.statusCode === 200, json: async () => response.body };
  };
  return { queries, request, metadata: () => loadFormEditorMetadata({ formId, tenantId, fetchMetadata }) };
}

test('real editor metadata restores missing generic-list flag including empty configured forms', async () => {
  const f = fixture();
  assert.equal(Object.hasOwn(genericForm, 'current_set_enabled'), false);
  assert.deepEqual(departmentBuilderFields(genericForm), []);
  const response = await f.request();
  assert.deepEqual(response.body, { form_id: formId, current_set_enabled: true });
  assert.equal(response.headers['Cache-Control'], 'private, no-store');
  const metadata = await f.metadata();
  const fields = departmentBuilderFields({ ...genericForm, ...metadata });
  assert.equal(fields.length, 1);
  assert.equal(fields[0].id, DEPARTMENT_SELECTOR_ID);
  assert.equal(Object.hasOwn(genericForm, 'current_set_enabled'), false);
  assert.ok(f.queries.every(query => query.filters.some(([key, value]) => key === 'tenant_id' && value === tenantId)));
  assert.ok(f.queries.every(query => ['form', 'department_current_set_config'].includes(query.table)));
});

test('unconfigured and ordinary Department dropdown forms gain no selector or config query', async () => {
  const ordinary = { ...genericForm, id: otherId, name: 'Department', fields: [
    { id: 'department', type: 'relationship_dropdown', label: 'Department', target: 'Department' },
  ] };
  const f = fixture({ forms: [ordinary] });
  const response = await f.request({ id: otherId });
  assert.deepEqual(response.body, { form_id: otherId, current_set_enabled: false });
  assert.deepEqual(departmentBuilderFields({ ...ordinary, ...response.body }), ordinary.fields);
  assert.equal(f.queries.length, 1);
  assert.equal((await fixture({ configs: [] }).metadata()).current_set_enabled, false);
});

test('authentication, admin access, stale tenant and cross-tenant IDs fail before reading privileged configuration', async () => {
  for (const [args, status] of [
    [{ contextOverride: { isAuthenticated: false } }, 401],
    [{ admin: false }, 403],
    [{ contextOverride: { tenantMismatch: true } }, 409],
    [{ contextOverride: { tenantId: otherId } }, 404],
    [{ method: 'POST' }, 405],
  ]) {
    const f = fixture();
    assert.equal((await f.request(args)).statusCode, status);
    assert.equal(f.queries.some(q => q.table === 'department_current_set_config'), false);
  }
  // Even a copied form with the pinned ID in another tenant is not eligible.
  const f = fixture({ forms: [{ ...genericForm, tenant_id: otherId }] });
  assert.equal((await f.request({ contextOverride: { tenantId: otherId } })).body.current_set_enabled, false);
  assert.equal(f.queries.length, 1);
});

test('unavailable configuration and legacy schema never become confirmed disablement', async () => {
  for (const failure of ['throw', '57014', '42P01', '42703', 'PGRST205']) {
    const f = fixture({ failure });
    const response = await f.request();
    assert.equal(response.statusCode, 503);
    assert.equal(Object.hasOwn(response.body, 'current_set_enabled'), false);
    await assert.rejects(f.metadata(), /could not be verified/);
  }
  const malformed = fixture({ configs: [{ tenant_id: tenantId, form_id: formId, config: {} }] });
  assert.equal((await malformed.request()).statusCode, 503);
  // Older schemas must not prevent unrelated forms loading.
  const unrelated = fixture({ forms: [{ ...genericForm, id: otherId }], failure: '42P01' });
  assert.equal((await unrelated.request({ id: otherId })).statusCode, 200);
});

test('position save/reopen uses metadata, preserves first-page anchors and never saves a capability or answer field', async () => {
  const f = fixture();
  const raw = { ...genericForm, pages: [{ id: 'first' }, { id: 'second' }], fields: [
    { id: 'intro', page_id: 'first' }, { id: 'name', page_id: 'first' }, { id: 'later', page_id: 'second' },
  ] };
  for (const position of [1, 2]) {
    const [selector, ...fields] = departmentBuilderFields({ ...raw, ...await f.metadata() });
    fields.splice(position, 0, selector);
    const saved = normalizeFormEditorSave({ ...raw, fields: saveDepartmentBuilderFields(fields), ...await f.metadata() });
    assert.equal(Object.hasOwn(saved, 'current_set_enabled'), false);
    assert.equal(saved.fields.some(field => field.type === 'department_selector_layout'), false);
    const reopened = departmentBuilderFields({ ...saved, ...await f.metadata() });
    assert.deepEqual(reopened.map(field => field.id), fields.map(field => field.id));
    const anchor = departmentSelectorAnchor(saved);
    assert.equal(anchor, position === 1 ? 'name' : 'name:after');
    for (const surface of ['standalone', 'embedded', 'Canvas']) {
      assert.equal(showDepartmentSelector({ form: saved, fieldId: anchor }), true, surface);
      assert.equal(showDepartmentSelector({ form: saved, fieldId: anchor, firstPage: false }), false, surface);
    }
  }
  const card = departmentBuilderFields({ ...raw, layout_type: 'card_swipe', ...await f.metadata() });
  assert.equal(card[0].id, DEPARTMENT_SELECTOR_ID);
  assert.equal(card[0].fixed, true);
  const mixed = saveDepartmentBuilderFields([{ id: 'unassigned' }, card[0], { id: 'later', page_id: 'second' }]);
  assert.equal(mixed[0].department_selector_after, true);
});

test('derived capability cannot enter generic Form creates/updates or editor saves', () => {
  const payload = { name: 'Form', current_set_enabled: true, current_set_configuration: configuration };
  assert.deepEqual(stripGenericServerOwnedFields('Form', payload), { name: 'Form' });
  assert.deepEqual(stripGenericServerOwnedFields('form', [payload]), [{ name: 'Form' }]);
  assert.deepEqual(normalizeFormEditorSave(payload), { name: 'Form', fields: [], structured_actions: { version: 1, actions: [] } });
});

test('builder consumes the separate tenant-scoped read and retains loading/error gates and virtual rendering', async () => {
  const source = await readFile('client/src/pages/FormBuilder.jsx', 'utf8');
  assert.match(source, /base44.entities.Form.list\(\)/);
  assert.match(source, /queryKey: \['form-editor-metadata', activeTenantId, formId\]/);
  assert.match(source, /loadFormEditorMetadata\(\{ formId, tenantId: activeTenantId, fetchMetadata: adminFetch \}\)/);
  assert.match(source, /current_set_enabled: editorMetadataQuery.data\?\.current_set_enabled === true/);
  assert.doesNotMatch(source, /existingForm\?\.current_set_enabled/);
  assert.match(source, /editorMetadataQuery.isError/);
  assert.match(source, /formId && !editorMetadataQuery.data/);
  assert.match(source, /builderFields.length === 0/);
  assert.match(source, /target.pageId !== formData.pages\[0\].id/);
  const card = source.slice(source.indexOf('function BuilderFieldCard('), source.indexOf('function FieldCard('));
  assert.doesNotMatch(card, /onClick|removeField|duplicateField/);
  assert.match(card, /isDragDisabled=\{props.field.fixed\}/);
});
