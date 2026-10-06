import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { createHash } from 'node:crypto';
import { handleCpdTemplates } from './cpdCertificateTemplatesApi.js';
import { __setRoleAccessOverlayForTests } from './roleVisibility.js';
__setRoleAccessOverlayForTests([]);
const tenant = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';

async function fixture() {
  const doc = await PDFDocument.create(); doc.addPage([500, 300]);
  const bytes = await doc.save();
  const template = { id, tenant_id: tenant, status: 'active', version: 3,
    source_bucket: 'private-uploads', source_path: `${tenant}/source.pdf`,
    source_sha256: createHash('sha256').update(bytes).digest('hex') };
  const state = { template, selected: null, rpc: [], excluded: [],
    fields: ['historic_event_title', 'cpd.cpd_points'].map((placeholder_key, index) => ({
      tenant_id: tenant, template_id: id, placeholder_key, page_number: 1,
      x: 20, y: 20 + index * 50, width: 400, height: 40,
    })), context: {
    isAuthenticated: true, tenantId: tenant, roleId: 'role', memberId: 'admin',
  } };
  const db = {
    from(table) {
      const filters = [];
      const result = () => {
        const rows = table === 'role' ? [{ id: 'role', tenant_id: tenant, excluded_features: state.excluded }]
          : table === 'cpd_certificate_template' ? [template]
          : table === 'cpd_certificate_placeholder' ? state.fields
          : table === 'historic_cpd_certificate' && state.selected ? [{ tenant_id: tenant, template_id: state.selected }]
          : [];
        return { data: rows.filter(row => filters.every(([key, value]) => row[key] === value)) };
      };
      const q = { select: () => q, order: () => q,
        eq(key, value) { filters.push([key, value]); return q; },
        maybeSingle: async () => ({ data: result().data[0] || null }),
        then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); } };
      return q;
    },
    storage: { from: () => ({ download: async () => ({ data: new Blob([bytes]) }) }) },
    async rpc(name, args) {
      state.rpc.push({ name, args });
      if (args.p_template_id && args.p_expected_version !== template.version) return { error: { code: '40001' } };
      state.selected = args.p_template_id;
      return {};
    },
  };
  state.request = async (body, method = 'PATCH') => {
    const out = { status: 200 };
    const res = { status(code) { out.status = code; return res; }, json(body) { out.body = body; return res; } };
    await handleCpdTemplates({ method, body, query: {} }, res, 'collection', {
      supabase: db, getTenantContext: async () => state.context,
    });
    return out;
  };
  return state;
}

test('authorized historic selection, replacement contract, reload and clear use tenant-scoped atomic RPC', async () => {
  const f = await fixture();
  assert.equal((await f.request({ historic_template_id: id, expectedVersion: 3 })).status, 200);
  assert.deepEqual(f.rpc[0], { name: 'set_historic_cpd_certificate',
    args: { p_tenant_id: tenant, p_template_id: id, p_expected_version: 3 } });
  assert.equal((await f.request({}, 'GET')).body.historic_template_id, id);
  assert.equal((await f.request({ historic_template_id: id, expectedVersion: 2 })).status, 409);
  assert.equal((await f.request({ historic_template_id: null })).status, 200);
  assert.equal((await f.request({}, 'GET')).body.historic_template_id, null);
});

test('historic selection denies foreign/inactive/private-source mismatches and capability failures', async () => {
  for (const mutate of [
    f => { f.template.tenant_id = 'foreign'; },
    f => { f.template.status = 'archived'; },
    f => { f.template.source_path = 'foreign/source.pdf'; },
    f => { f.template.source_sha256 = '0'.repeat(64); },
    f => { f.excluded = ['cpd.certificate-templates']; },
    f => { f.context.roleId = null; },
    f => { f.context.tenantMismatch = true; },
  ]) {
    const f = await fixture(); mutate(f);
    assert.ok((await f.request({ historic_template_id: id, expectedVersion: 3 })).status >= 400);
    assert.equal(f.rpc.length, 0);
  }
});

test('historic selection requires positioned title and points, allowing the existing activity title alias', async () => {
  for (const keys of [[], ['historic_event_title'], ['cpd.cpd_points'], ['event.name', 'cpd.cpd_points']]) {
    const f = await fixture();
    f.fields = keys.map(placeholder_key => ({ ...f.fields[0], placeholder_key }));
    const response = await f.request({ historic_template_id: id, expectedVersion: 3 });
    assert.equal(response.status, 409);
    assert.match(response.body.error, /positioned.*title.*points/i);
    assert.equal(f.rpc.length, 0);
  }
  const f = await fixture();
  f.fields[0].placeholder_key = 'cpd.activity_title';
  assert.equal((await f.request({ historic_template_id: id, expectedVersion: 3 })).status, 200);
});
