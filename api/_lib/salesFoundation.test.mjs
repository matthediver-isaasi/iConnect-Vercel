import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SALES_SETTINGS,
  SALES_CAPABILITIES,
  canTransitionQuote,
  isMinorUnitAmount,
  mapSalesSettingsRow,
  nextQuoteVersion,
  validateMoney,
  validateSalesSettingsPatch,
} from '../../shared/salesContracts.js';
import { RESERVED_SALES_SEGMENTS } from '../../shared/salesNaming.js';
process.env.ROLE_ACCESS_OVERLAY_SKIP_PRIME = '1';
const { __setRoleAccessOverlayForTests } = await import('./roleVisibility.js');
__setRoleAccessOverlayForTests([]);
const { requireSalesContext, salesActor } = await import('./salesAccess.js');
const { allocateSalesNumber } = await import('./salesFoundation.js');
const { createSalesSettingsHandler } = await import('../sales/settings.js');
const { createSalesNumberHandler } = await import('../sales/numbers.js');

function response() {
  return {
    statusCode: 200, body: null, headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('Sales settings contract rejects unknown, malformed, and stale-shape values', () => {
  assert.equal(DEFAULT_SALES_SETTINGS.showInternalCode, true);
  assert.equal(DEFAULT_SALES_SETTINGS.showSku, true);
  for (const key of ['showInternalCode', 'showSku']) {
    for (const value of [true, false]) {
      assert.equal(validateSalesSettingsPatch({ expectedVersion: 1, [key]: value }).ok, true);
    }
    for (const value of [null, undefined, 'true', 'false', 0, 1, [], {}]) {
      assert.equal(validateSalesSettingsPatch({ expectedVersion: 1, [key]: value }).ok, false,
        `${key} must reject ${JSON.stringify(value)}`);
    }
  }
  assert.equal(validateSalesSettingsPatch({ expectedVersion: 1, quoteTaskListName: " Delivery " }).ok, true);
  for (const quoteTaskListName of ["", "  ", "a".repeat(101), null, 17]) {
    assert.equal(validateSalesSettingsPatch({ expectedVersion: 1, quoteTaskListName }).ok, false);
  }
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

test('naming contract accepts trimmed Unicode codepoints and rejects malformed or reserved slugs', () => {
  for (const patch of [
    { quoteSingularName: ' \u00a0提案\u3000' }, { quotePluralName: '😀'.repeat(100) },
    { quoteUrlSegment: 'proposals-2026' }, { quoteUrlSegment: 'a'.repeat(100) },
  ]) assert.equal(validateSalesSettingsPatch({ expectedVersion: 1, ...patch }).ok, true);
  for (const key of ['quoteSingularName', 'quotePluralName']) {
    for (const value of [null, 4, false, '', '\u00a0\u3000', '😀'.repeat(101)]) {
      assert.equal(validateSalesSettingsPatch({ expectedVersion: 1, [key]: value }).ok, false, `${key}: ${value}`);
    }
  }
  for (const quoteUrlSegment of [
    null, false, 2, '', 'a'.repeat(101), 'Quotes', 'with space', 'two--hyphens',
    '-edge', 'edge-', ' proposals ', 'proposals/path', 'café', 'quotes?x=y',
    ...RESERVED_SALES_SEGMENTS,
  ]) assert.equal(validateSalesSettingsPatch({ expectedVersion: 1, quoteUrlSegment }).ok, false, String(quoteUrlSegment));
  assert.deepEqual(
    Object.fromEntries(Object.entries(mapSalesSettingsRow({})).filter(([key]) => key.startsWith('quote') && key !== 'quotePrefix' && key !== 'quoteNumberPadding')),
    { quoteSingularName: 'Quote', quotePluralName: 'Quotes', quoteUrlSegment: 'quotes', quoteTaskListName: 'Quote tasks' },
  );
});

test('naming API persists only supplied names, preserves task-list independence, and surfaces stale versions', async () => {
  const calls = [];
  let conflict = false;
  const handler = createSalesSettingsHandler({
    db: { async rpc(name, args) {
      calls.push({ name, args });
      return conflict ? { error: { code: '40001' } } : { data: [{
        quote_singular_name: args.p_patch.quoteSingularName ?? 'Quote',
        quote_plural_name: args.p_patch.quotePluralName ?? 'Quotes',
        quote_url_segment: args.p_patch.quoteUrlSegment ?? 'quotes',
        quote_task_list_name: 'Delivery checklist', version: 2,
      }] };
    } },
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-a', tenantUserId: 'actor-a' }),
  });
  const res = response();
  await handler({ method: 'PATCH', body: {
    expectedVersion: 1, quoteSingularName: '\u3000提案\u00a0', quotePluralName: ' Proposals ', quoteUrlSegment: 'proposals',
  } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.quoteTaskListName, 'Delivery checklist');
  assert.equal(res.body.quoteSingularName, '提案');
  assert.deepEqual(calls[0], {
    name: 'patch_sales_settings',
    args: { p_tenant_id: 'tenant-a', p_expected_version: 1, p_actor_id: 'actor-a', p_actor_type: 'tenant_user',
      p_patch: { quoteSingularName: '提案', quotePluralName: 'Proposals', quoteUrlSegment: 'proposals' } },
  });
  conflict = true;
  const stale = response();
  await handler({ method: 'PATCH', body: { expectedVersion: 1, quotePluralName: 'Offers' } }, stale);
  assert.equal(stale.statusCode, 409);
  const invalid = response();
  await handler({ method: 'PATCH', body: { expectedVersion: 2, quoteUrlSegment: 'allocations' } }, invalid);
  assert.equal(invalid.statusCode, 400);
  assert.equal(calls.length, 2);
});

test('merged visibility and naming settings share one tenant-scoped read and versioned patch', async () => {
  const calls = [];
  const row = {
    quote_singular_name: 'Proposal', quote_plural_name: 'Proposals', quote_url_segment: 'proposals',
    show_internal_code: false, show_sku: false, quote_task_list_name: 'Delivery tasks', version: 4,
  };
  const handler = createSalesSettingsHandler({
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-a', tenantUserId: 'actor-a' }),
    db: {
      from(table) {
        assert.equal(table, 'sales_settings');
        return {
          select(columns) {
            for (const column of ['show_internal_code', 'show_sku', 'quote_singular_name', 'quote_plural_name', 'quote_url_segment']) {
              assert.ok(columns.split(',').includes(column), column);
            }
            return this;
          },
          eq(column, value) { assert.deepEqual([column, value], ['tenant_id', 'tenant-a']); return this; },
          async maybeSingle() { return { data: row, error: null }; },
        };
      },
      async rpc(name, args) {
        calls.push({ name, args });
        return { data: [row], error: null };
      },
    },
  });
  const read = response();
  await handler({ method: 'GET' }, read);
  assert.equal(read.body.showInternalCode, false);
  assert.equal(read.body.showSku, false);
  assert.equal(read.body.quoteUrlSegment, 'proposals');
  const patch = response();
  await handler({ method: 'PATCH', body: {
    expectedVersion: 3, showInternalCode: false, showSku: false,
    quoteSingularName: ' Proposal ', quotePluralName: ' Proposals ', quoteUrlSegment: 'proposals',
  } }, patch);
  assert.equal(patch.statusCode, 200);
  assert.deepEqual(calls[0].args.p_patch, {
    showInternalCode: false, showSku: false, quoteSingularName: 'Proposal', quotePluralName: 'Proposals', quoteUrlSegment: 'proposals',
  });
  assert.equal(calls[0].args.p_expected_version, 3);
  assert.equal(patch.body.quoteTaskListName, 'Delivery tasks');
});

test('naming PATCH enforces settings capability and refuses browser tenant/actor injection', async () => {
  const context = { isAuthenticated: true, tenantId: 'tenant-a', memberId: 'member-a', roleId: 'r1', memberExcludedFeatures: [] };
  const db = { rpc() { assert.fail('Denied request must never persist'); } };
  const denied = response();
  await createSalesSettingsHandler({
    db, getTenantContext: async () => context,
    hasFeatureAccess: async (_role, key) => key === SALES_CAPABILITIES.VIEW,
  })({ method: 'PATCH', body: { expectedVersion: 1, quoteSingularName: 'Offer' } }, denied);
  assert.equal(denied.statusCode, 403);
  const injected = response();
  await createSalesSettingsHandler({
    db, getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-a', tenantUserId: 'actor-a' }),
  })({ method: 'PATCH', body: { expectedVersion: 1, quoteSingularName: 'Offer', tenantId: 'tenant-b', actorId: 'attacker' } }, injected);
  assert.equal(injected.statusCode, 400);
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

test('visibility PATCH maps both false values without adding unrelated settings', async () => {
  let args;
  const handler = createSalesSettingsHandler({
    db: { async rpc(name, value) {
      assert.equal(name, 'patch_sales_settings'); args = value;
      return { data: [{ show_internal_code: false, show_sku: false, version: 7,
        quote_task_list_name: 'Delivery' }], error: null };
    } },
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 't1', memberId: 'm1', roleId: 'r1' }),
    hasFeatureAccess: async () => true,
  });
  const res = response();
  await handler({ method: 'PATCH', body: { expectedVersion: 6, showInternalCode: false, showSku: false } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.showInternalCode, false);
  assert.equal(res.body.showSku, false);
  assert.equal(res.body.quoteTaskListName, 'Delivery');
  assert.equal(res.body.version, 7);
  assert.deepEqual(args, { p_tenant_id: 't1', p_expected_version: 6,
    p_patch: { showInternalCode: false, showSku: false }, p_actor_id: 'm1', p_actor_type: 'member' });
});

test('settings permissions distinguish view from management and reject exclusions before persistence', async () => {
  const context = { isAuthenticated: true, tenantId: 't1', memberId: 'm1', roleId: 'r1' };
  for (const memberExcludedFeatures of [[], [SALES_CAPABILITIES.MANAGE_SETTINGS], ['sales']]) {
    const res = response();
    await createSalesSettingsHandler({
      db: { rpc: () => assert.fail('denied patch must not persist') },
      getTenantContext: async () => ({ ...context, memberExcludedFeatures }),
      hasFeatureAccess: async (_role, key) => memberExcludedFeatures.length > 0 || key === SALES_CAPABILITIES.VIEW,
    })({ method: 'PATCH', body: { expectedVersion: 1, showSku: false } }, res);
    assert.equal(res.statusCode, 403);
  }
  const res = response();
  await createSalesSettingsHandler({
    db: { from: () => ({ select() { return this; }, eq() { return this; },
      maybeSingle: async () => ({ data: { show_internal_code: false, show_sku: true, version: 2 }, error: null }) }) },
    getTenantContext: async () => context,
    hasFeatureAccess: async (_role, key) => key === SALES_CAPABILITIES.VIEW,
  })({ method: 'GET' }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.showInternalCode, false);
  assert.equal(res.body.showSku, true);
});

test('settings validation and RPC errors surface safely', async () => {
  const getTenantContext = async () => ({ isAuthenticated: true, tenantId: 't1', tenantUserId: 'a1' });
  for (const showSku of ['false', null, 0]) {
    const res = response();
    await createSalesSettingsHandler({ getTenantContext, db: { rpc: () => assert.fail('invalid patch reached RPC') } })(
      { method: 'PATCH', body: { expectedVersion: 1, showSku } }, res);
    assert.equal(res.statusCode, 400);
    assert.ok(res.body.details.length);
  }
  for (const [code, status] of [['40001', 409], ['22023', 500], ['XX000', 500]]) {
    const res = response();
    await createSalesSettingsHandler({ getTenantContext,
      db: { rpc: async () => ({ data: null, error: { code, message: 'private database detail' } }) },
    })({ method: 'PATCH', body: { expectedVersion: 1, showSku: false } }, res);
    assert.equal(res.statusCode, status);
    assert.doesNotMatch(res.body.error, /private database detail/);
  }
});