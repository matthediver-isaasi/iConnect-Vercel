import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_TENANT_FIELDS,
  TENANT_FIELDS,
  isMissingCanvasFooterColumn,
  selectTenantWithFooterFallback,
} from './tenantResolver.js';
import {
  isMissingMicrositeCanvasFooterColumn,
  selectMicrositeWithFooterFallback,
} from './microsites.js';

function fakeDatabase() {
  return {
    from(table) {
      return {
        select(fields) {
          return { table, fields };
        },
      };
    },
  };
}

test('tenant lookup retries without Canvas footer columns on legacy schema', async () => {
  const calls = [];
  const result = await selectTenantWithFooterFallback(fakeDatabase(), async (query) => {
    calls.push(query);
    return calls.length === 1
      ? { data: null, error: { code: '42703', message: 'column tenant.footer_source does not exist' } }
      : { data: { id: 'tenant-1', footer_config: { columns: 4 } }, error: null };
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].fields, TENANT_FIELDS);
  assert.equal(calls[1].fields, LEGACY_TENANT_FIELDS);
  assert.deepEqual(result.data, { id: 'tenant-1', footer_config: { columns: 4 } });
});

test('tenant lookup does not hide unrelated database errors', async () => {
  const calls = [];
  const expected = { code: '42501', message: 'permission denied' };
  const result = await selectTenantWithFooterFallback(fakeDatabase(), async (query) => {
    calls.push(query);
    return { data: null, error: expected };
  });

  assert.equal(calls.length, 1);
  assert.equal(result.error, expected);
  assert.equal(isMissingCanvasFooterColumn(expected), false);
});

test('microsite lookup retries only for missing Canvas footer columns', async () => {
  const calls = [];
  const result = await selectMicrositeWithFooterFallback(fakeDatabase(), async (query) => {
    calls.push(query);
    return calls.length === 1
      ? { data: null, error: { code: '42703', message: 'column microsite.canvas_footer_id does not exist' } }
      : { data: { id: 'microsite-1', footer_config: {} }, error: null };
  });

  assert.equal(calls.length, 2);
  assert.ok(calls[0].fields.includes('footer_source'));
  assert.ok(!calls[1].fields.includes('footer_source'));
  assert.deepEqual(result.data, { id: 'microsite-1', footer_config: {} });
  assert.equal(isMissingMicrositeCanvasFooterColumn({ code: '42P01', message: 'missing table' }), false);
});