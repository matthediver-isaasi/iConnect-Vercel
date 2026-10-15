import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../forms/membership-payment.js', import.meta.url), 'utf8');
const start = source.indexOf("  if (['start_direct_debit', 'start_monthly_card'].includes(action))");
const end = source.indexOf("\n  if (action === 'create_payment')", start);
const block = source.slice(start, end);

function setup({ action = 'start_direct_debit', isMemberScoped = true, importError, handlerError, statusCode = 200 } = {}) {
  const calls = [];
  const sandbox = vm.createContext({
    action, isMemberScoped, tenantId: 'tenant', member: { id: 'member' },
    organizationId: isMemberScoped ? null : 'org',
    req: { body: { action } }, res: { statusCode }, supabase: {},
    __import: async path => {
      calls.push(['import', path]);
      if (importError) throw importError;
      return { default: async req => {
        calls.push(['handler', req.body.action, req.membershipPaymentContext.electionId]);
        if (handlerError) throw handlerError;
        return 'response';
      } };
    },
    renewalContext: async () => {
      calls.push(['context']);
      return { renewal: { state: 'renewable' }, simulation: {} };
    },
    resolveDirectDebitOption: async () => ({}),
    resolveCardMonthlyOption: async () => ({}),
    checkApproval: async () => ({ blocked: false }),
    reserveFormSuccessor: async () => {
      calls.push(['reserve']);
      return { id: 'election', quote: { payerMemberId: 'member', simulation: {} } };
    },
    beginRenewalProviderWork: async () => { calls.push(['begin']); return 'token'; },
    finishRenewalProviderWork: async (_db, _reservation, token) => { calls.push(['finish', token]); },
  });
  vm.runInContext(`async function run() { ${block.replaceAll('import(', '__import(')} }`, sandbox);
  return { calls, run: () => sandbox.run() };
}

test('serverless dependency paths are literal imports, not runtime variables', () => {
  for (const name of ['monthly-card', 'direct-debit', 'org-direct-debit']) {
    assert.ok(block.includes(`import('../membership/${name}.js')`));
  }
  assert.doesNotMatch(block, /import\(\s*endpoint\s*\)/);
});

for (const [action, isMemberScoped, endpoint] of [
  ['start_direct_debit', true, 'direct-debit'],
  ['start_direct_debit', false, 'org-direct-debit'],
  ['start_monthly_card', true, 'monthly-card'],
]) {
  test(`${endpoint}: load before reservation and provider fence, preserve dispatch context`, async () => {
    const { calls, run } = setup({ action, isMemberScoped });
    assert.equal(await run(), 'response');
    assert.deepEqual(calls, [
      ['import', `../membership/${endpoint}.js`], ['context'], ['reserve'],
      ['begin'], ['handler', 'start', 'election'], ['finish', 'token'],
    ]);
  });
}

test('missing deployment module cannot strand a reservation or provider fence', async () => {
  const error = Object.assign(new Error('Missing handler'), { code: 'ERR_MODULE_NOT_FOUND' });
  const { calls, run } = setup({ importError: error });
  await assert.rejects(run, error);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'import');
});

test('uncertain provider failure retains its fence', async () => {
  const error = new Error('Unknown provider outcome');
  const { calls, run } = setup({ handlerError: error });
  await assert.rejects(run, error);
  assert.ok(calls.some(([name]) => name === 'begin'));
  assert.ok(!calls.some(([name]) => name === 'finish'));
});

test('unsuccessful provider response retains its fence', async () => {
  const { calls, run } = setup({ statusCode: 500 });
  await run();
  assert.ok(!calls.some(([name]) => name === 'finish'));
});
