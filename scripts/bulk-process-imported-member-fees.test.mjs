import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BATCH_OUTCOMES,
  classifyCountRows,
  classifyMemberFee,
  executeMemberFeeBatch,
  pageByCursor,
  processMemberFee,
  processMemberFeeRows,
  tokenDecision,
} from '../api/_lib/memberFeeBatch.js';
import { parseCohortText } from './bulk-process-imported-member-fees.mjs';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const MEMBER = '33333333-3333-4333-8333-333333333333';

function baseSimulation(overrides = {}) {
  return {
    success: true,
    member: { id: MEMBER, name: 'Imported Member', email: 'member@example.test' },
    membershipYear: { label: '2026/2027' },
    finalCost: 120,
    currency: 'GBP',
    tierLabel: 'Standard',
    config: { id: 'config-1', online_card_payment: true },
    ...overrides,
  };
}

function dependencies({
  simulation = baseSimulation(),
  approval = { required: true, approved: false },
  history = [],
  tokens = [],
  sendResult = { success: true, sentTo: ['member@example.test'] },
  onApproval = () => {},
  onSend = () => {},
} = {}) {
  return {
    tenantId: TENANT,
    simulate: async () => simulation,
    resolveApproval: async () => approval,
    loadHistory: async () => history,
    loadTokens: async () => tokens,
    setApproval: async (input) => onApproval(input),
    sendEmail: async (input) => { onSend(input); return sendResult; },
    recordNote: async () => {},
  };
}

test('cohort parser accepts source-like CSVs and JSON identity manifests', () => {
  const csv = parseCohortText('YM Web Site Member ID,Email\nlegacy-1,member@example.test\n', 'cohort.csv');
  assert.deepEqual(csv, [{ memberId: null, email: 'member@example.test', legacyId: 'legacy-1' }]);
  const json = parseCohortText(JSON.stringify({ memberIds: [MEMBER] }), 'cohort.json');
  assert.deepEqual(json, [{ memberId: MEMBER, email: null, legacyId: null }]);
});

test('cursor paging is bounded and resumable', () => {
  const rows = ['b', 'a', 'c'].map((cursor) => ({ cursor }));
  assert.deepEqual(pageByCursor(rows, { limit: 2 }), {
    rows: [{ cursor: 'a' }, { cursor: 'b' }],
    total: 3,
    hasMore: true,
    nextCursor: 'b',
  });
  assert.deepEqual(pageByCursor(rows, { after: 'b', limit: 2 }).rows, [{ cursor: 'c' }]);
  const mixed = [{ cursor: '0001:A' }, { cursor: '0002:a' }, { cursor: '0003:A' }];
  assert.deepEqual(pageByCursor(mixed, { after: '0001:A', limit: 5 }).rows, mixed.slice(1));
});

test('classification reports unmapped tiers, invalid configs, missing email, and existing years', async () => {
  const unmapped = await classifyMemberFee(
    { id: MEMBER, tenant_id: TENANT, email: 'member@example.test' },
    dependencies({ simulation: { success: false, error: 'Member does not match any tier band' } }),
  );
  assert.equal(unmapped.outcome, BATCH_OUTCOMES.UNMAPPED_TIER);

  const invalid = await classifyMemberFee(
    { id: MEMBER, tenant_id: TENANT, email: 'member@example.test' },
    dependencies({ simulation: { success: false, error: 'Invalid membership year configuration' } }),
  );
  assert.equal(invalid.outcome, BATCH_OUTCOMES.INVALID_DATE_CONFIG);

  const missingEmail = await classifyMemberFee(
    { id: MEMBER, tenant_id: TENANT, email: '' },
    dependencies(),
  );
  assert.equal(missingEmail.outcome, BATCH_OUTCOMES.MISSING_EMAIL);

  const recorded = await classifyMemberFee(
    { id: MEMBER, tenant_id: TENANT, email: 'member@example.test' },
    dependencies({ history: [{ id: 'history-1' }] }),
  );
  assert.equal(recorded.outcome, BATCH_OUTCOMES.ALREADY_RECORDED);
});

test('classification distinguishes pending reuse, PO-submitted, terminal, and duplicate tokens', () => {
  const future = new Date('2030-01-01');
  assert.equal(tokenDecision([{ status: 'pending', expires_at: '2030-02-01' }], future).tokenStatus, 'pending_reuse');
  assert.equal(tokenDecision([{ status: 'po_submitted' }], future).outcome, BATCH_OUTCOMES.PO_SUBMITTED);
  assert.equal(tokenDecision([{ status: 'paid' }], future).outcome, BATCH_OUTCOMES.TERMINAL_TOKEN);
  assert.equal(tokenDecision([
    { status: 'pending', expires_at: '2030-02-01' },
    { status: 'pending', expires_at: '2030-03-01' },
  ], future).outcome, BATCH_OUTCOMES.DUPLICATE_ACTIVE_TOKEN);
});

