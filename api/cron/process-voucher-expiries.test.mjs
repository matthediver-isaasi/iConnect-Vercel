import test from 'node:test';
import assert from 'node:assert/strict';
import { expireVoucher } from './process-voucher-expiries.js';

test('expiry delegates owner-preserving atomic operation with stable key and no direct writes', async () => {
  const calls = [];
  const db = { rpc: async (name, args) => { calls.push({ name, args }); return { data: { id: 'v', value: 0 } }; } };
  const voucher = { id: 'v', tenant_id: 't', expires_at: '2026-01-01' };
  await expireVoucher(db, voucher);
  await expireVoucher(db, voucher);
  assert.equal(calls[0].name, 'voucher_admin_write');
  assert.equal(calls[0].args.p_operation, 'expire');
  assert.equal(calls[0].args.p_tenant_id, 't');
  assert.deepEqual(calls[0].args.p_values, {});
  assert.equal(calls[0].args.p_idempotency_key, calls[1].args.p_idempotency_key);
});
