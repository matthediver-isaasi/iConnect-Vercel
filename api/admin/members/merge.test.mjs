import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
import { REASSIGN_REFS, buildAuditNotePayload, performMerge } from './merge.js';

// Minimal supabase-compatible fake. `failOn` maps "table.op" -> error object.
// Records every terminal operation so tests can assert ordering/absence.
function makeFakeDb({ failOn = {}, prefRows = [], billingRows = [] } = {}) {
  const ops = [];
  const ok = (data = null) => Promise.resolve({ data, error: null });
  const fail = (error) => Promise.resolve({ data: null, error });
  function table(name) {
    const finish = (op, data) => {
      ops.push(`${name}.${op}`);
      const err = failOn[`${name}.${op}`];
      return err ? fail(err) : ok(data);
    };
    const chain = (op, data, error) => {
      const p = { };
      const resolveData = () => error ? fail(error) : finish(op, data);
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
      select: (cols) => chain('select', name === 'member_preference_value' ? prefRows : name === 'membership_billing_agreements' ? billingRows : []),
      update: (values) => {
        if (name === 'form_submission' && 'member_id' in values) {
          ops.push('form_submission.update:member_id');
          return chain('update', null, { code: 'PGRST204', message: "Could not find the 'member_id' column of 'form_submission' in the schema cache" });
        }
        return chain('update');
      },
      insert: () => chain('insert'),
      upsert: () => chain('upsert'),
      delete: () => chain('delete'),
    };
  }
  return { from: table, ops, rpc: async (name) => {
    ops.push(`rpc.${name}`);
    return { error: failOn[`rpc.${name}`] || null };
  } };
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

// Persist mutations across attempts, including filters and the audit lookup.
// The fallback handles unrelated empty tables and the billing/group preflight.
function makePersistentDb() {
  const db = makeFakeDb();
  const emptyFrom = db.from;
  db.rows = {
    member: [
      { ...structuredClone(baseSource), engagement_opening_balances: { eventsAttended: 3 } },
      { ...structuredClone(baseTarget), engagement_opening_balances: { eventsAttended: 2 } },
    ],
    booking: [{ id: 'booking', member_id: baseSource.id, event_id: 'event', status: 'confirmed' }],
    form_submission: [
      { id: 'linked', created_member_id: baseSource.id, submitted_by_email: baseSource.email, submission_data: { answer: 'Original answer' } },
      { id: 'email-only', created_member_id: null, submitted_by_email: baseSource.email, submission_data: { answer: 'Email only' } },
    ],
    member_note: [],
    forum_thread: [
      { id: 'member-thread', created_by: baseSource.id, created_by_type: 'member', title: 'Original title' },
      { id: 'staff-thread', created_by: baseSource.id, created_by_type: 'tenant_user', title: 'Staff title' },
    ],
    forum_post: [
      { id: 'member-post', created_by: baseSource.id, created_by_type: 'member', content: 'Original post' },
      { id: 'staff-post', created_by: baseSource.id, created_by_type: 'tenant_user', content: 'Staff post' },
    ],
    forum_reaction: [{ id: 'reaction', member_id: baseSource.id, reaction_type: 'like' }],
  };
  db.from = (table) => {
    if (!(table in db.rows)) return emptyFrom(table);
    const chain = (op, values) => {
      const filters = [];
      const query = {
        eq: (key, value) => { filters.push(row => row[key] === value); return query; },
        like: (key, value) => { filters.push(row => row[key]?.includes(value.slice(1, -1))); return query; },
        then: (resolve, reject) => Promise.resolve().then(() => {
          db.ops.push(`${table}.${op}`);
          if (table.startsWith('forum_')) {
            if (op === 'update' && table !== 'forum_reaction' && 'member_id' in values) {
              return { data: null, error: { code: 'PGRST204', message: `${table} has no member_id column` } };
            }
            if (db.forumErrors?.[table]) return { data: null, error: db.forumErrors[table] };
          }
          if (table === 'form_submission' && op === 'update') {
            if ('member_id' in values) return { data: null, error: {
              code: 'PGRST204',
              message: "Could not find the 'member_id' column of 'form_submission' in the schema cache",
            } };
            if (db.submissionError) return { data: null, error: db.submissionError };
          }
          const rows = db.rows[table].filter(row => filters.every(matches => matches(row)));
          if (op === 'update') rows.forEach(row => Object.assign(row, structuredClone(values)));
          if (op === 'insert') db.rows[table].push({ id: `note-${db.rows[table].length}`, ...structuredClone(values) });
          return { data: op === 'select' ? structuredClone(rows) : null, error: null };
        }).then(resolve, reject),
      };
      return query;
    };
    return {
      select: () => chain('select'),
      update: values => chain('update', values),
      insert: values => chain('insert', values),
    };
  };
  return db;
}

test('fixture reproduces the reported PostgREST response for the invalid submission column', async () => {
  const db = makePersistentDb();
  const result = await db.from('form_submission').update({ member_id: baseTarget.id }).eq('member_id', baseSource.id);
  assert.equal(result.error.code, 'PGRST204');
  assert.match(result.error.message, /'member_id'.*'form_submission'.*schema cache/);
});

for (const code of ['PGRST204', '42703', '42P01', 'XX000']) {
  test(`supported submission reference failure ${code} preserves source; same-choice retry preserves history and credit`, async () => {
    const db = makePersistentDb();
    const originalSubmissions = structuredClone(db.rows.form_submission);
    const sourceSnapshot = structuredClone(db.rows.member[0]);
    db.submissionError = { code, message: 'Supported created_member_id transfer failed' };
    const run = () => performMerge({
      db, source: structuredClone(db.rows.member[0]), target: structuredClone(db.rows.member[1]),
      coreFields: ['first_name'], includeEngagement: true, sourceDisposal: 'reassign',
      callerTenantId: 't1', adminMember: admin,
      anonymize: async id => {
        db.ops.push(`ANONYMIZE:${id}`);
        assert.equal(db.rows.form_submission[0].created_member_id, baseTarget.id);
        // Mirror disposal's nullification of remaining source-owned submissions.
        await db.from('form_submission').update({ created_member_id: null }).eq('created_member_id', id);
        db.rows.member[0].email = `deleted_${id}@deleted.local`;
        return { success: true };
      },
    });
    const first = await run();
    assert.equal(first.status, 500);
    assert.equal(first.body.retryable, true);
    assert.match(first.body.error, /form_submission.created_member_id.*Supported created_member_id transfer failed/);
    assert.deepEqual(db.rows.member[0], sourceSnapshot);
    assert.equal(anonRan(db), false);
    assert.equal(db.rows.booking[0].member_id, baseTarget.id);
    assert.equal(db.rows.member_note.length, 0);
    assert.equal(db.rows.member[1].engagement_opening_balances.eventsAttended, 5);

    db.submissionError = null;
    const second = await run();
    assert.equal(second.status, 200);
    assert.equal(second.body.summary.engagementAlreadyApplied, true);
    assert.equal(db.rows.member[1].engagement_opening_balances.eventsAttended, 5);
    assert.equal(db.rows.booking.length, 1);
    assert.equal(db.rows.booking[0].member_id, baseTarget.id);
    assert.deepEqual(db.rows.form_submission, [
      { ...originalSubmissions[0], created_member_id: baseTarget.id }, originalSubmissions[1],
    ]);
    assert.equal(db.rows.member_note.length, 1);
    assert.match(db.rows.member_note[0].content, /\[Member merge\]/);
  });
}

test('existing merge audit is not inserted again', async () => {
  const db = makePersistentDb();
  db.rows.member_note.push({ id: 'prior-audit', target_member_id: baseTarget.id,
    content: `[Member merge] Previous merge (id ${baseSource.id})` });
  const result = await performMerge({
    db, source: baseSource, target: baseTarget, sourceDisposal: 'reassign',
    callerTenantId: 't1', adminMember: admin, anonymize: makeFakeAnonymize(db),
  });
  assert.equal(result.status, 200);
  assert.equal(db.rows.member_note.length, 1);
  assert.ok(!db.ops.includes('member_note.insert'));
});

test('reference contract excludes unsupported member_id columns and pins the created-member migration', () => {
  for (const table of ['form_submission', 'support_ticket', 'support_ticket_response', 'comment_reaction', 'forum_thread', 'forum_post']) {
    assert.ok(!REASSIGN_REFS.some(ref => ref.table === table && ref.column === 'member_id'));
  }
  const migration = fs.readFileSync(path.join(repoRoot, 'supabase/migrations/20260420_add_form_submission_created_ids.sql'), 'utf8');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS created_member_id UUID REFERENCES member\(id\)/);
});

