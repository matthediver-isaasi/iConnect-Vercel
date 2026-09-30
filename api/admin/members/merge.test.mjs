import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
import { REASSIGN_REFS, buildAuditNotePayload, performMerge } from './merge.js';

// Minimal supabase-compatible fake. `failOn` maps "table.op" -> error object.
// Records every terminal operation so tests can assert ordering/absence.
function makeFakeDb({ failOn = {}, prefRows = [] } = {}) {
  const ops = [];
  const ok = (data = null) => Promise.resolve({ data, error: null });
  const fail = (error) => Promise.resolve({ data: null, error });
  function table(name) {
    const finish = (op, data) => {
      ops.push(`${name}.${op}`);
      const err = failOn[`${name}.${op}`];
      return err ? fail(err) : ok(data);
    };
    const chain = (op, data) => {
      const p = { };
      const resolveData = () => finish(op, data);
      // thenable chain: every filter returns the same object; awaiting runs finish
      const self = new Proxy(p, {
        get(_, prop) {
          if (prop === 'then') {
            const promise = resolveData();
            return promise.then.bind(promise);
          }
          return () => self;
        },
      });
      return self;
    };
    return {
      select: (cols) => chain('select', name === 'member_preference_value' ? prefRows : []),
      update: () => chain('update'),
      insert: () => chain('insert'),
      upsert: () => chain('upsert'),
      delete: () => chain('delete'),
    };
  }
  return { from: table, ops };
}

// Test stand-in for the real anonymiser: records the call on the fake db's
// op log so ordering can be asserted, and never touches the session store.
function makeFakeAnonymize(db) {
  return async (memberId) => {
    db.ops.push(`ANONYMIZE:${memberId}`);
    return { success: true };
  };
}
const anonRan = (db) => db.ops.some(op => op.startsWith('ANONYMIZE:'));

const admin = { id: 'admin-1', first_name: 'Ada', last_name: 'Admin', email: 'ada@example.com' };
const baseSource = { id: '11111111-1111-4111-8111-111111111111', first_name: 'Old', last_name: 'Record', email: 'old@example.com', engagement_opening_balances: {} };
const baseTarget = { id: '22222222-2222-4222-8222-222222222222', first_name: 'New', last_name: 'Record', email: 'new@example.com', engagement_opening_balances: {} };

test('target core-field update failure aborts BEFORE any source disposal', async () => {
  const db = makeFakeDb({ failOn: { 'member.update': { code: 'XX000', message: 'boom' } } });
  const result = await performMerge({
    db, source: baseSource, target: baseTarget, adminMember: admin,
    coreFields: ['first_name'], sourceDisposal: 'reassign', callerTenantId: 't1', anonymize: makeFakeAnonymize(db),
  });
  assert.equal(result.status, 500);
  assert.match(result.body.error, /source record was not changed/i);
  // No history table was touched and the source member row was never updated.
  assert.ok(!db.ops.some(op => op.startsWith('booking.')), 'no reassignment ran');
  assert.ok(!anonRan(db), 'anonymisation never started');
});

test('custom-value copy failure aborts before disposal with accurate partial state', async () => {
  const fieldId = '33333333-3333-4333-8333-333333333333';
  const db = makeFakeDb({
    prefRows: [{ field_id: fieldId, value: '["A","B"]' }],
    failOn: { 'member_preference_value.upsert': { code: 'XX000', message: 'nope' } },
  });
  const result = await performMerge({
    db, source: baseSource, target: baseTarget, adminMember: admin,
    customFieldIds: [fieldId], sourceDisposal: 'anonymise', callerTenantId: 't1', anonymize: makeFakeAnonymize(db),
  });
  assert.equal(result.status, 500);
  assert.match(result.body.error, /source record was not changed/i);
  assert.deepEqual(result.body.partial.copiedCustomFields, []);
  assert.ok(!anonRan(db), 'anonymisation never started');
});

test('engagement balance failure aborts before disposal', async () => {
  const db = makeFakeDb({ failOn: { 'member.update': { code: 'XX000', message: 'ob fail' } } });
  const result = await performMerge({
    db, source: baseSource, target: baseTarget, adminMember: admin,
    includeEngagement: true, sourceDisposal: 'reassign', callerTenantId: 't1', anonymize: makeFakeAnonymize(db),
  });
  assert.equal(result.status, 500);
  assert.match(result.body.error, /engagement opening balances/i);
  assert.ok(!db.ops.some(op => op.startsWith('booking.update')), 'no reassignment ran');
  assert.ok(!anonRan(db), 'anonymisation never started');
});

