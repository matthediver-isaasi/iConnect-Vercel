/**
 * Task #3680 — tests for the form monthly-card checkout finalisation module.
 *
 * The production module (formMonthlyCardFinalize.js) uses an owner-token lease:
 * every claim stamps a random owner_token into payment_meta.monthly_card_state,
 * and every release / renewal / done-stamp is guarded by an owner-token CAS so
 * that an expired worker can never clobber a lease that a newer worker has
 * reclaimed. It also renews the lease immediately after the pipeline runs and
 * refuses to continue if ownership was lost.
 *
 * These behaviours only make sense against a fake that actually PERSISTS the
 * row and applies eq()/filter()/is() predicates on both select and update.
 * So this file uses a single reusable stateful Supabase fake (makeSupabase)
 * instead of the per-test ad-hoc chains that could not model ownership.
 *
 * The attach-member + insert/adopt-history step now runs inside the
 * SECURITY DEFINER RPC claim_form_monthly_card_membership (via
 * claimFormMonthlyCardMembership). The stateful fake models that RPC
 * faithfully — atomic member attach, idempotent history adoption, and the two
 * durable conflict codes (MEMBERSHIP_YEAR_EXISTS, OPEN_MEMBERSHIP_AGREEMENT_
 * EXISTS) — and also supports injected transport errors / result overrides so
 * the finalizer's retry and conflict handling can be exercised.
 *
 * Coverage:
 *   1. finalizeFormMonthlyCardCheckout against the stateful fake:
 *      – no-op / error branches
 *      – absent → processing → done happy path (with owner-token guard)
 *      – fresh concurrent lease → retryable, no side effects
 *      – stale lease reclaimed and completed
 *      – pipeline unresolved member → lease released for retry; second call succeeds
 *      – done stamp only after the membership claim; emails after the claim
 *      – RPC idempotent adoption; RPC transport error / non-conflict failure release the lease
 *      – RPC attaches the member atomically
 *   2. Durable membership conflicts:
 *      – existing-year conflict (MEMBERSHIP_YEAR_EXISTS)
 *      – open-DD conflict (OPEN_MEMBERSHIP_AGREEMENT_EXISTS)
 *      each asserts a durable conflict state, no duplicate history, no emails,
 *      no done stamp; plus short-circuit on re-entry and lost-lease fallback.
 *   3. Owner-token lease invariants (architect-requested):
 *      (a) old worker cannot release a newer reclaimed lease
 *      (b) old worker cannot stamp done over a newer lease
 *      (c) lease renewal is owner-CAS guarded (only the active owner renews)
 *   4. isFormMonthlyCardFinalized + isFormMonthlyCardProcessing helpers
 *   5. Source-contract tests (wiring, migration, sweep, webhook, owner_token, RPC, conflict)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  finalizeFormMonthlyCardCheckout,
  isFormMonthlyCardFinalized,
  isFormMonthlyCardProcessing,
  FINALIZE_CLAIM_TTL_MS,
} from './formMonthlyCardFinalize.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => readFileSync(path.join(here, rel), 'utf8');

// ===========================================================================
// Reusable stateful Supabase fake
// ===========================================================================
//
// Persists rows per table and applies PostgREST-style predicates so the
// owner-token CAS in the production code behaves exactly as it would against
// a real database.
//
// Supported chain methods: select / insert / update / eq / neq / is / filter /
// order / limit / maybeSingle / single, plus thenable resolution (for awaited
// update()/insert() without maybeSingle()).
//
// Options:
//   tables:      { tableName: [rows...] }  initial rows (deep-cloned)
//   errors:      { 'op:table': errorObj }  inject an error for an operation
//                op ∈ select|insert|update. Applied once then cleared unless
//                the value is a function returning an error (persistent).
//   uniqueIndex: { table: [columnName...] } enforce uniqueness → 23505 on insert
//   onInsert / onUpdate / onSelect: optional spies (table, ctx) => void
//
// A test can inspect fake.tables to assert final persisted state, and
// fake.log for the ordered list of {op, table} operations.

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

// Read a PostgREST JSON path like "payment_meta->monthly_card_state->>owner_token"
// or a plain column "payment_status" from a row.
function readPath(row, columnPath) {
  // Split into the base column and the JSON traversal.
  // e.g. payment_meta->monthly_card_state->>owner_token
  const parts = columnPath.split('->');
  const base = parts[0].trim();
  let val = row[base];
  for (let i = 1; i < parts.length; i++) {
    if (val == null) return undefined;
    let seg = parts[i].trim();
    // ->>key returns text; ->key returns json. We treat both as JS value.
    if (seg.startsWith('>')) seg = seg.slice(1).trim();
    val = val[seg];
  }
  return val;
}

function matchesPredicate(row, pred) {
  const actual = readPath(row, pred.column);
  switch (pred.op) {
    case 'eq':
      // PostgREST ->> yields text; compare loosely as strings when target is
      // a JSON-path text extraction.
      if (pred.column.includes('->>')) {
        return String(actual) === String(pred.value);
      }
      return actual === pred.value;
    case 'neq':
      return actual !== pred.value;
    case 'is':
      if (pred.value === null || pred.value === 'null') {
        return actual === null || actual === undefined;
      }
      return actual === pred.value;
    default:
      return true;
  }
}

// Statuses the RPC treats as an "open" competing agreement for a member+year.
const OPEN_AGREEMENT_STATUSES = new Set([
  'payment_setup_required',
  'mandate_pending',
  'first_payment_pending',
  'active',
  'payment_grace_period',
  'payment_overdue',
]);

function makeSupabase({
  tables = {},
  errors = {},
  uniqueIndex = {},
  hooks = {},
  // rpc controls for claim_form_monthly_card_membership.
  //   rpc.error      → { data:null, error } transport-level failure (retryable)
  //   rpc.result     → force a specific { data } JSONB response, bypassing the
  //                    modelled logic (used to inject arbitrary conflict codes)
  //   rpc.onCall(args) optional spy
  rpc = {},
} = {}) {
  const store = {};
  for (const [t, rows] of Object.entries(tables)) {
    store[t] = rows.map((r) => clone(r));
  }
  const log = [];

  function takeError(op, table) {
    const key = `${op}:${table}`;
    const e = errors[key];
    if (!e) return null;
    if (typeof e === 'function') return e();
    delete errors[key]; // one-shot
    return e;
  }

  function violatesUnique(table, candidate, ignoreRow) {
    const cols = uniqueIndex[table];
    if (!cols || !cols.length) return false;
    const rows = store[table] || [];
    return rows.some((r) => {
      if (r === ignoreRow) return false;
      return cols.every((c) => {
        const v = candidate[c];
        // Partial unique index semantics: only NON-NULL values conflict.
        if (v == null) return false;
        return r[c] === v;
      });
    });
  }

  // Faithful in-memory model of the SECURITY DEFINER RPC
  // claim_form_monthly_card_membership (migration 20260819). It atomically
  // attaches the member to the agreement and inserts (or adopts) the pending
  // membership-year history row, returning the same JSONB shape the real
  // function does. Conflicts return { ok:false, conflict:true, code, detail }.
  function claimRpc(args) {
    if (rpc.onCall) rpc.onCall(args);
    if (rpc.error) return { data: null, error: rpc.error };
    if (rpc.result) return { data: rpc.result, error: null };

    const {
      p_agreement_id: agreementId,
      p_submission_id: submissionId,
      p_member_id: memberId,
      p_history: history = {},
    } = args;

    const agreement = (store.membership_billing_agreements || []).find((a) => a.id === agreementId);
    // Validate the agreement association (provider/type/submission linkage).
    if (
      !agreement
      || agreement.provider !== 'stripe'
      || agreement.agreement_type !== 'member'
      || String(agreement.metadata?.form_submission_id || '') !== String(submissionId)
    ) {
      return {
        data: {
          ok: false, conflict: false, code: 'INVALID_AGREEMENT',
          detail: 'The billing agreement does not match this form submission',
        },
        error: null,
      };
    }

    const year = agreement.metadata?.card?.membership_year || null;
    if (!year || !memberId) {
      return {
        data: {
          ok: false, conflict: false, code: 'INVALID_MEMBERSHIP_IDENTITY',
          detail: 'The member or membership year is missing',
        },
        error: null,
      };
    }

    const historyRows = store.member_membership_history || [];

    // Idempotent re-entry: history already exists for this agreement.
    const existingForAgreement = historyRows.find((h) => h.billing_agreement_id === agreementId);
    if (existingForAgreement) {
      if (agreement.member_id && agreement.member_id !== memberId) {
        return {
          data: {
            ok: false, conflict: true, code: 'AGREEMENT_MEMBER_MISMATCH',
            detail: 'The agreement is already attached to another member',
          },
          error: null,
        };
      }
      return { data: { ok: true, idempotent: true, history_id: existingForAgreement.id }, error: null };
    }

    // Existing-year conflict: any history row for this tenant+member+year.
    const yearConflict = historyRows.find(
      (h) => h.tenant_id === agreement.tenant_id && h.member_id === memberId && h.membership_year === year,
    );
    if (yearConflict) {
      return {
        data: {
          ok: false, conflict: true, code: 'MEMBERSHIP_YEAR_EXISTS',
          detail: 'Membership for this year is already recorded',
          history_id: yearConflict.id,
        },
        error: null,
      };
    }

    // Open-agreement conflict: another live agreement for this member+year.
    const openConflict = (store.membership_billing_agreements || []).find((a) => {
      if (a.id === agreementId) return false;
      if (a.member_id !== memberId) return false;
      if (!OPEN_AGREEMENT_STATUSES.has(a.status)) return false;
      const otherYear = a.metadata?.card?.membership_year || a.metadata?.dd?.membership_year || null;
      return otherYear === year;
    });
    if (openConflict) {
      return {
        data: {
          ok: false, conflict: true, code: 'OPEN_MEMBERSHIP_AGREEMENT_EXISTS',
          detail: 'A monthly payment agreement already exists for this membership year',
          agreement_id: openConflict.id,
        },
        error: null,
      };
    }

    // Attach member + insert history atomically.
    if (agreement.member_id && agreement.member_id !== memberId) {
      return {
        data: {
          ok: false, conflict: true, code: 'AGREEMENT_MEMBER_MISMATCH',
          detail: 'The agreement was attached to another member concurrently',
        },
        error: null,
      };
    }
    agreement.member_id = memberId;
    agreement.updated_at = new Date().toISOString();

    const num = (v) => (v === '' || v == null ? null : Number(v));
    const historyRow = {
      id: `gen-history-${historyRows.length + 1}`,
      tenant_id: agreement.tenant_id,
      member_id: memberId,
      membership_year: year,
      config_id: history.config_id || null,
      band_id: history.band_id || null,
      tier_label: history.tier_label || null,
      field_value: history.field_value ?? null,
      annual_cost: num(history.annual_cost),
      final_cost: num(history.plan_total) ?? num(history.final_cost),
      currency: history.currency || 'GBP',
      billing_period: 'monthly_card',
      vat_rate_percent: num(history.vat_rate_percent),
      vat_amount: num(history.vat_amount) ?? 0,
      total_with_vat: num(history.plan_total) ?? num(history.total_with_vat) ?? num(history.final_cost),
      payment_method: 'card_monthly',
      status: 'pending_payment_setup',
      payment_status: 'unpaid',
      billing_agreement_id: agreementId,
      notes: `Monthly card plan started via form. Form submission: ${submissionId} (monthly-card checkout).`,
    };
    store.member_membership_history = store.member_membership_history || [];
    store.member_membership_history.push(historyRow);
    if (hooks.onInsert) hooks.onInsert('member_membership_history', { rows: [historyRow] });
    log.push({ op: 'rpc', table: 'member_membership_history', count: 1 });

    return { data: { ok: true, idempotent: false, history_id: historyRow.id }, error: null };
  }

  return {
    tables: store,
    log,
    // expose for tests to mutate mid-flight (simulating a concurrent worker)
    _readRow(table, id) {
      return (store[table] || []).find((r) => r.id === id) || null;
    },
    async rpc(name, args) {
      log.push({ op: 'rpc', name });
      if (name === 'claim_form_monthly_card_membership') return claimRpc(args);
      throw new Error(`Unmodelled rpc: ${name}`);
    },
    from(table) {
      const predicates = [];
      let mode = null; // 'select' | 'insert' | 'update'
      let payload = null; // update payload or insert payload

      const applyFilters = (rows) => rows.filter((r) => predicates.every((p) => matchesPredicate(r, p)));

      const runSelect = () => {
        const err = takeError('select', table);
        if (err) return { data: null, error: err, _rows: [] };
        const rows = applyFilters(store[table] || []);
        if (hooks.onSelect) hooks.onSelect(table, { predicates, rows });
        return { data: null, error: null, _rows: rows.map((r) => clone(r)) };
      };

      const runUpdate = () => {
        const err = takeError('update', table);
        if (err) return { data: null, error: err, _rows: [] };
        const rows = applyFilters(store[table] || []);
        for (const r of rows) {
          Object.assign(r, clone(payload));
        }
        if (hooks.onUpdate) hooks.onUpdate(table, { predicates, payload, matched: rows.length });
        log.push({ op: 'update', table, matched: rows.length });
        return { data: null, error: null, _rows: rows.map((r) => clone(r)) };
      };

      const runInsert = () => {
        const err = takeError('insert', table);
        if (err) return { data: null, error: err, _rows: [] };
        const items = Array.isArray(payload) ? payload : [payload];
        const inserted = [];
        for (const item of items) {
          if (violatesUnique(table, item)) {
            return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' }, _rows: [] };
          }
          const row = clone(item);
          if (row.id == null) row.id = `gen-${table}-${(store[table]?.length || 0) + inserted.length + 1}`;
          inserted.push(row);
        }
        store[table] = store[table] || [];
        store[table].push(...inserted);
        if (hooks.onInsert) hooks.onInsert(table, { rows: inserted });
        log.push({ op: 'insert', table, count: inserted.length });
        return { data: null, error: null, _rows: inserted.map((r) => clone(r)) };
      };

      const execute = () => {
        if (mode === 'insert') return runInsert();
        if (mode === 'update') return runUpdate();
        return runSelect();
      };

      const chain = {
        select() { if (!mode) mode = 'select'; return chain; },
        insert(p) { mode = 'insert'; payload = p; return chain; },
        update(p) { mode = 'update'; payload = p; return chain; },
        eq(column, value) { predicates.push({ op: 'eq', column, value }); return chain; },
        neq(column, value) { predicates.push({ op: 'neq', column, value }); return chain; },
        is(column, value) { predicates.push({ op: 'is', column, value }); return chain; },
        filter(column, op, value) { predicates.push({ op, column, value }); return chain; },
        order() { return chain; },
        limit() { return chain; },
        maybeSingle() {
          const res = execute();
          if (res.error) return Promise.resolve({ data: null, error: res.error });
          return Promise.resolve({ data: res._rows[0] || null, error: null });
        },
        single() { return chain.maybeSingle(); },
        then(resolve, reject) {
          const res = execute();
          // Awaited update()/insert()/select() without maybeSingle → return array.
          return Promise.resolve({ data: res.error ? null : res._rows, error: res.error }).then(resolve, reject);
        },
      };
      return chain;
    },
  };
}

// ===========================================================================
// Fixtures
// ===========================================================================

const SNAPSHOT = {
  kind: 'monthly_card',
  monthly_amount: 10,
  monthly_amount_minor: 1000,
  instalment_count: 12,
  plan_total: 120,
  currency: 'GBP',
  membership_year: '2026/27',
  config_id: 'cfg1',
  band_id: 'b1',
  tier_label: 'Full',
  annual_cost: 100,
  final_cost: 120,
};

const AGREEMENT = {
  id: 'ag1',
  tenant_id: 'ten1',
  provider: 'stripe',
  agreement_type: 'member',
  member_id: null,
  metadata: { card: SNAPSHOT, form_submission_id: 'sub1' },
  status: 'payment_setup_required',
};

// Form deliberately has NO entity pipelines so runFormEntityPipelines returns
// early with memberId: null and never touches the network. Member resolution
// is therefore driven purely by the persisted form_submission.created_member_id,
// which is exactly what the test wants to control.
const FORM = {
  id: 'form1',
  tenant_id: 'ten1',
  name: 'Test Form',
  fields: [],
  entity_pipelines: { members: [], organisations: [] },
  submission_emails: [],
};

function makeSub(overrides = {}) {
  return {
    id: 'sub1',
    tenant_id: 'ten1',
    form_id: 'form1',
    payment_status: 'setup_complete',
    payment_provider: 'stripe_monthly_card',
    payment_meta: { monthly_card: { agreement_id: 'ag1' } },
    submission_data: {},
    created_member_id: null,
    ...overrides,
  };
}

// A ready-to-run stateful fake for the happy path: submission is
// setup_complete with a resolved member, form + agreement present, unique
// index on history enforced.
function happyFake(subOverrides = {}, extra = {}) {
  return makeSupabase({
    tables: {
      form_submission: [makeSub({ created_member_id: 'mem1', ...subOverrides })],
      form: [FORM],
      membership_billing_agreements: [AGREEMENT],
      member_membership_history: [],
    },
    uniqueIndex: { member_membership_history: ['billing_agreement_id'] },
    ...extra,
  });
}

const run = (db, agreement = AGREEMENT) =>
  finalizeFormMonthlyCardCheckout({ db, agreement, session: { metadata: {} }, baseUrl: '' });

// A released lease is now DELETED, not stored as JSON null. Production runs
// `delete nextMeta.monthly_card_state` so the payment_meta JSONB no longer
// carries the key at all — this is what makes the PostgREST/SQL predicate
// `payment_meta->monthly_card_state IS NULL` see the row as released. (A JSON
// null value would NOT satisfy that predicate; see the direct-Postgres test at
// the end of this file.) So the correct assertion for a released lease is KEY
// ABSENCE: hasOwnProperty === false and the read === undefined — never a stored
// `null`.
function assertLeaseReleased(db, submissionId = 'sub1') {
  const meta = db._readRow('form_submission', submissionId).payment_meta;
  assert.equal(
    Object.prototype.hasOwnProperty.call(meta, 'monthly_card_state'),
    false,
    'released lease must DELETE the monthly_card_state key, not store JSON null',
  );
  assert.equal(
    meta.monthly_card_state,
    undefined,
    'released lease key must read as undefined (absent), not null',
  );
  assert.notEqual(
    meta.monthly_card_state,
    null,
    'released lease must not be stored as JSON null',
  );
}

// ===========================================================================
// Tests: no-op / early returns
// ===========================================================================

test('no form_submission_id → not handled', async () => {
  const db = happyFake();
  const result = await finalizeFormMonthlyCardCheckout({
    db,
    agreement: { ...AGREEMENT, metadata: { card: SNAPSHOT } },
    session: { metadata: {} },
    baseUrl: '',
  });
  assert.equal(result.handled, false);
  assert.match(result.detail, /no form_submission_id/);
});

test('DB error loading submission → retryable', async () => {
  const db = makeSupabase({
    tables: { form_submission: [makeSub()] },
    errors: { 'select:form_submission': { message: 'db down' } },
  });
  const result = await run(db);
  assert.equal(result.retryable, true);
  assert.match(result.detail, /load form_submission failed/);
});

test('submission not found → retryable', async () => {
  const db = makeSupabase({ tables: { form_submission: [] } });
  const result = await run(db);
  assert.equal(result.retryable, true);
  assert.match(result.detail, /not found/);
});

test('submission with wrong status (paid = annual path) → not handled', async () => {
  const db = makeSupabase({ tables: { form_submission: [makeSub({ payment_status: 'paid' })] } });
  const result = await run(db);
  assert.equal(result.handled, false);
  assert.equal(result.retryable, undefined);
});

test('pending submission is CAS-promoted to setup_complete then finalized', async () => {
  const db = happyFake({ payment_status: 'pending' });
  const result = await run(db);
  assert.equal(result.handled, true);
  const row = db._readRow('form_submission', 'sub1');
  assert.equal(row.payment_status, 'setup_complete');
  assert.equal(row.payment_meta.monthly_card_state.status, 'done');
});

// ===========================================================================
// Tests: already-done terminal state
// ===========================================================================

test('already done state → handled + alreadyFinalized, no claim writes', async () => {
  const db = happyFake({
    payment_meta: {
      monthly_card: { agreement_id: 'ag1' },
      monthly_card_state: { status: 'done', done_at: new Date().toISOString() },
    },
  });
  const result = await run(db);
  assert.equal(result.handled, true);
  assert.equal(result.alreadyFinalized, true);
  // No update to form_submission at all.
  assert.equal(db.log.filter((l) => l.op === 'update' && l.table === 'form_submission').length, 0);
});

// ===========================================================================
// Tests: fresh concurrent lease → retryable
// ===========================================================================

test('fresh processing lease from another owner → retryable, no side effects', async () => {
  const db = happyFake({
    payment_meta: {
      monthly_card: { agreement_id: 'ag1' },
      monthly_card_state: {
        status: 'processing',
        claimed_at: new Date().toISOString(), // fresh
        owner_token: 'other-owner',
      },
    },
  });
  const result = await run(db);
  assert.equal(result.handled, false);
  assert.equal(result.retryable, true);
  assert.match(result.detail, /in progress/);
  // No history inserted, no agreement mutated, lease still owned by other.
  assert.equal((db.tables.member_membership_history || []).length, 0);
  assert.equal(db._readRow('membership_billing_agreements', 'ag1').member_id, null);
  assert.equal(db._readRow('form_submission', 'sub1').payment_meta.monthly_card_state.owner_token, 'other-owner');
});

// ===========================================================================
// Tests: stale lease reclaimed
// ===========================================================================

test('stale processing lease is reclaimed (new owner_token) and completes', async () => {
  const staleTime = new Date(Date.now() - FINALIZE_CLAIM_TTL_MS - 60_000).toISOString();
  const db = happyFake({
    created_member_id: 'mem1',
    payment_meta: {
      monthly_card: { agreement_id: 'ag1' },
      monthly_card_state: {
        status: 'processing',
        claimed_at: staleTime,
        owner_token: 'dead-worker',
      },
    },
  });
  const result = await run(db);
  assert.equal(result.handled, true);
  const row = db._readRow('form_submission', 'sub1');
  assert.equal(row.payment_meta.monthly_card_state.status, 'done');
  // A new owner_token was minted for the reclaim (not the dead worker's).
  // (The done stamp drops owner_token, so assert via history existence + done.)
  assert.equal((db.tables.member_membership_history || []).length, 1);
  assert.equal(db.tables.member_membership_history[0].billing_period, 'monthly_card');
});

// ===========================================================================
// Tests: pipeline unresolved member → release + retry
// ===========================================================================

test('unresolved member removes the lease key so a later call can retry', async () => {
  const db = happyFake({ created_member_id: null }); // no member ever resolves
  const result = await run(db);
  assert.equal(result.handled, false);
  assert.equal(result.retryable, true);
  assert.match(result.detail, /member not yet resolved/);
  // Lease released (key deleted, not left as processing or stored null), no history.
  assertLeaseReleased(db);
  assert.equal((db.tables.member_membership_history || []).length, 0);
});

test('second call after release reruns and succeeds once member resolves', async () => {
  const db = happyFake({ created_member_id: null });
  const first = await run(db);
  assert.equal(first.retryable, true);

  // Member becomes resolved (e.g. admin re-ran / pipeline succeeded elsewhere).
  db._readRow('form_submission', 'sub1').created_member_id = 'mem1';

  const second = await run(db);
  assert.equal(second.handled, true);
  assert.equal(db._readRow('form_submission', 'sub1').payment_meta.monthly_card_state.status, 'done');
  assert.equal((db.tables.member_membership_history || []).length, 1);
});

// ===========================================================================
// Tests: done stamp only after history; emails after history
// ===========================================================================

test('done stamp is written AFTER history insert', async () => {
  const order = [];
  const db = makeSupabase({
    tables: {
      form_submission: [makeSub({ created_member_id: 'mem1' })],
      form: [FORM],
      membership_billing_agreements: [AGREEMENT],
      member_membership_history: [],
    },
    uniqueIndex: { member_membership_history: ['billing_agreement_id'] },
    hooks: {
      onInsert: (table) => { if (table === 'member_membership_history') order.push('history'); },
      onUpdate: (table, ctx) => {
        if (table === 'form_submission' && ctx.payload?.payment_meta?.monthly_card_state?.status === 'done') {
          order.push('done');
        }
      },
    },
  });
  const result = await run(db);
  assert.equal(result.handled, true);
  const hIdx = order.indexOf('history');
  const dIdx = order.indexOf('done');
  assert.ok(hIdx >= 0, 'history must be inserted');
  assert.ok(dIdx >= 0, 'done must be stamped');
  assert.ok(hIdx < dIdx, 'done stamp must come after history insert');
});

test('sendSubmissionEmailsGuarded is called after the membership claim (source order)', () => {
  const finalizeSrc = src('./formMonthlyCardFinalize.js');
  const emailCallPos = finalizeSrc.indexOf('sendSubmissionEmailsGuarded(');
  const claimPos = finalizeSrc.indexOf('claimFormMonthlyCardMembership(');
  assert.ok(emailCallPos > -1, 'sendSubmissionEmailsGuarded must be called');
  assert.ok(claimPos > -1, 'membership claim RPC must be invoked');
  assert.ok(claimPos < emailCallPos, 'email send must come after the membership claim');
});

// ===========================================================================
// Tests: history idempotency + errors
// ===========================================================================

test('existing history row for the agreement is adopted by the RPC (idempotent re-entry)', async () => {
  const db = happyFake();
  db.tables.member_membership_history.push({
    id: 'h-existing',
    tenant_id: 'ten1',
    member_id: 'mem1',
    membership_year: '2026/27',
    billing_agreement_id: 'ag1',
    billing_period: 'monthly_card',
  });
  const result = await run(db);
  assert.equal(result.handled, true);
  assert.match(result.detail, /h-existing/);
  // No duplicate inserted — the RPC adopted the existing row.
  assert.equal(db.tables.member_membership_history.length, 1);
  assert.equal(db._readRow('form_submission', 'sub1').payment_meta.monthly_card_state.status, 'done');
});

test('RPC idempotent adoption path drives to done without a second history row', async () => {
  // The RPC reports { ok:true, idempotent:true } for an already-attached
  // agreement. Model that directly via the rpc.result override and assert the
  // finalizer treats it as success (attaches nothing extra, stamps done).
  const db = happyFake({}, {
    rpc: { result: { ok: true, idempotent: true, history_id: 'h-prior' } },
  });
  const result = await run(db);
  assert.equal(result.handled, true);
  assert.match(result.detail, /h-prior/);
  assert.equal(db._readRow('form_submission', 'sub1').payment_meta.monthly_card_state.status, 'done');
  // rpc.result bypasses the modelled insert, so no history rows were created.
  assert.equal((db.tables.member_membership_history || []).length, 0);
});

test('RPC transport error → retryable, lease key removed, no side effects', async () => {
  const db = happyFake({}, {
    rpc: { error: { message: 'deadlock detected' } },
  });
  const result = await run(db);
  assert.equal(result.handled, false);
  assert.equal(result.retryable, true);
  assert.match(result.detail, /membership-year claim failed/);
  // Lease released (key deleted) so a later call retries; nothing attached, nothing inserted.
  assertLeaseReleased(db);
  assert.equal(db._readRow('membership_billing_agreements', 'ag1').member_id, null);
  assert.equal((db.tables.member_membership_history || []).length, 0);
});

test('RPC non-conflict failure (e.g. INVALID_AGREEMENT) → retryable, lease released', async () => {
  const db = happyFake({}, {
    rpc: { result: { ok: false, conflict: false, code: 'INVALID_AGREEMENT', detail: 'The billing agreement does not match this form submission' } },
  });
  const result = await run(db);
  assert.equal(result.handled, false);
  assert.equal(result.retryable, true);
  assert.equal(result.conflict, undefined);
  assertLeaseReleased(db);
  assert.equal((db.tables.member_membership_history || []).length, 0);
});

test('RPC attaches the member atomically as part of a successful claim', async () => {
  const db = happyFake({ created_member_id: 'mem1' });
  assert.equal(db._readRow('membership_billing_agreements', 'ag1').member_id, null);
  const result = await run(db);
  assert.equal(result.handled, true);
  // The RPC (not a separate finalizer update) attached the member.
  assert.equal(db._readRow('membership_billing_agreements', 'ag1').member_id, 'mem1');
  assert.equal(db.tables.member_membership_history.length, 1);
  assert.equal(db.tables.member_membership_history[0].billing_agreement_id, 'ag1');
});

test('missing snapshot on agreement → retryable, lease released', async () => {
  const db = happyFake();
  const agreementNoSnapshot = { ...AGREEMENT, metadata: { form_submission_id: 'sub1' } };
  db.tables.membership_billing_agreements[0] = { ...agreementNoSnapshot };
  const result = await finalizeFormMonthlyCardCheckout({
    db, agreement: agreementNoSnapshot, session: { metadata: {} }, baseUrl: '',
  });
  assert.equal(result.retryable, true);
  assert.match(result.detail, /no monthly-card snapshot/);
  assertLeaseReleased(db);
});

// ===========================================================================
// Tests: durable membership conflicts (RPC returns conflict:true)
// ===========================================================================
//
// A conflict is NOT retryable: the applicant already has this membership year
// (or an open agreement for it), so the finalizer must persist a durable
// 'conflict' state, insert NO duplicate history, send NO emails, and NEVER
// stamp done. The Stripe subscription is later cancelled / refunded upstream.

function assertConflictSideEffects(db, { historyCountBefore = 0 } = {}) {
  const state = db._readRow('form_submission', 'sub1').payment_meta.monthly_card_state;
  assert.equal(state.status, 'conflict', 'must persist a durable conflict state');
  assert.notEqual(state.status, 'done');
  // Durable conflict carries the code + member for later cancellation/refund.
  assert.ok(state.code, 'conflict state must carry a code');
  assert.ok(state.detail, 'conflict state must carry a human detail');
  // Processing note explains the automatic cancellation/refund.
  assert.match(
    db._readRow('form_submission', 'sub1').processing_notes || '',
    /cancelled|refund/i,
    'conflict must leave an explanatory processing note',
  );
  // No duplicate history created by the finalizer beyond any pre-seed.
  assert.equal((db.tables.member_membership_history || []).length, historyCountBefore,
    'conflict must not create a membership history row');
}

test('existing-year conflict → durable conflict state, no history, no emails, no done', async () => {
  // Seed an existing history row for the SAME member + year but a DIFFERENT
  // (already-completed) agreement. The RPC must report MEMBERSHIP_YEAR_EXISTS.
  const db = happyFake({ created_member_id: 'mem1' });
  db.tables.member_membership_history.push({
    id: 'h-prior-year',
    tenant_id: 'ten1',
    member_id: 'mem1',
    membership_year: '2026/27',
    billing_agreement_id: 'ag-other',
    billing_period: 'monthly_card',
  });
  const historyCountBefore = db.tables.member_membership_history.length;

  const result = await run(db);

  assert.equal(result.handled, false);
  assert.equal(result.conflict, true);
  assert.equal(result.retryable, false);
  assert.equal(result.code, 'MEMBERSHIP_YEAR_EXISTS');
  assert.equal(result.memberId, 'mem1');
  assertConflictSideEffects(db, { historyCountBefore });
  // The conflicting agreement must NOT have had this member attached to it,
  // and no email/done side effects happened (log has no email trigger op).
  assert.equal(db._readRow('membership_billing_agreements', 'ag1').member_id, null);
});

test('open-DD conflict → durable conflict state, no history, no emails, no done', async () => {
  // Another OPEN agreement (e.g. a Direct Debit) already exists for this
  // member + year. The RPC must report OPEN_MEMBERSHIP_AGREEMENT_EXISTS.
  const db = happyFake({ created_member_id: 'mem1' });
  db.tables.membership_billing_agreements.push({
    id: 'ag-dd',
    tenant_id: 'ten1',
    provider: 'gocardless',
    agreement_type: 'member',
    member_id: 'mem1',
    status: 'active',
    metadata: { dd: { membership_year: '2026/27' } },
  });
  const historyCountBefore = db.tables.member_membership_history.length; // 0

  const result = await run(db);

  assert.equal(result.handled, false);
  assert.equal(result.conflict, true);
  assert.equal(result.retryable, false);
  assert.equal(result.code, 'OPEN_MEMBERSHIP_AGREEMENT_EXISTS');
  assertConflictSideEffects(db, { historyCountBefore });
  // Our card agreement must not get the member attached when a conflict wins.
  assert.equal(db._readRow('membership_billing_agreements', 'ag1').member_id, null);
});

test('a persisted conflict state short-circuits later calls (no re-processing)', async () => {
  // Re-entry after a durable conflict: the finalizer must return the conflict
  // immediately from the stored state without re-running the pipeline/RPC.
  const db = happyFake({
    created_member_id: 'mem1',
    payment_meta: {
      monthly_card: { agreement_id: 'ag1' },
      monthly_card_state: {
        status: 'conflict',
        code: 'MEMBERSHIP_YEAR_EXISTS',
        detail: 'Membership for this year is already recorded',
        member_id: 'mem1',
        detected_at: new Date().toISOString(),
      },
    },
  });
  const result = await run(db);
  assert.equal(result.handled, false);
  assert.equal(result.conflict, true);
  assert.equal(result.retryable, false);
  assert.equal(result.code, 'MEMBERSHIP_YEAR_EXISTS');
  // No RPC call, no lease write, no history.
  assert.equal(db.log.filter((l) => l.op === 'rpc' && l.name).length, 0, 'must not call the RPC again');
  assert.equal(db.log.filter((l) => l.op === 'update' && l.table === 'form_submission').length, 0, 'must not write the lease again');
  assert.equal((db.tables.member_membership_history || []).length, 0);
});

test('conflict state that cannot be saved (lost lease) → retryable', async () => {
  // The RPC reports a conflict but the owner-token CAS for the conflict write
  // fails (a newer worker stole the lease between the RPC returning the
  // conflict and writeConflictState reading state). The finalizer must fall
  // back to retryable rather than dropping the conflict silently.
  let rpcReturned = false; // only steal AFTER the RPC has run
  let stolen = false;
  const db = happyFake({ created_member_id: 'mem1' }, {
    rpc: { onCall: () => { rpcReturned = true; } },
  });
  db.tables.member_membership_history.push({
    id: 'h-prior-year',
    tenant_id: 'ten1',
    member_id: 'mem1',
    membership_year: '2026/27',
    billing_agreement_id: 'ag-other',
    billing_period: 'monthly_card',
  });

  // Steal the lease on the first form_submission read AFTER the RPC (that read
  // is writeConflictState's readClaimState). Stealing earlier would trip the
  // post-pipeline renewal guard instead of the conflict-save guard.
  const origFrom = db.from.bind(db);
  db.from = (table) => {
    const chain = origFrom(table);
    if (table === 'form_submission') {
      const realSelect = chain.select.bind(chain);
      chain.select = (...a) => {
        const c = realSelect(...a);
        const realMaybe = c.maybeSingle.bind(c);
        c.maybeSingle = async () => {
          const row = db._readRow('form_submission', 'sub1');
          if (rpcReturned && !stolen && row?.payment_meta?.monthly_card_state?.status === 'processing') {
            row.payment_meta.monthly_card_state.owner_token = 'thief';
            stolen = true;
          }
          return realMaybe();
        };
        return c;
      };
    }
    return chain;
  };

  const result = await run(db);
  assert.equal(result.handled, false);
  assert.equal(result.retryable, true);
  assert.match(result.detail, /conflict detected but could not be saved/);
});

// ===========================================================================
// Owner-token lease invariants (architect-requested)
// ===========================================================================
//
// These directly exercise the CAS guards in writeClaimResult / renewClaimLease
// via finalizeFormMonthlyCardCheckout. We simulate a "newer worker" by mutating
// the persisted owner_token mid-flight (between the pipeline call and the
// post-pipeline renewal / the terminal stamp).

test('(a) old worker cannot release a newer reclaimed lease', async () => {
  // The old worker will be forced down the "unresolved member" branch, which
  // attempts to RELEASE (set state=null). But a newer worker reclaimed the
  // lease (new owner_token) after the old worker's claim. The release must be
  // rejected by the owner-token CAS, leaving the newer lease intact.
  const db = happyFake({ created_member_id: null }); // triggers release attempt

  // Intercept the post-pipeline renewal read: after the old worker's pipeline
  // runs, a newer worker reclaims by overwriting owner_token + claimed_at.
  // We hook onSelect for form_submission reading payment_status/payment_meta
  // (the readClaimState just before renew / release) and, once we've seen the
  // old worker's own claim land, swap in a newer owner.
  let oldOwnerToken = null;
  let swapped = false;
  const origFrom = db.from.bind(db);
  db.from = (table) => {
    const chain = origFrom(table);
    if (table === 'form_submission') {
      const realUpdate = chain.update.bind(chain);
      chain.update = (p) => {
        // Capture the old worker's claim token the first time it stamps processing.
        const tok = p?.payment_meta?.monthly_card_state?.owner_token;
        if (tok && p.payment_meta.monthly_card_state.status === 'processing' && !oldOwnerToken) {
          oldOwnerToken = tok;
        }
        return realUpdate(p);
      };
      const realSelect = chain.select.bind(chain);
      chain.select = (...a) => {
        const c = realSelect(...a);
        const realMaybe = c.maybeSingle.bind(c);
        c.maybeSingle = async () => {
          // Before the old worker reads state to renew/release, a newer worker
          // reclaims: overwrite persisted owner_token.
          if (oldOwnerToken && !swapped) {
            const row = db._readRow('form_submission', 'sub1');
            if (row?.payment_meta?.monthly_card_state?.owner_token === oldOwnerToken) {
              row.payment_meta.monthly_card_state = {
                status: 'processing',
                claimed_at: new Date().toISOString(),
                owner_token: 'newer-worker',
              };
              swapped = true;
            }
          }
          return realMaybe();
        };
        return c;
      };
    }
    return chain;
  };

  const result = await run(db);
  // Old worker lost ownership → retryable, and did NOT null-out the lease.
  assert.equal(result.retryable, true);
  const state = db._readRow('form_submission', 'sub1').payment_meta.monthly_card_state;
  assert.ok(state, 'newer lease must NOT have been released to null by the old worker');
  assert.equal(state.owner_token, 'newer-worker', 'newer worker still owns the lease');
  assert.equal(state.status, 'processing');
});

test('(b) old worker cannot stamp done over a newer lease', async () => {
  // Old worker completes the membership claim (RPC), then tries to stamp done.
  // But a newer worker reclaimed the lease just before the terminal stamp. The
  // owner-token CAS must reject the done stamp, so the lease stays processing
  // under the newer owner (NOT flipped to done by the old worker).
  let oldOwnerToken = null;
  let swapped = false;
  let seenHistory = false;
  // The claim now happens inside the RPC; mark history-written when it runs.
  const db = happyFake({ created_member_id: 'mem1' }, {
    rpc: { onCall: () => { seenHistory = true; } },
  });

  const origFrom = db.from.bind(db);
  db.from = (table) => {
    const chain = origFrom(table);
    if (table === 'form_submission') {
      const realUpdate = chain.update.bind(chain);
      chain.update = (p) => {
        const st = p?.payment_meta?.monthly_card_state;
        if (st?.status === 'processing' && st.owner_token && !oldOwnerToken) {
          oldOwnerToken = st.owner_token;
        }
        return realUpdate(p);
      };
      const realSelect = chain.select.bind(chain);
      chain.select = (...a) => {
        const c = realSelect(...a);
        const realMaybe = c.maybeSingle.bind(c);
        c.maybeSingle = async () => {
          // Only reclaim AFTER history has been written (i.e. right before the
          // terminal done stamp's readClaimState).
          if (seenHistory && oldOwnerToken && !swapped) {
            const row = db._readRow('form_submission', 'sub1');
            if (row?.payment_meta?.monthly_card_state?.owner_token === oldOwnerToken) {
              row.payment_meta.monthly_card_state = {
                status: 'processing',
                claimed_at: new Date().toISOString(),
                owner_token: 'newer-worker',
              };
              swapped = true;
            }
          }
          return realMaybe();
        };
        return c;
      };
    }
    return chain;
  };

  const result = await run(db);
  // History was created but the done stamp was rejected → retryable.
  assert.equal(result.handled, false);
  assert.equal(result.retryable, true);
  const state = db._readRow('form_submission', 'sub1').payment_meta.monthly_card_state;
  assert.notEqual(state?.status, 'done', 'old worker must NOT stamp done over newer lease');
  assert.equal(state.owner_token, 'newer-worker', 'newer lease remains intact');
  // History row still exists (idempotent for the newer worker to adopt).
  assert.equal(db.tables.member_membership_history.length, 1);
});

test('(c) lease renewal is owner-CAS guarded: only the active owner renews', async () => {
  // Direct exercise of the renewal guard. The happy path renews the lease
  // immediately after the pipeline; if a different owner holds the lease at
  // that point, the renewal fails and finalization aborts as retryable.
  const db = happyFake({ created_member_id: 'mem1' });

  let oldOwnerToken = null;
  let swapped = false;
  const origFrom = db.from.bind(db);
  db.from = (table) => {
    const chain = origFrom(table);
    if (table === 'form_submission') {
      const realUpdate = chain.update.bind(chain);
      chain.update = (p) => {
        const st = p?.payment_meta?.monthly_card_state;
        if (st?.status === 'processing' && st.owner_token && !oldOwnerToken) oldOwnerToken = st.owner_token;
        return realUpdate(p);
      };
      const realSelect = chain.select.bind(chain);
      chain.select = (...a) => {
        const c = realSelect(...a);
        const realMaybe = c.maybeSingle.bind(c);
        c.maybeSingle = async () => {
          // Steal the lease before the post-pipeline renewal reads state.
          if (oldOwnerToken && !swapped) {
            const row = db._readRow('form_submission', 'sub1');
            if (row?.payment_meta?.monthly_card_state?.owner_token === oldOwnerToken) {
              row.payment_meta.monthly_card_state = {
                status: 'processing',
                claimed_at: new Date().toISOString(),
                owner_token: 'someone-else',
              };
              swapped = true;
            }
          }
          return realMaybe();
        };
        return c;
      };
    }
    return chain;
  };

  const result = await run(db);
  assert.equal(result.handled, false);
  assert.equal(result.retryable, true);
  assert.match(result.detail, /lease ownership was lost/);
  // The other owner's lease is untouched.
  assert.equal(db._readRow('form_submission', 'sub1').payment_meta.monthly_card_state.owner_token, 'someone-else');
});

test('(c2) active owner renewal succeeds and finalization completes normally', async () => {
  // No interference: the same owner holds the lease throughout, renewal
  // succeeds, and the row reaches done. This is the positive control for the
  // owner-CAS renewal guard.
  const db = happyFake({ created_member_id: 'mem1' });
  const result = await run(db);
  assert.equal(result.handled, true);
  assert.equal(db._readRow('form_submission', 'sub1').payment_meta.monthly_card_state.status, 'done');
});

// ===========================================================================
// Tests: helper predicates
// ===========================================================================

test('isFormMonthlyCardFinalized: only true for setup_complete + done state', () => {
  assert.equal(isFormMonthlyCardFinalized(null), false);
  assert.equal(isFormMonthlyCardFinalized({ payment_status: 'pending', payment_meta: {} }), false);
  assert.equal(isFormMonthlyCardFinalized({ payment_status: 'setup_complete', payment_meta: {} }), false);
  assert.equal(isFormMonthlyCardFinalized({
    payment_status: 'setup_complete',
    payment_meta: { monthly_card_state: { status: 'processing' } },
  }), false);
  assert.equal(isFormMonthlyCardFinalized({
    payment_status: 'setup_complete',
    payment_meta: { monthly_card_state: { status: 'done' } },
  }), true);
  assert.equal(isFormMonthlyCardFinalized({
    payment_status: 'setup_complete',
    payment_meta: { monthly_card_finalized: true },
  }), false);
});

test('isFormMonthlyCardProcessing: true only for fresh lease within TTL', () => {
  const fresh = { status: 'processing', claimed_at: new Date().toISOString(), owner_token: 't' };
  const stale = { status: 'processing', claimed_at: new Date(Date.now() - FINALIZE_CLAIM_TTL_MS - 1000).toISOString(), owner_token: 't' };
  assert.equal(isFormMonthlyCardProcessing(null), false);
  assert.equal(isFormMonthlyCardProcessing({
    payment_status: 'setup_complete', payment_meta: { monthly_card_state: fresh },
  }), true);
  assert.equal(isFormMonthlyCardProcessing({
    payment_status: 'setup_complete', payment_meta: { monthly_card_state: stale },
  }), false);
  assert.equal(isFormMonthlyCardProcessing({
    payment_status: 'setup_complete', payment_meta: { monthly_card_state: { status: 'done' } },
  }), false);
});

// ===========================================================================
// Source-contract: stripeMonthlyCard.js wiring
// ===========================================================================

test('src: stripeMonthlyCard.js calls finalizeFormMonthlyCardCheckout before ensureCardPlanForCheckout', () => {
  const cardSrc = src('./stripeMonthlyCard.js');
  assert.match(cardSrc, /import.*finalizeFormMonthlyCardCheckout.*from.*formMonthlyCardFinalize/);
  const checkoutBlock = cardSrc.slice(cardSrc.indexOf("if (type === 'checkout.session.completed')"));
  const finalizeIdx = checkoutBlock.indexOf('finalizeFormMonthlyCardCheckout(');
  const ensureIdx = checkoutBlock.indexOf('ensureCardPlanForCheckout(');
  assert.ok(finalizeIdx > -1, 'finalizeFormMonthlyCardCheckout must be called');
  assert.ok(ensureIdx > -1, 'ensureCardPlanForCheckout must still be called');
  assert.ok(finalizeIdx < ensureIdx, 'finalizeFormMonthlyCardCheckout must come BEFORE ensureCardPlanForCheckout');
});

test('src: stripeMonthlyCard.js keeps every incomplete form finalize retryable', () => {
  const cardSrc = src('./stripeMonthlyCard.js');
  const formBlock = cardSrc.slice(cardSrc.indexOf('const isFormCheckout'), cardSrc.indexOf('const ensured'));
  assert.match(formBlock, /if \(!formResult\.handled\)/);
  assert.match(formBlock, /retryable: true.*form checkout not yet finalizable/s);
});

test('src: stripeMonthlyCard.js refreshes agreement after form finalize', () => {
  const cardSrc = src('./stripeMonthlyCard.js');
  const block = cardSrc.slice(cardSrc.indexOf('isFormCheckout'));
  assert.match(block, /findCardAgreementById.*agreement\.id/);
});

// ===========================================================================
// Source-contract: reconcile-stripe-card-plans.js baseUrl wiring
// ===========================================================================

test('src: reconcile cron resolves per-tenant baseUrl and passes it to replayEvent', () => {
  const cronSrc = src('../cron/reconcile-stripe-card-plans.js');
  assert.match(cronSrc, /getTrustedBaseUrlForTenant/);
  assert.match(cronSrc, /baseUrlFor\(tenantId\)/);
  assert.match(cronSrc, /baseUrl.*await baseUrlFor/);
  assert.doesNotMatch(
    cronSrc.slice(cronSrc.indexOf('async function replayEvent')),
    /baseUrl: ''/,
    'replayEvent must not hard-code empty string baseUrl',
  );
  assert.match(cronSrc, /baseUrlCache\.clear\(\)/);
});

// ===========================================================================
// Source-contract: fourth sweep in formPaymentReconciliation.js
// ===========================================================================

test('src: fourth sweep selects absent-state AND stale-processing rows', () => {
  const reconSrc = src('./formPaymentReconciliation.js');
  assert.match(reconSrc, /Fourth sweep.*Task #3680/s);
  assert.match(reconSrc, /payment_provider.*stripe_monthly_card/);
  assert.match(reconSrc, /payment_status.*setup_complete/);
  assert.match(reconSrc, /monthly_card_state\.is\.null/);
  assert.match(reconSrc, /monthly_card_state->>status\.eq\.processing/);
  assert.match(reconSrc, /monthly_card_state->>claimed_at\.lt\./);
  assert.match(reconSrc, /FINALIZE_CLAIM_TTL_MS/);
  assert.match(reconSrc, /finalizeFormMonthlyCardCheckout/);
  assert.match(reconSrc, /import.*finalizeFormMonthlyCardCheckout.*from.*formMonthlyCardFinalize/);
  assert.match(reconSrc, /import.*FINALIZE_CLAIM_TTL_MS.*from.*formMonthlyCardFinalize/);
});

test('src: fourth sweep is not bounded by the payment lookback', () => {
  const reconSrc = src('./formPaymentReconciliation.js');
  const fourthAt = reconSrc.indexOf('Fourth sweep (Task #3680)');
  assert.ok(fourthAt > -1);
  const fourthBlock = reconSrc.slice(fourthAt, reconSrc.indexOf('return results', fourthAt));
  assert.ok(!/gte\('created_date'/.test(fourthBlock), 'fourth sweep must not apply the payment lookback cutoff');
});

// ===========================================================================
// Source-contract: formMonthlyCardFinalize.js state-machine + owner-token
// ===========================================================================

test('src: formMonthlyCardFinalize.js uses processing/done state machine, not a boolean stamp', () => {
  const finalizeSrc = src('./formMonthlyCardFinalize.js');
  assert.match(finalizeSrc, /status.*processing/, 'must use processing status');
  assert.match(finalizeSrc, /status.*done/, 'must use done status');
  assert.match(finalizeSrc, /claimed_at/, 'must record claim timestamp for TTL recovery');
  assert.match(finalizeSrc, /FINALIZE_CLAIM_TTL_MS/, 'must reference TTL constant');
  assert.doesNotMatch(finalizeSrc, /monthly_card_finalized.*true.*return.*alreadyFinalized/s,
    'must not use old boolean monthly_card_finalized as terminal guard');
});

test('src: formMonthlyCardFinalize.js uses an owner-token CAS on every lease write', () => {
  const finalizeSrc = src('./formMonthlyCardFinalize.js');
  // Every claim mints an owner token.
  assert.match(finalizeSrc, /owner_token/, 'must stamp an owner_token into the lease');
  assert.match(finalizeSrc, /randomUUID\(\)/, 'owner token must be a random UUID');
  // Release / done stamp is guarded by an owner-token filter.
  assert.match(finalizeSrc, /payment_meta->monthly_card_state->>owner_token['"],\s*['"]eq['"]/,
    'lease writes must filter on owner_token eq');
  // The terminal writer requires the caller to pass its ownerToken.
  assert.match(finalizeSrc, /writeClaimResult\([^)]*ownerToken/s, 'writeClaimResult must receive ownerToken');
  // There is a dedicated renewal helper that is owner-CAS guarded.
  assert.match(finalizeSrc, /renewClaimLease/, 'must have a renewClaimLease helper');
});

test('src: formMonthlyCardFinalize.js renews the lease after the pipeline and aborts if ownership lost', () => {
  const finalizeSrc = src('./formMonthlyCardFinalize.js');
  assert.match(finalizeSrc, /stillOwnsLease/, 'must re-check ownership after the pipeline');
  assert.match(finalizeSrc, /lease ownership was lost/, 'must abort retryably when ownership is lost');
});

test('src: writeClaimResult and renewClaimLease reject when the token does not match', () => {
  const finalizeSrc = src('./formMonthlyCardFinalize.js');
  // Guard clauses that compare the persisted owner_token to the caller token.
  assert.match(finalizeSrc, /state\.owner_token\s*!==\s*ownerToken/,
    'must reject stale/foreign owner tokens before writing');
});

test('src: formMonthlyCardFinalize.js never creates annual invoice or fires paid workflow', () => {
  const finalizeSrc = src('./formMonthlyCardFinalize.js');
  assert.doesNotMatch(finalizeSrc, /createMembershipInvoice/);
  assert.doesNotMatch(finalizeSrc, /fireWorkflowForPaidRow/);
  assert.doesNotMatch(finalizeSrc, /billing_period.*annual/);
  assert.match(finalizeSrc, /billing_period.*monthly_card/);
  assert.match(finalizeSrc, /payment_method.*card_monthly/);
  assert.match(finalizeSrc, /payment_status.*unpaid/);
  assert.match(finalizeSrc, /status.*pending_payment_setup/);
});

test('src: formMonthlyCardFinalize.js imports and calls sendSubmissionEmailsGuarded', () => {
  const finalizeSrc = src('./formMonthlyCardFinalize.js');
  assert.match(finalizeSrc, /import.*sendSubmissionEmailsGuarded.*from.*formSubmissionEmails/);
  assert.match(finalizeSrc, /sendSubmissionEmailsGuarded\(/);
});

test('src: formMonthlyCardFinalize.js uses full FORM_COLUMNS including email columns', () => {
  const finalizeSrc = src('./formMonthlyCardFinalize.js');
  assert.match(finalizeSrc, /submission_emails/);
  assert.match(finalizeSrc, /submission_email_template_id/);
});

test('src: formMonthlyCardFinalize.js delegates attach+history to the RPC, not direct writes', () => {
  const finalizeSrc = src('./formMonthlyCardFinalize.js');
  // Uses the shared RPC wrapper for the atomic attach + history claim.
  assert.match(finalizeSrc, /import.*claimFormMonthlyCardMembership.*from.*formMonthlyCardCheckout/);
  assert.match(finalizeSrc, /claimFormMonthlyCardMembership\(/);
  // The obsolete direct paths must be gone: no manual history insert and no
  // manual member_id attach update inside the finalizer.
  assert.doesNotMatch(finalizeSrc, /\.insert\(historyInsert\)/,
    'finalizer must not insert history directly (moved into the RPC)');
  assert.doesNotMatch(finalizeSrc, /from\('member_membership_history'\)/,
    'finalizer must not touch member_membership_history directly');
  assert.doesNotMatch(finalizeSrc, /\.update\(\{\s*member_id/,
    'finalizer must not attach member_id via a direct update (moved into the RPC)');
});

test('src: formMonthlyCardCheckout.js RPC wrapper surfaces conflicts and retryable failures', () => {
  const checkoutSrc = src('./formMonthlyCardCheckout.js');
  assert.match(checkoutSrc, /rpc\('claim_form_monthly_card_membership'/);
  // Transport error → retryable.
  assert.match(checkoutSrc, /retryable:\s*true/);
  // Conflict flag is propagated from the RPC payload.
  assert.match(checkoutSrc, /conflict:\s*data\?\.conflict\s*===\s*true/);
});

test('src: formMonthlyCardFinalize.js persists a durable conflict state and returns it non-retryable', () => {
  const finalizeSrc = src('./formMonthlyCardFinalize.js');
  // A durable conflict status is written and short-circuited on re-entry.
  assert.match(finalizeSrc, /status:\s*'conflict'/);
  assert.match(finalizeSrc, /writeConflictState/);
  assert.match(finalizeSrc, /currentState\?\.status === 'conflict'/,
    'must short-circuit when a conflict is already recorded');
  // A detected conflict is explicitly non-retryable.
  assert.match(finalizeSrc, /conflict:\s*true[\s\S]*?retryable:\s*false/,
    'conflict result must be non-retryable');
  // Conflict + email/done must not both happen: the conflict branch returns
  // before the email send and the done stamp.
  const conflictPos = finalizeSrc.indexOf('claim.conflict');
  const emailPos = finalizeSrc.indexOf('sendSubmissionEmailsGuarded(');
  const donePos = finalizeSrc.indexOf("writeClaimResult(db, formSubmissionId, { done: true");
  assert.ok(conflictPos > -1 && emailPos > -1 && donePos > -1);
  assert.ok(conflictPos < emailPos && conflictPos < donePos,
    'conflict handling must precede (and short-circuit before) emails and done stamp');
});

// ===========================================================================
// Source-contract: webhook retryable propagation
// ===========================================================================

test('src: stripe-membership webhook leaves form checkout event pending when retryable', () => {
  const webhookSrc = src('../webhooks/stripe-membership.js');
  assert.match(webhookSrc, /outcome\.retryable/);
  assert.match(webhookSrc, /leaving pending for retry/);
});

// ===========================================================================
// Migration: unique partial index exists
// ===========================================================================

test('migration: unique partial index on member_membership_history.billing_agreement_id exists', () => {
  const migSrc = src('../../supabase/migrations/20260819_member_membership_history_billing_agreement_unique.sql');
  assert.match(migSrc, /CREATE UNIQUE INDEX IF NOT EXISTS/);
  assert.match(migSrc, /member_membership_history/);
  assert.match(migSrc, /billing_agreement_id/);
  assert.match(migSrc, /WHERE billing_agreement_id IS NOT NULL/);
  assert.match(migSrc, /IF NOT EXISTS/);
  assert.ok(migSrc.length > 0, 'migration file must be non-empty');
});
