import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SALES_SETTINGS,
  SALES_CAPABILITIES,
  canTransitionQuote,
  isMinorUnitAmount,
  nextQuoteVersion,
  validateMoney,
  validateSalesSettingsPatch,
} from '../../shared/salesContracts.js';
import { requireSalesContext, salesActor } from './salesAccess.js';
import { allocateSalesNumber } from './salesFoundation.js';
import { createSalesSettingsHandler } from '../sales/settings.js';
import { createSalesNumberHandler } from '../sales/numbers.js';

function response() {
  return {
    statusCode: 200, body: null, headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('Sales settings contract rejects unknown, malformed, and stale-shape values', () => {
  assert.equal(validateSalesSettingsPatch({
    expectedVersion: 1, defaultCurrency: 'GBP', defaultTaxRateBps: 2000,
  }).ok, true);
  for (const patch of [
    { expectedVersion: 1, defaultCurrency: 'gbp' },
    { expectedVersion: 1, quoteNumberPadding: 0 },
    { expectedVersion: 1, defaultTaxRateBps: 1.2 },
    { expectedVersion: 1, tenantId: 'attacker' },
    { moduleEnabled: true },
  ]) assert.equal(validateSalesSettingsPatch(patch).ok, false);
  assert.equal(isMinorUnitAmount(1250), true);
  assert.equal(isMinorUnitAmount(12.5), false);
  assert.equal(validateMoney({ amountMinor: 1250, currency: 'GBP' }, 'GBP'), true);
  assert.equal(validateMoney({ amountMinor: 1250, currency: 'USD' }, 'GBP'), false);
  assert.equal(canTransitionQuote('draft', 'issued'), true);
  assert.equal(canTransitionQuote('accepted', 'draft'), false);
  assert.equal(nextQuoteVersion(2, 'issued'), 3);
  assert.throws(() => nextQuoteVersion(2, 'draft'));
});

test('Sales access requires baseline and the independent action capability', async () => {
  const context = {
    isAuthenticated: true, tenantId: 't1', memberId: 'm1', roleId: 'r1',
    memberExcludedFeatures: [],
  };
  const onlyBaseline = async (_role, key) => key === SALES_CAPABILITIES.VIEW;
  await assert.rejects(
    requireSalesContext(context, SALES_CAPABILITIES.MANAGE_QUOTES, { hasFeatureAccess: onlyBaseline }),
    (error) => error.status === 403,
  );
  const both = async (_role, key) => [
    SALES_CAPABILITIES.VIEW, SALES_CAPABILITIES.MANAGE_QUOTES,
  ].includes(key);
  assert.equal((await requireSalesContext(
    context, SALES_CAPABILITIES.MANAGE_QUOTES, { hasFeatureAccess: both },
  )).tenantId, 't1');
});

test('tenant mismatch is denied and actor identity is server-derived', async () => {
  await assert.rejects(
    requireSalesContext({ tenantMismatch: true }, SALES_CAPABILITIES.VIEW),
    (error) => error.status === 409,
  );
  assert.deepEqual(salesActor({ tenantUserId: 'tu1', memberId: 'ignored' }), {
    actorId: 'tu1', actorType: 'tenant_user',
  });
});

test('Sales APIs reject a mismatched tenant before touching persistence', async () => {
  const db = {
    from: () => assert.fail('cross-tenant request must not query a table'),
    rpc: () => assert.fail('cross-tenant request must not invoke an RPC'),
  };
  const getTenantContext = async () => ({
    tenantMismatch: true,
    isAuthenticated: true,
    tenantId: 'session-tenant',
    tenantUserId: 'actor-a',
  });
  const getRes = response();
  await createSalesSettingsHandler({ db, getTenantContext })({ method: 'GET' }, getRes);
  assert.equal(getRes.statusCode, 409);

  const numberRes = response();
  await createSalesNumberHandler({ db, getTenantContext })({
    method: 'POST',
    body: { kind: 'quote', tenantId: 'other-tenant' },
  }, numberRes);
  assert.equal(numberRes.statusCode, 409);
});

test('settings GET is tenant scoped and PATCH sends server actor to versioned RPC', async () => {
  const calls = [];
  const db = {
    from(table) {
      assert.equal(table, 'sales_settings');
      return {
        select() { return this; },
        eq(column, value) { calls.push(['scope', column, value]); return this; },
        async maybeSingle() { return { data: null, error: null }; },
      };
    },
    async rpc(name, args) {
      calls.push(['rpc', name, args]);
      return { data: [{
        quote_prefix: 'S', quote_number_padding: 5, default_currency: 'USD',
        default_tax_rate_bps: 500, default_terms: '', module_enabled: true,
        version: 2, updated_at: 'now',
      }], error: null };
    },
  };
  const dependencies = {
    db,
    getTenantContext: async () => ({
      isAuthenticated: true, tenantId: 'tenant-a', tenantUserId: 'actor-a',
    }),
  };
  const getRes = response();
  await createSalesSettingsHandler(dependencies)({ method: 'GET' }, getRes);
  assert.equal(getRes.statusCode, 200);
  assert.deepEqual(getRes.body, { ...DEFAULT_SALES_SETTINGS, updatedAt: null });
  assert.deepEqual(calls[0], ['scope', 'tenant_id', 'tenant-a']);

  const patchRes = response();
  await createSalesSettingsHandler(dependencies)({
    method: 'PATCH',
    body: { expectedVersion: 1, quotePrefix: 'S', defaultCurrency: 'USD' },
  }, patchRes);
  assert.equal(patchRes.statusCode, 200);
  const rpcArgs = calls.find((call) => call[0] === 'rpc')[2];
  assert.equal(rpcArgs.p_tenant_id, 'tenant-a');
  assert.equal(rpcArgs.p_actor_id, 'actor-a');
  assert.equal(rpcArgs.p_actor_type, 'tenant_user');
  assert.equal(rpcArgs.p_patch.tenantId, undefined);
});

test('parallel allocations return unique monotonic values through atomic RPC', async () => {
  let sequence = 0;
  const seenActors = [];
  const db = {
    async rpc(name, args) {
      assert.equal(name, 'allocate_sales_identifier');
      seenActors.push(args.p_actor_id);
      // Models the atomic database RPC return contract, independent of call order.
      const value = ++sequence;
      await Promise.resolve();
      return { data: [{ identifier: `Q${String(value).padStart(6, '0')}`, sequence_value: value }], error: null };
    },
  };
  const actor = { actorId: 'm1', actorType: 'member' };
  const allocated = await Promise.all(
    Array.from({ length: 25 }, () => allocateSalesNumber(db, 't1', actor)),
  );
  assert.equal(new Set(allocated.map((row) => row.identifier)).size, 25);
  assert.deepEqual(allocated.map((row) => row.sequenceValue).sort((a, b) => a - b),
    Array.from({ length: 25 }, (_, index) => index + 1));
  assert.equal(seenActors.every((id) => id === 'm1'), true);
});

test('number API rejects an unsupported kind before exposing a number', async () => {
  const handler = createSalesNumberHandler({
    db: { rpc: async () => assert.fail('RPC must not be called') },
    getTenantContext: async () => ({
      isAuthenticated: true, tenantId: 't1', tenantUserId: 'tu1',
    }),
  });
  const res = response();
  await handler({ method: 'POST', body: { kind: 'invoice' } }, res);
  assert.equal(res.statusCode, 400);
});