test('engagement read failure fails closed: aborts before any mutation or disposal', async () => {
  const db = makeFakeDb({ failOn: { 'booking.select': { code: 'XX000', message: 'read blew up' } } });
  const result = await performMerge({
    db, source: baseSource, target: baseTarget, adminMember: admin,
    includeEngagement: true, coreFields: ['first_name'], sourceDisposal: 'reassign', callerTenantId: 't1', anonymize: makeFakeAnonymize(db),
  });
  assert.equal(result.status, 500);
  assert.match(result.body.error, /engagement data \(bookings\)/i);
  assert.ok(!db.ops.includes('member.update'), 'target never mutated');
  assert.ok(!db.ops.some(op => op.endsWith('.update') || op.endsWith('.delete')), 'nothing written anywhere');
});

test('successful full merge copies first, then reassigns, then anonymises, then audits', async () => {
  const db = makeFakeDb();
  const result = await performMerge({
    db, source: baseSource, target: baseTarget, adminMember: admin,
    coreFields: ['first_name', 'email'], sourceDisposal: 'reassign', callerTenantId: 't1', anonymize: makeFakeAnonymize(db),
  });
  assert.equal(result.status, 200);
  assert.ok(result.body.success);
  // email deferred until after disposal, then applied
  assert.ok(result.body.summary.copiedCoreFields.includes('email'));
  assert.ok(result.body.summary.auditNoteCreated);
  const firstMemberUpdate = db.ops.indexOf('member.update');
  const firstReassign = db.ops.indexOf('booking.update');
  const audit = db.ops.lastIndexOf('member_note.insert');
  assert.ok(firstMemberUpdate < firstReassign, 'target copy precedes reassignment');
  assert.ok(audit > firstReassign, 'audit note written last');
});

test('mid-reassignment failure is reported retryable, and a retry completes the merge', async () => {
  // First attempt: bookings move, then form_submission blows up.
  const db1 = makeFakeDb({ failOn: { 'form_submission.update': { code: 'XX000', message: 'deadlock' } } });
  const first = await performMerge({
    db: db1, source: baseSource, target: baseTarget, adminMember: admin,
    sourceDisposal: 'reassign', callerTenantId: 't1', anonymize: makeFakeAnonymize(db1),
  });
  assert.equal(first.status, 500);
  assert.equal(first.body.retryable, true);
  assert.match(first.body.error, /run the merge again/i);
  assert.ok(db1.ops.includes('booking.update'), 'earlier tables had moved');
  assert.ok(!anonRan(db1), 'source was not removed');

  // Retry with the same choices: reassignment is idempotent (already-moved
  // rows no longer match member_id=source), so the merge completes.
  const db2 = makeFakeDb();
  const second = await performMerge({
    db: db2, source: baseSource, target: baseTarget, adminMember: admin,
    sourceDisposal: 'reassign', callerTenantId: 't1', anonymize: makeFakeAnonymize(db2),
  });
  assert.equal(second.status, 200);
  assert.ok(second.body.success);
});