test('forum reference contract matches initialization DDL and scopes polymorphic authors', () => {
  const ddl = fs.readFileSync(path.join(repoRoot, 'api/admin/init-forum-tables.js'), 'utf8');
  const refs = REASSIGN_REFS.filter(ref => ref.table.startsWith('forum_'));
  assert.equal(refs.length, 3);
  for (const ref of refs) {
    const tableDdl = ddl.split(`CREATE TABLE IF NOT EXISTS ${ref.table} (`)[1]?.split(');')[0];
    assert.ok(tableDdl, ref.table);
    assert.match(tableDdl, new RegExp(`\\b${ref.column} UUID NOT NULL`));
    assert.equal(ref.optionalTable, true);
    if (ref.column === 'created_by') {
      assert.equal(ref.memberAuthorsOnly, true);
      assert.match(tableDdl, /created_by_type TEXT NOT NULL/);
    }
  }
  assert.deepEqual(REASSIGN_REFS.filter(ref => ref.optionalTable), refs, 'only separately initialized forum tables are optional');
});

test('late forum failure can be retried without losing member history or changing staff authorship', async () => {
  const db = makePersistentDb();
  const original = structuredClone(db.rows);
  db.forumErrors = { forum_post: { code: 'PGRST204', message: 'Forum schema cache needs repair' } };
  const run = () => performMerge({
    db, source: structuredClone(db.rows.member[0]), target: structuredClone(db.rows.member[1]),
    includeEngagement: true, sourceDisposal: 'reassign', callerTenantId: 't1', adminMember: admin,
    anonymize: makeFakeAnonymize(db),
  });
  const first = await run();
  assert.equal(first.status, 500);
  assert.match(first.body.error, /forum_post.created_by.*Forum schema cache needs repair/);
  assert.equal(first.body.retryable, true);
  assert.equal(anonRan(db), false);
  assert.deepEqual(db.rows.member[0], original.member[0]);
  assert.equal(db.rows.form_submission[0].created_member_id, baseTarget.id);
  assert.equal(db.rows.forum_thread[0].created_by, baseTarget.id);
  assert.equal(db.rows.forum_post[0].created_by, baseSource.id);
  assert.equal(db.rows.member_note.length, 0);
  db.forumErrors = {};
  const second = await run();
  assert.equal(second.status, 200);
  assert.equal(second.body.summary.engagementAlreadyApplied, true);
  assert.equal(db.rows.member[1].engagement_opening_balances.eventsAttended, 5);
  for (const table of ['forum_thread', 'forum_post']) {
    assert.deepEqual(db.rows[table], [
      { ...original[table][0], created_by: baseTarget.id }, original[table][1],
    ]);
  }
  assert.deepEqual(db.rows.forum_reaction, [{ ...original.forum_reaction[0], member_id: baseTarget.id }]);
  assert.equal(db.rows.member_note.length, 1);
  assert.equal(anonRan(db), true);
});

