#!/usr/bin/env node
// Synthetic fixtures only; never an importer or a payment/renewal runner.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { destinationConnection } from './run-bnms-dd-pilot-history.mjs';
import { buildRollingCommitment, loadCurrentRollingCommitment } from '../api/_lib/rollingMembershipCommitment.js';
import { classifyAnnualRenewal } from '../api/_lib/annualRenewalPolicy.js';
import { assessFormMembershipRenewalEvidence } from '../api/_lib/formMembershipRenewalEvidence.js';
import { createMembershipConfigResolver } from '../api/_lib/membershipConfigResolverCore.js';
import { createClient } from '@supabase/supabase-js';

export const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
const FIELD = '87f120ff-92e6-4d52-944b-9ba9d7b1fac0';
const SOURCE = 'bnms_synthetic_renewal_fixture_2026_10_05';
export const CLASSES = ['Full', 'Full junior', 'Trainee', 'Student', 'Associate'];
const DAYS = [10, 20, 30, 45, 60];
const COSTS = [156, 128, 61, 0, 71];
const stable = value => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
export const hash = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
export const safetySignature = evidence => hash(Object.fromEntries(Object.entries(evidence)
  .map(([key, values]) => [key, [...values].sort((a,b) => hash(a).localeCompare(hash(b)))])));
