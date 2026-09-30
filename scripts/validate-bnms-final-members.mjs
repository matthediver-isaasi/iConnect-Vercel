#!/usr/bin/env node
// Deliberately has no apply mode. All destination queries share a read-only snapshot.
import pg from 'pg';
import { readFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { FILE, HEADERS, CUSTOM_MAPPINGS, TENANT_ID, parseSourceBytes } from './bnms-final-source.mjs';

const PROJECT = 'lvmzliemqnieeoruhkik';
const FOCUS = '9e6a7200-1194-4e75-98d1-25a29303e95e';
const clean = v => String(v ?? '').normalize('NFKC').trim();
const email = v => clean(v).toLowerCase();
const core = { 5: 'first_name', 6: 'last_name', 8: 'email', 10: 'mobile', 11: 'organization_group_id', 12: 'organization_id' };

export async function loadState(client) {
  const query = async (sql, params = []) => (await client.query(sql, params)).rows;
  const tenant = await query('select id,name from public.tenant where id=$1', [TENANT_ID]);
  if (tenant.length !== 1 || tenant[0].name !== 'BNMS') throw Error('Pinned BNMS tenant mismatch');
  const state = {};
  for (const [key, table] of Object.entries({ fields: 'preference_field', categories: 'resource_category', groups: 'organization_group', organizations: 'organization' })) {
    state[key] = await query(`select * from public.${table} where tenant_id=$1 order by id`, [TENANT_ID]);
  }
  state.members = await query('select id,tenant_id,email,first_name,last_name,mobile,organization_id,organization_group_id from public.member where tenant_id=$1 order by id', [TENANT_ID]);
  state.preferences = await query('select p.id,p.member_id,p.field_id,p.value from public.member_preference_value p join public.member m on m.id=p.member_id where m.tenant_id=$1 order by p.id', [TENANT_ID]);
  // Field-ID scoped read additionally catches dangling/foreign legacy identities.
  state.legacy = await query('select id,member_id,field_id,value from public.member_preference_value where field_id=$1 order by id', [CUSTOM_MAPPINGS.find(m => m.column === 0).id]);
  state.memberCategories = await query('select c.* from public.member_resource_category c join public.member m on m.id=c.member_id where m.tenant_id=$1 order by c.id', [TENANT_ID]);
  state.edges = await query("select e.* from public.custom_object_relationship e join public.custom_object_relationship_definition d on d.id=e.relationship_definition_id join public.member m on m.id=e.target_record_id where m.tenant_id=$1 and d.target_kind='member' and e.archived_at is null order by e.id", [TENANT_ID]);
  state.columns = await query("select column_name,is_nullable,data_type from information_schema.columns where table_schema='public' and table_name='member'");
  return state;
}

export function mappingAudit(state) {
  return HEADERS.map((source, column) => {
    const contract = CUSTOM_MAPPINGS.find(m => m.column === column);
    const result = { column: column + 1, source, blank: 'Preserve existing; omit for new records', verified: false, issues: [] };
    if (core[column]) {
      result.destination = `member.${core[column]}`;
      result.verified = state.columns.some(c => c.column_name === core[column]);
      result.transform = column === 8 ? 'Trim/NFKC/lowercase' : column === 10 ? 'Opaque phone string; no numeric coercion' : column >= 11 ? 'Exact tenant-owned UUID; no placeholder or clearing' : 'Trim/NFKC';
    } else if (contract) {
      result.destination = `member_preference_value.value [${contract.id}]`;
      result.contract = contract;
      const candidates = state.fields.filter(f => f.id === contract.id || (f.entity_scope === 'member' && (f.name === contract.name || f.label === contract.label)));
      const f = candidates[0];
      result.verified = candidates.length === 1 && f.id === contract.id && f.tenant_id === TENANT_ID && f.name === contract.name && f.label === contract.label && f.field_type === contract.type && f.entity_scope === 'member' && f.is_active === true;
      result.options = f?.options;
      result.transform = column === 2 ? 'Raw Excel serial or British text -> dd/mm/yyyy legacy TEXT only' : column === 16 ? 'Raw Excel serial or British text -> ISO date' : column === 14 ? 'True/False -> text true/false' : column === 9 ? 'Trim/NFKC/lowercase' : 'Trim/NFKC; exact options only';
      if (f?.is_read_only === true || f?.is_writable === false) result.issues.push('Live field restricts writing');
      if (contract.type !== 'dropdown' && f?.options != null && (!Array.isArray(f.options) || f.options.length)) result.issues.push('Unexpected controlled options');
    } else {
      result.destination = `member_resource_category [${FOCUS}].subcategory_name`;
      const matches = state.categories.filter(c => c.id === FOCUS || c.name === 'Focus Area');
      const f = matches[0];
      result.verified = matches.length === 1 && f.id === FOCUS && f.name === 'Focus Area' && f.tenant_id === TENANT_ID && f.is_active === true;
      result.options = f?.subcategories;
      result.transform = 'Split pipe; trim; exact live subcategory names; additive only';
    }
    if (!result.verified) result.issues.push('Live destination contract unavailable or ambiguous');
    return result;
  });
}

export function makeReport(source, state) {
  const mappings = mappingAudit(state);
  const schemaBlockers = ['organization_id', 'organization_group_id'].filter(k => !state.columns.some(c => c.column_name === k && c.is_nullable === 'YES')).map(k => `Nullable ${k} not confirmed`);
  const rows = source.rows.map(row => {
    const excluded = source.excluded.some(r => r.sourceRow === row.sourceRow && r.legacyId === row.legacyId);
    const reasons = [...row.reasons], changes = [], comparisons = [];
    const emails = state.members.filter(m => email(m.email) === row.email);
    const legacy = state.legacy.filter(p => clean(p.value) === row.legacyId);
    const matches = [...new Set([...emails.map(m => m.id), ...legacy.map(p => p.member_id)])];
    if (emails.length > 1 || legacy.length > 1 || matches.length > 1) reasons.push('Ambiguous email/legacy-ID identity');
    if (matches.some(id => !state.members.some(m => m.id === id && m.tenant_id === TENANT_ID))) reasons.push('Missing or cross-tenant legacy identity');
    const member = matches.length === 1 ? state.members.find(m => m.id === matches[0]) : null;
    const compare = (field, current, desired) => {
      if (!desired) { comparisons.push({ field, current: current ?? null, action: 'preserve-blank-source' }); return; }
      const same = field === 'member.email' ? email(current) === desired : clean(current) === desired;
      const action = same ? 'unchanged' : clean(current) ? 'conflict' : 'proposed-fill';
      const item = { field, current: current ?? null, desired, action };
      comparisons.push(item);
      if (!same) changes.push(item);
      if (action === 'conflict') reasons.push(`Conflicting nonblank ${field}`);
    };
    for (const mapping of mappings) {
      const c = mapping.column - 1, raw = row.values[c];
      if (raw || core[c]) reasons.push(...mapping.issues.map(i => `${mapping.source}: ${i}`));
      if (core[c]) {
        compare(mapping.destination, member?.[core[c]], c === 8 ? row.email : raw);
      } else if (mapping.contract) {
        const existing = member ? state.preferences.filter(p => p.member_id === member.id && p.field_id === mapping.contract.id) : [];
        if (existing.length > 1) reasons.push(`Duplicate destination ${mapping.source}`);
        if (raw && mapping.contract.type === 'dropdown') {
          const options = (mapping.options || []).filter(o => o.value === raw || o.label === raw);
          if (options.length !== 1 || options[0].value !== raw) reasons.push(`Unsupported or noncanonical option ${mapping.source}: ${raw}`);
        }
        compare(mapping.destination, existing[0]?.value, raw);
      } else {
        for (const value of [...new Set(raw.split('|').map(clean).filter(Boolean))]) {
          if (!mapping.options?.includes(value)) reasons.push(`Unsupported Focus Area: ${value}`);
          const existing = member ? state.memberCategories.filter(p => p.member_id === member.id && p.resource_category_id === FOCUS && p.subcategory_name === value) : [];
          if (existing.length > 1) reasons.push(`Duplicate Focus Area: ${value}`);
          compare(`${mapping.destination}:${value}`, existing.length ? value : null, value);
        }
      }
    }
    for (const [c, key] of [[11, 'groups'], [12, 'organizations']]) {
      if (!row.values[c]) continue;
      const target = state[key].find(g => g.id === row.values[c] && g.tenant_id === TENANT_ID);
      if (!target || target.archived_at) reasons.push(`Missing, archived or foreign ${HEADERS[c]}`);
      if (c === 12 && target?.organization_group_id && !state.groups.some(g => g.id === target.organization_group_id && g.tenant_id === TENANT_ID && !g.archived_at)) reasons.push('Missing or foreign Organisation parent');
      if (member?.[core[c === 11 ? 12 : 11]]) reasons.push('Conflicting existing hierarchy');
    }
    if (!member) reasons.push(...schemaBlockers);
    if (member && changes.some(c => c.field.startsWith('member.organization')) && state.edges.some(e => e.target_record_id === member.id)) reasons.push('Hierarchy change affects existing relationships; review required');
    if (row.values[1] === 'Active' && /former|resigned/i.test(`${row.values[3]} ${row.values[4]}`)) reasons.push('Active status contradicts Former/Resigned classification; metadata review required');
    return { ...row, memberIds: matches, outcome: excluded ? 'user-excluded' : reasons.length ? 'blocked' : !member ? 'ready-new' : changes.length ? 'proposed-update' : 'existing-unchanged', reasons: excluded ? ['Explicit user exclusion pinned to worksheet row and legacy ID'] : [...new Set(reasons)], changes: excluded ? [] : changes, comparisons: excluded ? [] : comparisons, assignment: row.values[11] ? 'group' : row.values[12] ? 'organization' : 'none',
      hierarchyEvidence: { currentGroup: member?.organization_group_id ?? null, currentOrganization: member?.organization_id ?? null, suppliedOrganizationParent: state.organizations.find(o => o.id === row.values[12])?.organization_group_id ?? null, blankSourcePolicy: 'Preserve all existing relationships; new unassigned records get none' } };
  });
  for (const row of rows.filter(r => r.outcome !== 'user-excluded')) {
    if (row.memberIds.some(id => rows.some(other => other !== row && other.outcome !== 'user-excluded' && other.memberIds.includes(id)))) {
      row.outcome = 'blocked'; row.reasons.push('Destination matched by multiple eligible source rows');
    }
  }
  const counts = Object.fromEntries(['user-excluded', 'ready-new', 'existing-unchanged', 'proposed-update', 'blocked'].map(k => [k, rows.filter(r => r.outcome === k).length]));
  return { generatedAt: new Date().toISOString(), fingerprint: source.fingerprint, project: PROJECT, tenant: TENANT_ID,
    boundary: 'Metadata proposal only. No access, account, entitlement, consent, membership term, billing or provider changes authorized. No Member Since supplied or invented. Blanks never clear existing data.',
    migrations: 'None expected or applied', schemaBlockers, counts, sourceCounts: source.counts, dateCounts: source.dateCounts, duplicates: source.duplicates, mappings,
    readCoverage: Object.fromEntries(['members', 'preferences', 'legacy', 'groups', 'organizations', 'categories', 'edges'].map(k => [k, state[k].length])),
    decisionsRequired: [
      'Review Active alongside Former/Resigned on each blocked row; confirm legacy metadata or supply corrections. Neither choice authorizes access or billing changes.',
      'Resolve existing email/legacy identity and nonblank field/hierarchy conflicts individually; no overwrite or earlier overlap exception is approved.',
      'Review dd/mm/yyyy formatting of legacy expiry text, all field-level proposals, and explicitly authorize a separate future import. No Member Since may be inferred.',
      'Keep the exact two exclusions; retain row 71 subject to fresh identity checks. Accept all 23 unassigned rows without placeholders.',
    ], rows };
}

export async function readSnapshot(client, source) {
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const guard = await client.query('SHOW transaction_read_only');
    if (guard.rows[0].transaction_read_only !== 'on') throw Error('Read-only guard not active');
    const report = makeReport(source, await loadState(client));
    report.safety = { transactionReadOnly: true, isolation: 'repeatable read', mutationStatements: 0, providerCalls: 0 };
    return report;
  } finally { await client.query('ROLLBACK'); }
}