test('retry after engagement balances persisted does not double count', async () => {
  const credit = { eventsAttended: 4, articlesPublished: 1, jobsPosted: 0, awards: 2, engagementAwards: 0 };
  const targetWithCredit = {
    ...baseTarget,
    engagement_opening_balances: {
      eventsAttended: 9, // already includes the credit from the first attempt
      mergeCredits: { [baseSource.id]: credit },
    },
  };
  const db = makeFakeDb();
  const result = await performMerge({
    db, source: baseSource, target: targetWithCredit, adminMember: admin,
    includeEngagement: true, sourceDisposal: 'reassign', callerTenantId: 't1', anonymize: makeFakeAnonymize(db),
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.summary.engagementAlreadyApplied, true);
  assert.deepEqual(result.body.summary.engagementAdded, credit);
  // No opening-balance write happened at all on the retry (anonymisation is
  // stubbed, so any member.update would be a balance re-add).
  assert.ok(!db.ops.includes('member.update'), 'balances were not re-added');
});

test('first-time engagement fold-in records a per-source mergeCredit marker', async () => {
  const db = makeFakeDb();
  const result = await performMerge({
    db, source: { ...baseSource, engagement_opening_balances: { eventsAttended: 3 } },
    target: baseTarget, adminMember: admin,
    includeEngagement: true, sourceDisposal: 'reassign', callerTenantId: 't1', anonymize: makeFakeAnonymize(db),
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.summary.engagementCopied, true);
  assert.equal(result.body.summary.engagementAdded.eventsAttended, 3);
  assert.ok(db.ops.includes('member.update'), 'balances written once');
});

test('copy-only merge never touches the source or history tables', async () => {
  const db = makeFakeDb();
  const result = await performMerge({
    db, source: baseSource, target: baseTarget, adminMember: admin,
    coreFields: ['job_title'], sourceDisposal: 'keep', callerTenantId: 't1', anonymize: makeFakeAnonymize(db),
  });
  assert.equal(result.status, 200);
  assert.ok(!db.ops.some(op => op.startsWith('booking.')));
  assert.ok(!anonRan(db));
});

test('member_note history moves via target_member_id + author_member_id (not member_id)', () => {
  const noteRefs = REASSIGN_REFS.filter(r => r.table === 'member_note').map(r => r.column);
  assert.ok(noteRefs.includes('target_member_id'), 'notes about the source must move to the target');
  assert.ok(noteRefs.includes('author_member_id'), 'notes written by the source must move to the target');
  assert.ok(!noteRefs.includes('member_id'), 'member_note has no member_id column');
});

test('every reassignment mapping matches its schema definition (when a schema file exists)', () => {
  // Schema-contract check: a wrong column name would be silently treated as
  // "table/column missing" at runtime and history would quietly not move.
  const toSchemaFile = (table) => path.join(
    repoRoot, 'schema',
    table.split('_').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('') + '.json'
  );
  // Live columns confirmed in production code (existing anonymisation list /
  // live API queries) that the lagging schema JSONs don't declare yet.
  const schemaLagsBehindDb = new Set([
    'form_submission.member_id',
    'form_submission.created_member_id',
    'support_ticket.member_id',
    'support_ticket_response.member_id',
    'comment_reaction.member_id',
  ]);
  let checked = 0;
  for (const { table, column } of REASSIGN_REFS) {
    if (schemaLagsBehindDb.has(`${table}.${column}`)) continue;
    const schemaPath = toSchemaFile(table);
    if (!fs.existsSync(schemaPath)) continue; // legacy tables without schema JSON
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    const props = schema.properties || schema;
    assert.ok(
      Object.prototype.hasOwnProperty.call(props, column),
      `REASSIGN_REFS maps ${table}.${column} but schema/${path.basename(schemaPath)} has no such column`
    );
    checked += 1;
  }
  assert.ok(checked >= 15, `schema check should cover most refs (covered ${checked})`);
});

test('organization_note attribution moves via member_id and wall-of-fame entries are covered', () => {
  const covered = new Set(REASSIGN_REFS.map(r => `${r.table}.${r.column}`));
  assert.ok(covered.has('organization_note.member_id'), 'org-note author column is member_id');
  assert.ok(!covered.has('organization_note.author_member_id'), 'author_member_id does not exist on organization_note');
  assert.ok(covered.has('wall_of_fame_person.member_id'));
});

test('key history tables are covered by the full-merge reassignment', () => {
  const covered = new Set(REASSIGN_REFS.map(r => `${r.table}.${r.column}`));
  for (const ref of [
    'booking.member_id',
    'complex_event_booking.member_id',
    'member_group_assignment.member_id',
    'form_submission.member_id',
    'email_campaign_recipient.member_id',
    'blog_post.author_id',
    'job_posting.posted_by_member_id',
    'offline_award_assignment.member_id',
    'engagement_award_assignment.member_id',
    'membership_billing_agreements.member_id',
    'membership_payment_plans.member_id',
  ]) {
    assert.ok(covered.has(ref), `expected ${ref} in REASSIGN_REFS`);
  }
});

test('audit note payload matches the member_note API column contract', () => {
  const payload = buildAuditNotePayload({
    targetId: 'target-uuid',
    adminId: 'admin-uuid',
    adminName: 'Ada Admin',
    sourceName: 'Sam Source',
    sourceEmail: 'sam@example.com',
    sourceId: 'source-uuid',
    summary: { copiedCoreFields: ['email'], copiedCustomFields: ['f1', 'f2'], engagementCopied: true },
    outcomeLabel: 'source record left untouched',
  });
  assert.equal(payload.target_member_id, 'target-uuid');
  assert.equal(payload.author_member_id, 'admin-uuid');
  assert.deepEqual(payload.attachments, []);
  assert.ok(!('member_id' in payload) && !('created_by' in payload));
  assert.match(payload.content, /\[Member merge\] Ada Admin merged "Sam Source" \(sam@example\.com, id source-uuid\)/);
  assert.match(payload.content, /Fields copied: email\./);
  assert.match(payload.content, /Custom fields copied: 2\./);
  assert.match(payload.content, /Engagement statistics copied/);
  assert.match(payload.content, /Source outcome: source record left untouched\./);
});
