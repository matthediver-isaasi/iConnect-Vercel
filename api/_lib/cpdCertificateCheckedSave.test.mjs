import test from 'node:test';
import assert from 'node:assert/strict';
import { handleCpdTemplates, validPlaceholders } from './cpdCertificateTemplatesApi.js';
import { serializeCertificatePlaceholder } from '../../client/src/lib/cpdCertificateContract.js';
import { CPD_TEXT_EXAMPLE } from '../../shared/cpdCertificateDisplay.js';

const field = validPlaceholders([serializeCertificatePlaceholder({
  key: 'text.credits', text_template: CPD_TEXT_EXAMPLE, page: 1,
  x: 20, y: 20, width: 500, height: 100, font_size: 18,
})])[0];
function fixture(rpcError) {
  const templates = [{ id: 'original', tenant_id: 'tenant', name: 'Original',
    status: 'draft', version: 1, source_geometry: [{ width: 600, height: 800 }] }];
  const fields = [{ ...field, tenant_id: 'tenant', template_id: 'original' }];
  const calls = [];
  const db = {
    from(table) {
      const rows = table === 'role' ? [{ id: 'role', tenant_id: 'tenant', excluded_features: [] }]
        : table === 'cpd_certificate_template' ? templates : fields;
      let filters = [], single = false, op, input;
      const q = {
        select() { return q; }, order() { return q; },
        eq(k, v) { filters.push(r => r[k] === v); return q; },
        maybeSingle() { single = true; return q; }, single() { single = true; return q; },
        insert(value) { op = 'insert'; input = value; return q; },
        delete() { op = 'delete'; return q; },
        then(resolve, reject) {
          if (op === 'insert') rows.push(...(Array.isArray(input) ? input : [{ id: 'copy', version: 1, ...input }]));
          let data = rows.filter(r => filters.every(f => f(r)));
          if (op === 'insert') data = rows.slice(-1);
          if (op === 'delete') for (const row of data) rows.splice(rows.indexOf(row), 1);
          return Promise.resolve({ data: single ? data[0] : data, error: null }).then(resolve, reject);
        },
      }; return q;
    },
    async rpc(name, args) {
      calls.push({ name, args });
      if (!rpcError) { fields.splice(0, fields.length, ...args.p_placeholders.map(f => ({ ...f, tenant_id: 'tenant', template_id: 'original' }))); templates[0].version++; }
      return { error: rpcError };
    },
  };
  const dependencies = { supabase: db, getTenantContext: async () =>
    ({ isAuthenticated: true, tenantId: 'tenant', roleId: 'role', memberId: 'member' }) };
  const invoke = async (operation, method, body) => {
    const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(value) { this.body = value; return this; } };
    await handleCpdTemplates({ method, query: { id: 'original' }, body }, res, operation, dependencies);
    return res;
  };
  return { invoke, calls, fields, templates };
}
test('API fails closed for missing RPC, missing column and stale projection', async () => {
  for (const error of [{ code: 'PGRST202' }, { code: '42703' }, { message: 'cpd_text_schema_incompatible' }]) {
    const f = fixture(error);
    const res = await f.invoke('item', 'PUT', { expectedVersion: 1, placeholders: [field] });
    assert.equal(res.statusCode, 503);
    assert.match(res.body.error, /Keep this editor open/);
    assert.equal(f.calls[0].name, 'save_cpd_certificate_template_checked');
    assert.equal(f.templates[0].version, 1);
    assert.equal(f.fields[0].text_template, CPD_TEXT_EXAMPLE);
  }
});
test('API successful edit, reload and template duplication retain authored configuration', async () => {
  const f = fixture();
  const text = `Updated: ${CPD_TEXT_EXAMPLE}`;
  const saved = await f.invoke('item', 'PUT', { expectedVersion: 1, placeholders: [{ ...field, text_template: text }] });
  assert.equal(saved.body.template.placeholders[0].text_template, text);
  assert.equal((await f.invoke('item', 'GET')).body.template.placeholders[0].text_template, text);
  const copied = await f.invoke('duplicate', 'POST', {});
  assert.equal(copied.statusCode, 201);
  assert.equal(copied.body.template.placeholders[0].text_template, text);
});
