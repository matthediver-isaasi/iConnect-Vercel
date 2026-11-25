import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { INVOICING_ADDRESS_KEYS } from '../../shared/invoicingAddress.js';
import { takeOrganizationInvoicingAddress, saveFormOrganizationInvoicingAddress } from './formOrganizationInvoicingAddress.js';
import { ORGANIZATION_CORE_FIELD_MAPPINGS } from './formPrimaryOrganizationPipeline.js';
import { processPersistedStructuredActions, validateStructuredActionsContract } from './formStructuredActions.js';

test('private address destinations are core mappings, not public prefill fields', () => {
  for (const key of INVOICING_ADDRESS_KEYS) assert.equal(ORGANIZATION_CORE_FIELD_MAPPINGS[key], key);
  const source = readFileSync(new URL('../../client/src/pages/FormBuilder.jsx', import.meta.url), 'utf8');
  assert.match(source, /organization: ORG_MAPPING_FIELDS/);
  assert.match(source, /MEMBER_CORE_FIELDS : ORG_MAPPING_FIELDS/);
  assert.doesNotMatch(source.match(/const ORG_CORE_FIELDS = \[[\s\S]*?\n\];/)[0], /INVOICING_ADDRESS_FIELDS/);
  assert.doesNotMatch(source.match(/const ORG_PREFILL_FIELDS = \[[\s\S]*?\n\];/)[0], /INVOICING_ADDRESS_FIELDS/);
});

test('split core destinations retain the legacy address, normalize text and support explicit clears', () => {
  const core = { name: 'Test', invoicing_address: 'Legacy address',
    invoicing_address_line1: ' 10 High Street ', invoicing_city: '__clear__', invoicing_country: ' United Kingdom ' };
  assert.deepEqual(takeOrganizationInvoicingAddress(core), {
    invoicing_address_line1: '10 High Street', invoicing_city: null, invoicing_country: 'United Kingdom',
  });
  assert.deepEqual(core, { name: 'Test', invoicing_address: 'Legacy address' });
  for (const value of [{ city: 'secret' }, ['London'], 123, 'a\nb', 'x'.repeat(101)]) {
    assert.throws(() => takeOrganizationInvoicingAddress({ invoicing_city: value }), /Invoicing city/);
  }
});

function fixture({ denied = false, owner = true, rpcError = null, rpcData = [{}] } = {}) {
  const calls = [];
  const q = { select() { return this; }, eq(key, value) { calls.push([key, value]); return this; },
    async maybeSingle() { return { data: owner ? { id: 'org' } : null }; } };
  return {
    calls,
    db: { from(table) { calls.push(table); return q; },
      async rpc(name, args) { calls.push({ name, args }); return { data: rpcData, error: rpcError }; } },
    async authorize() { calls.push('authorized'); if (denied) throw new Error('Forbidden'); },
  };
}

test('private writes authorize first, verify the tenant owner, and use only the private RPC', async () => {
  const f = fixture();
  const address = { invoicing_city: 'London', invoicing_address_line2: null };
  await saveFormOrganizationInvoicingAddress({ ...f, tenantId: 'tenant', organizationId: 'org', address });
  assert.equal(f.calls[0], 'authorized');
  assert.ok(f.calls.some(c => Array.isArray(c) && c[0] === 'tenant_id' && c[1] === 'tenant'));
  assert.deepEqual(f.calls.at(-1), { name: 'patch_private_invoicing_address', args: {
    p_tenant_id: 'tenant', p_owner_type: 'organization', p_owner_id: 'org', p_address: address,
  } });
});

test('empty patches do nothing; denied/cross-tenant writes and storage failures cannot report success', async () => {
  const f = fixture();
  await saveFormOrganizationInvoicingAddress({ ...f, address: {} });
  assert.deepEqual(f.calls, []);
  for (const options of [{ denied: true }, { owner: false }, { rpcError: new Error('Missing RPC') }, { rpcData: null }]) {
    const db = fixture(options);
    await assert.rejects(saveFormOrganizationInvoicingAddress({
      ...db, tenantId: 'tenant', organizationId: 'org', address: { invoicing_city: 'London' },
    }));
    if (options.denied || options.owner === false) assert.ok(!db.calls.some(c => c?.name === 'patch_private_invoicing_address'));
  }
});