export function fixtureId(label) {
  const h = hash(`${TENANT}:${SOURCE}:${label}`);
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
const day = (date, offset) => new Date(Date.parse(`${date}T00:00:00Z`) + offset * 86400000).toISOString().slice(0,10);

export function buildManifest(configs, asOf) {
  assert.equal(asOf, '2026-10-05', 'This approved fixture batch is date-pinned');
  const fixtures = CLASSES.map((memberClass, index) => {
    const matches = configs.filter(c => c.structure_match_value === memberClass && c.effective_to === null);
    assert.equal(matches.length, 1, `Ambiguous schedule: ${memberClass}`);
    const config = matches[0];
    assert.equal(config.tenant_id, TENANT);
    assert.equal(config.structure_field_id, FIELD);
    assert.equal(config.structure_scope_type, 'member');
    assert.equal(config.start_mode, 'immediate');
    assert.equal(config.billing_period, 'annual');
    assert.equal(config.pricing_model, 'flat');
    assert.equal(config.flat_cost, COSTS[index]);
    assert.equal(config.flat_vat_rate, null);
    assert.equal(config.currency, 'GBP');
    assert.equal(config.is_active, true);
    assert.equal(config.renewal_open_days, 90);
    assert.equal(config.renewal_grace_days, 90);
    const renewal = day(asOf, DAYS[index]);
    assert.ok(config.effective_from <= asOf && config.effective_from <= renewal);
    const start = `2025${renewal.slice(4)}`;
    const label = memberClass.replaceAll(' ', '_');
    const id = fixtureId(`member:${memberClass}`);
    const provenance = {
      source: SOURCE, synthetic: true,
      purpose: 'Renewal testing only; not a genuine member or financial transaction.',
      term_authority: 'User-approved counterfactual 2025 term using current configuration snapshot.',
      payment_authority: 'Synthetic paid fixture state only; NO provider settlement or customer consent.',
    };
    const amounts = { annual_cost: COSTS[index], final_cost: COSTS[index], vat_amount: 0,
      total_with_vat: COSTS[index], currency: 'GBP' };
    const commitment = buildRollingCommitment({ config, startDate: start,
      paymentMethod: 'manual', paymentFrequency: 'upfront', amounts,
      pricingSnapshot: { tier_label: 'Flat Rate', ...provenance } });
    return {
      memberClass,
      member: { id, tenant_id: TENANT, first_name: 'TEST_Renewal', last_name: `TEST_${label}`,
        email: `bnms-renewal-20261005-${index + 1}@example.invalid`, biography: JSON.stringify(provenance),
        status: 'active', role_id: null, organization_id: null, login_enabled: false,
        show_in_directory: false, is_sample: true, communications_opted_out_all: true,
        membership_paused: false },
      preference: { id: fixtureId(`preference:${memberClass}`), member_id: id, field_id: FIELD, value: memberClass },
      history: { id: fixtureId(`history:${memberClass}`), tenant_id: TENANT, member_id: id,
        membership_year: commitment.term_key, config_id: config.id, tier_label: 'Flat Rate',
        ...amounts, prorata_cost: COSTS[index], free_period_discount: 0, rollover_discount: 0,
        custom_discount_total: 0, vat_rate_percent: null, billing_period: 'annual', payment_method: 'manual',
        payment_status: 'paid', paid_at: null, status: 'active', annual_renewal_state: 'open',
        notes: JSON.stringify(provenance), ...commitment },
    };
  });
  return { version: 1, source: SOURCE, tenantId: TENANT, asOf, fixtures };
}

async function rows(c, sql, params = []) {
  return (await c.query(sql, params)).rows;
}
async function prerequisites(c) {
  assert.deepEqual(await rows(c, 'select id,slug from tenant where id=$1', [TENANT]), [{id: TENANT, slug: 'bnms'}]);
  const configs = (await rows(c, 'select to_jsonb(c) row from membership_tier_config c where tenant_id=$1', [TENANT])).map(r => r.row);
  const [field] = await rows(c, 'select options from preference_field where id=$1 and tenant_id=$2', [FIELD, TENANT]);
  assert.ok(CLASSES.every(v => field.options.some(o => o.value === v)), 'Canonical selector missing');
  // No scheduled workflows or CRM exports may consume these synthetic records.
  const workflows = await rows(c, 'select trigger_type from workflow where tenant_id=$1 and is_active', [TENANT]);
  assert.ok(workflows.every(w => w.trigger_type === 'field_change'), 'Unexpected automatic workflow');
  assert.equal((await rows(c, 'select id from zoho_crm_sync_mapping where tenant_id=$1 limit 1', [TENANT])).length, 0);
  for (const table of ['membership_tier_discount','membership_tier_vat_override']) {
    assert.equal((await rows(c, `select id from ${table} where tenant_id=$1 limit 1`, [TENANT])).length, 0, 'Pricing rule requires review');
  }
  const reminders = await rows(c, 'select recipient_role_ids from membership_tier_reminder where tenant_id=$1 and is_active', [TENANT]);
  assert.ok(reminders.every(r => Array.isArray(r.recipient_role_ids) && r.recipient_role_ids.length
    && r.recipient_role_ids.every(Boolean)), 'Unrestricted reminder could send to a fixture');
  // Existing automatic regional groups do not match unlinked owners with only a class preference.
  const groups = await rows(c, 'select automatic_membership_filter_groups filters from member_group where tenant_id=$1 and automatic_membership_enabled', [TENANT]);
  for (const g of groups) {
    assert.ok(g.filters.length);
    for (const branch of g.filters) assert.ok(branch.conditions.some(condition =>
      condition.field_type === 'custom' && condition.field_key !== FIELD
      && condition.operator === 'equals' && condition.value), 'Automatic group could include a fixture');
  }
  const guards = await rows(c, `select c.relname,t.tgname,pg_get_triggerdef(t.oid) trigger,
    pg_get_functiondef(p.oid) definition from pg_trigger t join pg_proc p on p.oid=t.tgfoid
    join pg_class c on c.oid=t.tgrelid where not t.tgisinternal
    and t.tgrelid in ('member'::regclass,'member_preference_value'::regclass,'member_membership_history'::regclass)
    order by c.relname,t.tgname`);
  return { configs, safetyHash: safetySignature({ guards, workflows, reminders, groups }) };
}

async function verify(c, manifest) {
  const ids = manifest.fixtures.map(f => f.member.id);
  const result = {};
  for (const [key, table, column] of [
    ['member','member','id'], ['preference','member_preference_value','member_id'],
    ['history','member_membership_history','member_id'],
  ]) {
    const actual = (await rows(c, `select to_jsonb(r) row from ${table} r where ${column}=any($1::uuid[])`, [ids])).map(r => r.row);
    assert.equal(actual.length, 5, `Unexpected ${table} count`);
    for (const f of manifest.fixtures) {
      const stored = actual.find(r => r.id === f[key].id);
      assert.ok(stored, `Missing ${key}`);
      for (const [k,v] of Object.entries(f[key])) assert.deepEqual(stored[k], v, `${key}.${k} drift`);
      if (key === 'history') {
        for (const field of ['billing_agreement_id','stripe_payment_intent_id','accounting_invoice_id',
          'xero_invoice_id','membership_payment_quote_id','membership_successor_election_id',
          'accounting_provider','accounting_sync_status','previous_term_id']) assert.equal(stored[field], null);
      }
    }
    result[key] = actual;
  }
  for (const table of ['membership_billing_agreements','membership_payment_plans',
    'membership_payment_quote','membership_successor_election','member_membership_invoicing',
    'membership_tier_reminder_send']) {
    assert.equal((await rows(c, `select id from ${table} where tenant_id=$1 and member_id=any($2::uuid[]) limit 1`, [TENANT, ids])).length, 0, `Unexpected ${table}`);
  }
  const [{enabled}] = await rows(c, 'select membership_successor_elections_enabled($1::uuid) enabled', [TENANT]);
  return manifest.fixtures.map(f => {
    const history = result.history.find(r => r.id === f.history.id);
    const config = history.commitment_snapshot.config;
    const annual = classifyAnnualRenewal({ previousRecord: history, config, now: new Date(manifest.asOf) });
    const form = assessFormMembershipRenewalEvidence({ tenantId: TENANT, memberId: f.member.id,
      histories: [history], agreements: [], successorConfig: config, now: new Date(manifest.asOf), paused: false });
    assert.equal(annual.state, 'open');
    assert.equal(form.state, 'eligible_renewal');
    return { memberId: f.member.id, historyId: history.id, preferenceId: f.preference.id,
      name: `${f.member.first_name} ${f.member.last_name}`, memberClass: f.memberClass,
      configId: config.id, schedule: config.name, amount: history.total_with_vat, currency: history.currency,
      start: history.term_start_date, end: history.term_end_date, renewal: history.membership_renewal_date,
      opens: form.opensOn, state: form.state, tenantRolloutEnabled: enabled };
  });
}

async function insert(c, table, row) {
  const keys = Object.keys(row);
  await c.query(`insert into ${table} (${keys.join(',')}) values (${keys.map((_,i) => `$${i+1}`).join(',')})`,
    keys.map(k => row[k]));
}

export async function run(c, { apply = false, expectedHash = null, savedManifest = null, journal = null } = {}) {
  await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    await c.query("SET LOCAL statement_timeout='20s'");
    await c.query("SET LOCAL lock_timeout='5s'");
    await c.query("select pg_advisory_xact_lock(hashtext('bnms-synthetic-renewal-fixtures'))");
    // Keep policies stable through commit. No policy or cron settings are changed.
    await c.query(`LOCK TABLE membership_tier_config,preference_field,workflow,membership_tier_reminder,
      zoho_crm_sync_mapping,membership_tier_discount,membership_tier_vat_override IN SHARE MODE`);
    const {configs, safetyHash} = await prerequisites(c);
    const [{today}] = await rows(c, 'select current_date::text today');
    const manifest = {...buildManifest(configs, today), safetyHash};
    if (savedManifest) assert.equal(hash(manifest), hash(savedManifest), 'Reviewed manifest/config drift');
    const digest = hash(manifest);
    if (apply) assert.equal(expectedHash, digest, 'Exact dry-run hash required');
    const ids = manifest.fixtures.map(f => f.member.id);
    const emails = manifest.fixtures.map(f => f.member.email);
    const existing = await rows(c, 'select id from member where id=any($1::uuid[]) or lower(email)=any($2::text[])', [ids, emails]);
    if (existing.length) {
      assert.equal(existing.length, 5, 'Partial batch or email collision');
      const inventory = await verify(c, manifest);
      await c.query('ROLLBACK');
      return { mode: 'replay', writes: 0, hash: digest, manifest, inventory };
    }
    for (const f of manifest.fixtures) {
      await insert(c, 'member', f.member);
      await insert(c, 'member_preference_value', f.preference);
      await insert(c, 'member_membership_history', f.history);
    }
    const inventory = await verify(c, manifest);
    const result = { mode: apply ? 'apply' : 'dry_run', writes: apply ? 15 : 0, hash: digest, manifest, inventory };
    if (apply) {
      assert.equal(typeof journal, 'function', 'Durable pre-commit journal required');
      await journal({...result, committed:false});
    }
    // Dry-run rehearses actual constraints and transactional triggers, then rolls back.
    await c.query(apply ? 'COMMIT' : 'ROLLBACK');
    return {...result, committed:apply};
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  }
}