test('apply approves and emails an eligible member without exposing token values', async () => {
  const calls = [];
  const row = await classifyMemberFee(
    { id: MEMBER, tenant_id: TENANT, email: 'member@example.test', first_name: 'Imported', last_name: 'Member' },
    dependencies({ onApproval: (input) => calls.push(['approval', input]), onSend: (input) => calls.push(['email', input]) }),
  );
  const applied = await processMemberFee(row, {
    ...dependencies({ onApproval: (input) => calls.push(['approval', input]), onSend: (input) => calls.push(['email', input]) }),
    client: {},
  });
  assert.equal(applied.action, 'applied');
  assert.deepEqual(calls.map(([kind]) => kind), ['approval', 'email']);
  assert.equal(calls[1][1].memberId, MEMBER);
  assert.equal('token' in calls[1][1], false);
});

test('replay skips history, preserves PO-submitted tokens, and isolates email failure', async () => {
  const history = await processMemberFee(
    { cursor: 'history', memberId: MEMBER, membershipYear: '2026/2027', outcome: BATCH_OUTCOMES.ELIGIBLE },
    {
      ...dependencies({ history: [{ id: 'history-1' }] }),
      client: {},
    },
  );
  assert.equal(history.outcome, BATCH_OUTCOMES.ALREADY_RECORDED);

  const po = await classifyMemberFee(
    { id: MEMBER, tenant_id: TENANT, email: 'member@example.test' },
    dependencies({ tokens: [{ status: 'po_submitted' }] }),
  );
  assert.equal(po.outcome, BATCH_OUTCOMES.PO_SUBMITTED);

  const failed = await processMemberFee(
    { cursor: 'failed', memberId: MEMBER, email: 'member@example.test', membershipYear: '2026/2027', outcome: BATCH_OUTCOMES.ELIGIBLE, approvalRequired: true, simulation: baseSimulation() },
    {
      ...dependencies({ sendResult: { success: false, error: 'mail unavailable' } }),
      client: {},
    },
  ).catch((error) => error);
  assert.match(failed.message, /mail unavailable/);
});

test('one apply failure does not stop the rest of the cohort', async () => {
  const rows = [
    { cursor: 'a', memberId: 'a', email: 'a@example.test', membershipYear: '2026/2027', outcome: BATCH_OUTCOMES.ELIGIBLE, approvalRequired: true, simulation: baseSimulation({ member: { name: 'A', email: 'a@example.test' } }) },
    { cursor: 'b', memberId: 'b', email: 'b@example.test', membershipYear: '2026/2027', outcome: BATCH_OUTCOMES.ELIGIBLE, approvalRequired: true, simulation: baseSimulation({ member: { name: 'B', email: 'b@example.test' } }) },
  ];
  const results = await processMemberFeeRows(rows, {
    ...dependencies(),
    client: {},
    sendEmail: async (payload) => payload.memberId === 'a'
      ? { success: false, error: 'first failed' }
      : { success: true, sentTo: [payload.recipientEmails[0]] },
  });
  assert.equal(results[0].outcome, BATCH_OUTCOMES.ERROR);
  assert.equal(results[1].action, 'applied');
});

test('dry run orchestration never calls approval or email services', async () => {
  let sideEffects = 0;
  const results = await executeMemberFeeBatch([
    { outcome: BATCH_OUTCOMES.ELIGIBLE },
  ], {
    apply: false,
    setApproval: async () => { sideEffects += 1; },
    sendEmail: async () => { sideEffects += 1; },
  });
  assert.deepEqual(results, []);
  assert.equal(sideEffects, 0);
});

test('counts are machine-readable and include the processable total', () => {
  const counts = classifyCountRows([
    { outcome: BATCH_OUTCOMES.ELIGIBLE },
    { outcome: BATCH_OUTCOMES.ALREADY_APPROVED },
    { outcome: BATCH_OUTCOMES.MISSING_EMAIL },
  ]);
  assert.equal(counts.eligible, 1);
  assert.equal(counts.already_approved, 1);
  assert.equal(counts.missing_email, 1);
  assert.equal(counts.processable, 2);
});

test('a member from another tenant is never processable', async () => {
  const row = await classifyMemberFee(
    { id: MEMBER, tenant_id: OTHER_TENANT, email: 'member@example.test' },
    dependencies(),
  );
  assert.equal(row.outcome, BATCH_OUTCOMES.TENANT_MISMATCH);
});