test('structured action contracts accept the private destinations but never as matching keys', () => {
  const fields = [{ id: 'name', type: 'text' }, ...INVOICING_ADDRESS_KEYS.map(key => ({ id: key, type: 'text' }))];
  const action = { id: 'create-org', target: { kind: 'organization' }, operation: 'create',
    source: { scope: 'top_level' },
    mappings: fields.map(f => ({ id: `map-${f.id}`, source_field_id: f.id, target_type: 'core', target_field_id: f.id })) };
  assert.doesNotThrow(() => validateStructuredActionsContract({ version: 1, actions: [action] }, fields));
  assert.throws(() => validateStructuredActionsContract({ version: 1, actions: [{
    ...action, mappings: action.mappings.map(m => ({ ...m, is_match: m.target_field_id === 'invoicing_city' })),
  }] }, fields), error => /private invoicing fields/.test(error.details.join(' ')));
});

test('additional organisation actions create/update privately and recover storage failures without duplicate organisations', async () => {
  for (const operation of ['create', 'upsert']) {
    const owner = { id: 'existing-org', tenant_id: 'tenant', name: 'Invoice Org' };
    const orgs = operation === 'create' ? [] : [owner];
    const writes = [], rpcs = [];
    let failSave = true;
    const action = {
      id: 'org-action', target: { kind: 'organization' }, operation,
      source: { scope: 'top_level' },
      ...(operation === 'upsert' ? { uniqueness_field: 'name' } : {}),
      mappings: [
        { id: 'name-map', source_field_id: 'title', target_type: 'core', target_field_id: 'name' },
        { id: 'city-map', source_field_id: 'city', target_type: 'core', target_field_id: 'invoicing_city' },
      ],
    };
    const form = { id: 'form', tenant_id: 'tenant',
      fields: [{ id: 'title', type: 'text' }, { id: 'city', type: 'text' }],
      structured_actions: { version: 1, actions: [action] } };
    const submission = { id: 'submission', form_id: 'form', tenant_id: 'tenant',
      submission_data: { title: 'Invoice Org', city: ' Oxford ' }, processing_notes: [] };
    class Query {
      constructor(table) { this.table = table; this.filters = []; }
      select() { return this; }
      eq(k, v) { this.filters.push(row => row[k] === v); return this; }
      ilike(k, v) { this.filters.push(row => row[k]?.toLowerCase() === v.toLowerCase()); return this; }
      limit() { return this; }
      insert(payload) { this.inserted = payload; writes.push({ table: this.table, payload }); return this; }
      update(payload) { this.updated = payload; writes.push({ table: this.table, payload }); return this; }
      result() {
        if (this.table === 'form') return [form];
        if (this.table === 'form_submission') return [submission];
        if (this.table !== 'organization') return [];
        if (this.inserted) {
          const row = { id: this.inserted.id || 'new-org', ...this.inserted };
          orgs.push(row); this.inserted = null; return [row];
        }
        const rows = orgs.filter(row => this.filters.every(f => f(row)));
        if (this.updated) rows.forEach(row => Object.assign(row, this.updated));
        return rows;
      }
      async maybeSingle() { return { data: this.result()[0] || null, error: null }; }
      single() { return this.maybeSingle(); }
      then(resolve, reject) { return Promise.resolve({ data: this.result(), error: null }).then(resolve, reject); }
    }
    const db = {
      from: table => new Query(table),
      async rpc(name, args) {
        rpcs.push({ name, args });
        if (name === 'claim_form_structured_action') return { data: [{ claimed: true, record_id: 'new-org', claim_token: 'claim' }] };
        if (name === 'patch_private_invoicing_address') {
          if (failSave) { failSave = false; return { error: new Error('Address storage failure') }; }
          return { data: [args.p_address] };
        }
        return { data: null, error: null };
      },
    };
    const args = { db, tenantId: 'tenant', formId: 'form', submissionId: 'submission', authorization: { isAdmin: true } };
    const first = await processPersistedStructuredActions(args);
    assert.equal(first.success, false, operation);
    const second = await processPersistedStructuredActions(args);
    assert.equal(second.success, true, JSON.stringify(second));
    assert.equal(orgs.length, 1, 'retry must reuse the exact created organisation');
    assert.ok(writes.filter(w => w.table === 'organization').every(w => !Object.hasOwn(w.payload, 'invoicing_city')));
    const saves = rpcs.filter(r => r.name === 'patch_private_invoicing_address');
    assert.equal(saves.length, 2);
    assert.equal(saves[1].args.p_owner_id, orgs[0].id);
    assert.deepEqual(saves[1].args.p_address, { invoicing_city: 'Oxford' });
  }
});