for (const code of ['42P01', 'PGRST205']) {
  test(`uninitialized optional forum tables (${code}) do not prevent completion`, async () => {
    const db = makePersistentDb();
    db.forumErrors = Object.fromEntries(['forum_thread', 'forum_post', 'forum_reaction']
      .map(table => [table, { code, message: `Table ${table} does not exist` }]));
    for (const table of Object.keys(db.forumErrors)) db.rows[table] = [];
    const result = await performMerge({
      db, source: baseSource, target: baseTarget, sourceDisposal: 'reassign',
      callerTenantId: 't1', adminMember: admin, anonymize: makeFakeAnonymize(db),
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.summary.reassigned.filter(ref => ref.skipped === 'optional table missing').length, 3);
    assert.equal(db.rows.form_submission[0].created_member_id, baseTarget.id);
    assert.equal(anonRan(db), true);
  });
}

test('active billing refuses both destructive merge choices before any writes', async () => {
  for (const sourceDisposal of ['anonymise', 'reassign']) {
    const db = makeFakeDb({ billingRows: [{ id: 'agreement', status: 'active', provider: 'stripe' }] });
    const result = await performMerge({ db, source: baseSource, target: baseTarget,
      sourceDisposal, coreFields: ['first_name'], callerTenantId: 't1', adminMember: admin,
      anonymize: makeFakeAnonymize(db) });
    assert.equal(result.status, 409);
    assert.equal(anonRan(db), false);
    assert.ok(db.ops.every(op => op.endsWith('.select')));
  }
});

test('failed billing read refuses disposal without hiding the partial check', async () => {
  const db = makeFakeDb({ failOn: { 'membership_payment_plans.select': { message: 'offline' } } });
  const result = await performMerge({ db, source: baseSource, target: baseTarget,
    sourceDisposal: 'anonymise', callerTenantId: 't1', anonymize: makeFakeAnonymize(db) });
  assert.equal(result.status, 503);
  assert.ok(result.body.failures.includes('membership_payment_plans'));
  assert.equal(anonRan(db), false);
  assert.ok(db.ops.every(op => op.endsWith('.select')));
});

test('group limit refusal precedes every destructive merge reference and anonymisation', async () => {
  const db = makeFakeDb({ failOn: { 'rpc.merge_member_group_assignments': {
    code: '23514', message: 'Member group limit reached (0)',
  } } });
  const result = await performMerge({ db, source: baseSource, target: baseTarget,
    sourceDisposal: 'reassign', callerTenantId: 't1', adminMember: admin, anonymize: makeFakeAnonymize(db) });
  assert.equal(result.status,409);
  assert.equal(anonRan(db),false);
  assert.ok(!db.ops.some(op=>op.startsWith('booking.')));
});

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
  // Schema-contract check: unsupported mappings must fail here, not halt a
  // live merge after earlier history has already moved.
  const toSchemaFile = (table) => path.join(
    repoRoot, 'schema',
    table.split('_').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('') + '.json'
  );
  let checked = 0;
  for (const { table, column } of REASSIGN_REFS) {
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
    'form_submission.created_member_id',
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
