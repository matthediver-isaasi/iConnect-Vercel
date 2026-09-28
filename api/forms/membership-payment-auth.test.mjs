import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// Exercise the actual request boundary with no database/provider imports.
const source = readFileSync(new URL('./membership-payment.js', import.meta.url), 'utf8');
const handlerSource = source.slice(source.indexOf('export default async function handler'), source.indexOf('async function getMemberById'))
  .replace('export default ', '');

test('GET quotes and POST payments require resolved tenant and self/admin authority', async () => {
  for (const method of ['GET', 'POST']) {
    for (const fixture of [
      { tenant: null, access: { ok: true }, status: 403 },
      { tenant: 'tenant-a', access: { ok: false }, status: 403 },
      { tenant: 'tenant-a', access: { ok: true, tenantId: 'tenant-b' }, status: 403 },
      { tenant: 'tenant-a', access: { ok: true, via: 'self' }, status: 200 },
      { tenant: 'tenant-a', access: { ok: true, via: 'admin', tenantId: 'tenant-a' }, status: 200 },
    ]) {
      let calls = 0;
      const respond = async (_req, res) => { calls++; return res.json({ ok: true }); };
      const context = vm.createContext({
        supabase: {}, console,
        resolveTenantFromRequest: async () => fixture.tenant ? { id: fixture.tenant } : null,
        authorizeMemberAccess: async (_req, id) => {
          assert.equal(id, 'explicit-member');
          return fixture.access;
        },
        handleGet: respond, handlePost: respond,
      });
      vm.runInContext(handlerSource, context);
      const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
      await context.handler({ method, query: { memberId: 'explicit-member' }, body: { memberId: 'explicit-member' } }, res);
      assert.equal(res.statusCode, fixture.status);
      assert.equal(calls, fixture.status === 200 ? 1 : 0);
    }
  }
});