async function applicationReadChecks(manifest) {
  const base = createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, { auth: {persistSession:false} });
  const db = { from(table) {
    const wrap = q => new Proxy(q, { get(target, key) {
      assert.ok(!['insert','update','upsert','delete'].includes(key), 'Read-only adapter');
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? (...args) => key === 'then' ? value.apply(target,args) : wrap(value.apply(target,args)) : value;
    } });
    return wrap(base.from(table));
  } };
  const resolver = createMembershipConfigResolver(db);
  for (const f of manifest.fixtures) {
    const config = await resolver.getConfigForMember(TENANT, f.member.id, {}, manifest.asOf);
    assert.equal(config?.id, f.history.config_id);
    const current = await loadCurrentRollingCommitment(db, { tenantId:TENANT, memberId:f.member.id, onDate:manifest.asOf });
    assert.equal(current?.id, f.history.id);
    const successor = await resolver.resolveRollingSuccessorConfig(db, { tenantId:TENANT, previousTerm:current });
    assert.equal(successor.id, config.id);
  }
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length === 2 || args.length === 3, 'Usage: --dry-run|--apply|--verify /tmp/report.json [dry-run-report.json]');
  const [mode, output, review] = args;
  assert.ok(['--dry-run','--apply','--verify'].includes(mode));
  assert.ok(resolve(output).startsWith('/tmp/'));
  const saved = review ? JSON.parse(await readFile(review,'utf8')) : null;
  if (mode !== '--dry-run') assert.ok(saved?.manifest && saved?.hash);
  // Reserve output before committing, never overwrite an earlier audit.
  await writeFile(output, '', {flag:'wx', mode:0o600});
  const c = await destinationConnection();
  await c.connect();
  try {
    let result;
    if (mode === '--verify') {
      await c.query('BEGIN READ ONLY');
      result = {mode:'verify', writes:0, inventory:await verify(c,saved.manifest)};
      await c.query('ROLLBACK');
      await applicationReadChecks(saved.manifest);
      result.applicationReadChecks = '5 persisted schedule/current/successor resolutions passed';
    } else result = await run(c, {apply:mode==='--apply', expectedHash:saved?.hash, savedManifest:saved?.manifest,
      journal: async value => {
        const file = await open(output,'w',0o600);
        try {await file.writeFile(JSON.stringify(value,null,2));await file.sync();} finally {await file.close();}
      }});
    await writeFile(output, JSON.stringify(result,null,2), {mode:0o600});
    console.log(JSON.stringify({mode:result.mode,writes:result.writes,hash:result.hash,inventory:result.inventory,
      applicationReadChecks:result.applicationReadChecks},null,2));
  } finally { await c.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(e => {console.error(e.message);process.exitCode=1;});
}