const escapeHtml = v => String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export function reportHtml(report, restricted = false) {
  const mappingRows = report.mappings.map(m => `<tr><td>${m.column}</td><td>${escapeHtml(m.source)}</td><td>${escapeHtml(m.destination)}</td><td>${escapeHtml(m.contract?.type || 'core/category')}</td><td>${escapeHtml(m.transform)}</td><td>${escapeHtml(m.blank)}</td><td>${m.verified && !m.issues.length ? 'Verified' : escapeHtml(m.issues.join('; '))}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>BNMS final workbook dry run</title><style>body{font:15px system-ui;margin:32px;color:#172033}table{border-collapse:collapse;width:100%;font-size:13px}td,th{border:1px solid #ccc;padding:8px;text-align:left;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere}h2{margin-top:32px}</style>
  <h1>BNMS final member workbook — read-only dry run</h1><p>${escapeHtml(report.generatedAt)} · DEST ${PROJECT}</p>
  <p>SHA-256: ${report.fingerprint}<br>Replacement Import · 79 source rows · 21 columns · 77 eligible · 2 user exclusions</p>
  <h2>Outcomes</h2><pre>${escapeHtml(JSON.stringify(report.counts, null, 2))}</pre>
  <p>${escapeHtml(report.boundary)}</p><p>Migrations: ${report.migrations}. Schema blockers: ${escapeHtml(report.schemaBlockers.join('; ') || 'none')}.</p>
  <p>Original Excel rows 75 and 79 excluded; row 71 retained. Source links: 28 Group / 28 Organisation / 23 none. Eligible links: 26 / 28 / 23. All 23 unassigned rows are accepted without placeholder relationships; other metadata conflicts can still block them.</p>
  <p>The original shared-email set is rows 71, 75 and 79; only row 71 remains eligible. Live comparisons use complete BNMS-scoped reads, not earlier importer assumptions.</p>
  <h2>Date evidence</h2><pre>${escapeHtml(JSON.stringify(report.dateCounts, null, 2))}</pre>
  <h2>Complete mapping table</h2><table><tr><th>#</th><th>Source</th><th>Destination</th><th>Type</th><th>Transformation</th><th>Blank handling</th><th>Live verification</th></tr>${mappingRows}</table>
  <h2>Decisions before any later import</h2><ul>${report.decisionsRequired.map(d => `<li>${escapeHtml(d)}</li>`).join('')}</ul>
  <h2>Blocked rows</h2><p>${report.rows.filter(r => r.outcome === 'blocked').map(r => r.sourceRow).join(', ')}</p>
  <ul>${report.rows.filter(r => r.outcome === 'blocked').map(r => `<li>Excel row ${r.sourceRow}: ${escapeHtml(r.reasons.join('; '))}</li>`).join('')}</ul>
  <h2>Safety and coverage</h2><pre>${escapeHtml(JSON.stringify({ ...report.safety, readCoverage: report.readCoverage }, null, 2))}</pre>
  <p>The destination connection used verified TLS and one REPEATABLE READ READ ONLY transaction, ending in ROLLBACK. There is no apply option. No production records, schema, notifications, provider state or billing data were changed.</p>
  ${restricted ? `<h2>Restricted row-level evidence</h2><p>Contains personal data. Do not publish or commit.</p>${report.rows.map(r => `<details><summary>Excel row ${r.sourceRow}: ${escapeHtml(r.outcome)}</summary><pre>${escapeHtml(JSON.stringify(r, null, 2))}</pre></details>`).join('')}` : '<p>Restricted row-level evidence: exports/bnms-final-validation/report.json and restricted-report.html (git-ignored, owner-only permissions).</p>'}
  </html>`;
}

export async function main(args = process.argv.slice(2)) {
  if (args.length) throw Error('No arguments supported; this validator has no apply mode');
  const source = parseSourceBytes(readFileSync(FILE));
  if (process.env.DEST_SUPABASE_URL !== `https://${PROJECT}.supabase.co`) throw Error('Pinned DEST required');
  const target = new URL(process.env.DEST_DATABASE_URL);
  if (decodeURIComponent(target.username) !== `postgres.${PROJECT}` || !/^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(target.hostname)) throw Error('Pinned DEST SQL target required');
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt', { redirect: 'error' });
  if (!response.ok) throw Error('Trusted TLS CA unavailable');
  const ca = await response.text();
  target.searchParams.delete('sslmode');
  const client = new pg.Client({ connectionString: target.toString(), ssl: { ca, rejectUnauthorized: true, servername: target.hostname } });
  await client.connect();
  let report;
  try { report = await readSnapshot(client, source); } finally { await client.end(); }
  const directory = path.resolve('exports/bnms-final-validation');
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['check-ignore', '-q', `${directory}/report.json`]);
  mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
  const filename = path.join(directory, 'report.json');
  writeFileSync(filename, JSON.stringify(report, null, 2), { mode: 0o600 }); chmodSync(filename, 0o600);
  for (const [name, restricted] of [['summary.html', false], ['restricted-report.html', true]]) {
    const file = path.join(directory, name);
    writeFileSync(file, reportHtml(report, restricted), { mode: 0o600 }); chmodSync(file, 0o600);
  }
  console.log(JSON.stringify({ counts: report.counts, schemaBlockers: report.schemaBlockers, mappingIssues: report.mappings.filter(m => m.issues.length).map(m => ({ source: m.source, issues: m.issues })), directory, migrations: report.migrations }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error('Validation failed; no import performed. Inspect validation code/connection prerequisites without exposing credentials.'); process.exitCode = 1; });