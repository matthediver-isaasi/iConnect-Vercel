#!/usr/bin/env node
// Controlled one-off importer. Importing this module never opens a connection.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import XLSX from 'xlsx';

export const FILE = fileURLToPath(new URL('../attached_assets/CPD_points_post_2021_to_import_1789892302196.xlsx', import.meta.url));
export const WORKBOOK_SHA256 = '9b1354284acec1acb5196b61de203e4738a31f0ff6379d864c04f0a1bf13b9ca';
export const SOURCE_SYSTEM = 'bnms-historical-cpd';
export const HEADERS = ['iConnect UUID', 'Entry ID', 'Status', 'Entry Date', 'Member ID', '', 'First Name', 'Last Name', 'Details', 'Credits', 'Expires', 'Score (%)', 'Certification Code', 'Credit Type', 'Locked'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = message => { throw new Error(message); };
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
// numeric(20,6), without any floating point arithmetic, even for totals.
export function units(value, signed = false) {
  if (typeof value !== 'string' || !(signed ? /^-?\d{1,14}(?:\.\d{1,6})?$/ : /^\d{1,14}(?:\.\d{1,6})?$/).test(value)) fail('Invalid exact numeric(20,6) decimal');
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  return (BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'))) * (negative ? -1n : 1n);
}
export function decimal(value) {
  const negative = value < 0n;
  const n = negative ? -value : value;
  return `${negative ? '-' : ''}${n / 1000000n}${n % 1000000n ? `.${String(n % 1000000n).padStart(6, '0').replace(/0+$/, '')}` : ''}`;
}
export const total = rows => decimal(rows.reduce((n, r) => n + units(r.points_value), 0n));
export function dateFromCell(value, date1904 = false) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 61 || value > 100000) fail('Invalid Excel activity date');
    const d = XLSX.SSF.parse_date_code(value, { date1904 });
    return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail('Ambiguous activity date');
  return value;
}
export function parseWorkbook(bytes, { expectedHash = WORKBOOK_SHA256 } = {}) {
  const workbook_sha256 = hash(bytes);
  if (workbook_sha256 !== expectedHash) fail('Workbook fingerprint mismatch; new source requires reviewed code pin');
  const wb = XLSX.read(bytes, { type: 'buffer', raw: true, cellDates: false, bookFiles: true, cellNF: true });
  if (wb.SheetNames.length !== 1 || wb.SheetNames[0] !== 'Sheet1') fail('Expected only Sheet1');
  const sheet = wb.Sheets.Sheet1;
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '', blankrows: true });
  if (canonical(grid[0]) !== canonical(HEADERS)) fail('Unexpected workbook headers');
  // SheetJS parses numeric cells to JS numbers. Keep original XML numeric lexemes
  // for exact credits/identifiers and retain all original strings without trimming.
  const xml = wb.files['xl/worksheets/sheet1.xml']?.content?.toString();
  if (!xml) fail('Missing raw worksheet XML');
  const raw = new Map();
  for (const match of xml.matchAll(/<c\b([^>]*\br="([^"]+)"[^>]*)>([\s\S]*?)<\/c>/g)) {
    if (!/\bt="(?:s|str|inlineStr|b|e)"/.test(match[1])) {
      const v = match[3].match(/<v>([^<]*)<\/v>/);
      if (v) raw.set(match[2], v[1]);
    }
  }
  const ids = new Set();
  const rows = grid.slice(1).map((values, index) => {
    const line = index + 2;
    if (values.length !== HEADERS.length || values[5] !== '') fail(`Unexpected source shape at row ${line}`);
    const original = {};
    const raw_numeric_cells = {};
    HEADERS.forEach((header, column) => {
      const address = XLSX.utils.encode_cell({ r: line - 1, c: column });
      if (sheet[address]?.f) fail(`Formula requires review at row ${line}`);
      if (sheet[address]?.t === 'e') fail(`Cell error at row ${line}`);
      original[header || '(blank column F)'] = values[column];
      if (raw.has(address)) raw_numeric_cells[header] = raw.get(address);
    });
    const exact = column => raw_numeric_cells[HEADERS[column]] ?? values[column];
    const source_entry_id = String(exact(1));
    if (!/^\d+$/.test(source_entry_id) || ids.has(source_entry_id)) fail(`Invalid or repeated Entry ID at row ${line}`);
    ids.add(source_entry_id);
    if (typeof values[0] !== 'string' || !UUID.test(values[0])) fail(`Invalid member UUID at row ${line}`);
    if (values[2] !== 'approved' || values[13] !== 'CPD' || typeof values[14] !== 'boolean') fail(`Unsupported source semantics at row ${line}`);
    if (values[10] !== '' || values[11] !== '') fail(`Expiry/score require policy review at row ${line}`);
    if (typeof values[8] !== 'string' || typeof values[12] !== 'string' || !values[12]) fail(`Invalid activity text at row ${line}`);
    const row = {
      source_entry_id, member_id: values[0].toLowerCase(),
      points_value: decimal(units(String(exact(9)))),
      activity_date: dateFromCell(values[3], !!wb.Workbook?.WBProps?.date1904),
      activity_title: values[12], activity_description: values[8],
      source_metadata: {
        workbook_sha256, sheet: 'Sheet1', source_row: line,
        original, raw_numeric_cells,
        semantics: { certification_code: 'source activity label, not issued certificate ID', locked: 'provenance only; ledger remains immutable', entry_date: 'source calendar date; original Excel time retained in raw_numeric_cells', expires: 'blank; no expiry policy', score: 'blank; no score policy' },
      },
    };
    return { ...row, row_hash: hash(row) };
  });
  if (!rows.length) fail('Empty workbook');
  return { workbook_sha256, rows };
}
function groups(rows, fields) {
  const map = new Map();
  for (const row of rows) {
    const key = canonical(fields.map(f => row[f]));
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row.source_entry_id);
  }
  return [...map.values()].filter(ids => ids.length > 1).map(entry_ids => ({ group_id: hash(entry_ids), entry_ids }));
}
export function sourceAudit(source) {
  const dates = source.rows.map(r => r.activity_date).sort();
  return {
    workbook_sha256: source.workbook_sha256, source_system: SOURCE_SYSTEM,
    row_count: source.rows.length, member_count: new Set(source.rows.map(r => r.member_id)).size,
    points_total: total(source.rows), first_date: dates[0], last_date: dates.at(-1),
    unlocked_rows: source.rows.filter(r => r.source_metadata.original.Locked === false).length,
    duplicate_groups: groups(source.rows, ['member_id', 'activity_date', 'activity_title', 'points_value']),
    repeated_code_groups: groups(source.rows, ['member_id', 'activity_title']),
    row_identities_sha256: hash(source.rows.map(r => [r.source_entry_id, r.row_hash])),
    live_matching: 'NOT CHECKED',
  };
}
export function validateTarget(target, tenant) {
  if (!UUID.test(tenant || '')) fail('Explicit tenant UUID required');
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(target || '')) fail('Explicit canonical HTTPS Supabase target required (no credentials, path or query)');
}
// State adapter is injected in tests. Native overlap is intentionally conservative:
// ANY native award to a workbook member requires review; created_at is not activity date.
export function preflight(source, state, { target, tenant, decisions = {} }) {
  validateTarget(target, tenant);
  if (!state.tenantExists) fail('Target tenant not found');
  const audit = sourceAudit(source);
  const memberMap = new Map(state.members.map(m => [m.id, m]));
  const existing = new Map();
  for (const entry of state.imported) {
    if (entry.tenant_id !== tenant || entry.source_system !== SOURCE_SYSTEM) fail('Unexpected imported scope');
    if (existing.has(entry.source_entry_id)) fail('Duplicate live source identity');
    existing.set(entry.source_entry_id, entry);
  }
  const duplicateIds = new Set([...audit.duplicate_groups, ...audit.repeated_code_groups].flatMap(g => g.entry_ids));
  const known = new Set(source.rows.map(r => r.source_entry_id));
  for (const [id, decision] of Object.entries(decisions)) {
    if (!known.has(id) || !decision || !['keep', 'skip'].includes(decision.action) || typeof decision.reason !== 'string' || !decision.reason.trim()) fail('Invalid review decision');
  }
  const rows = source.rows.map(row => {
    const decision = decisions[row.source_entry_id];
    const member = memberMap.get(row.member_id);
    const match = !member ? 'missing' : member.tenant_id === tenant ? 'matched' : 'cross_tenant';
    const previous = existing.get(row.source_entry_id);
    const conflict = !!previous && previous.row_hash !== row.row_hash;
    const overlap = state.native.filter(e => e.member_id === row.member_id).map(e => e.id).sort();
    const blockers = [];
    if (conflict) blockers.push('existing_source_content_conflict');
    if (match !== 'matched') blockers.push(match);
    if (duplicateIds.has(row.source_entry_id) && !decision) blockers.push('duplicate_review_required');
    if (overlap.length && decision?.action !== 'skip' && decision?.native_overlap_reviewed !== true) blockers.push('native_overlap_review_required');
    const disposition = decision?.action === 'skip' ? 'skipped' : blockers.length ? 'blocked' : 'accepted';
    return { source_entry_id: row.source_entry_id, row_hash: row.row_hash, points_value: row.points_value,
      member_match: match, duplicate_review: duplicateIds.has(row.source_entry_id),
      native_overlap_ids: overlap, existing: conflict ? 'conflict' : previous ? 'identical' : 'absent', blockers, disposition };
  });
  const reconciliation = Object.fromEntries(['accepted', 'skipped', 'blocked'].map(status => {
    const selected = rows.filter(r => r.disposition === status);
    return [status, { rows: selected.length, points: total(selected) }];
  }));
  const report = { version: 1, target, tenant, audit, decisions, rows, reconciliation,
    member_matching: Object.fromEntries(['matched', 'missing', 'cross_tenant'].map(s => [s, new Set(source.rows.filter((_, i) => rows[i].member_match === s).map(r => r.member_id)).size])) };
  return { ...report, report_sha256: hash(report) };
}
export function approvalFor(source, report, actor) {
  if (!actor?.trim()) fail('Explicit approving actor required');
  if (report.reconciliation.blocked.rows) fail('Preflight contains blocked rows');
  const accepted = new Set(report.rows.filter(r => r.disposition === 'accepted').map(r => r.source_entry_id));
  const rows = source.rows.filter(r => accepted.has(r.source_entry_id));
  const approval = { version: 1, target: report.target, tenant: report.tenant, actor,
    workbook_sha256: source.workbook_sha256, source_system: SOURCE_SYSTEM,
    report_sha256: report.report_sha256, decisions: report.decisions,
    accepted_rows: rows.map(r => ({ source_entry_id: r.source_entry_id, row_hash: r.row_hash })),
    row_count: rows.length, points_total: total(rows), report };
  return { ...approval, approval_sha256: hash(approval) };
}
export function validateApproval(source, approval, suppliedHash, target, tenant) {
  validateTarget(target, tenant);
  const { approval_sha256, ...payload } = approval;
  if (!/^[a-f0-9]{64}$/.test(suppliedHash || '') || suppliedHash !== approval_sha256 || hash(payload) !== suppliedHash) fail('Approval hash mismatch');
  if (approval.target !== target || approval.tenant !== tenant || approval.workbook_sha256 !== source.workbook_sha256) fail('Approval target/tenant/workbook mismatch');
  const rebuilt = approvalFor(source, approval.report, approval.actor);
  if (canonical(rebuilt) !== canonical(approval)) fail('Approval content mismatch');
  const { report_sha256, ...report } = approval.report;
  if (hash(report) !== report_sha256) fail('Report hash mismatch');
}
export function revalidateApproval(source, approval, state) {
  const live = preflight(source, state, { target: approval.target, tenant: approval.tenant, decisions: approval.decisions });
  // Only absent -> identical is allowed: this is the resumable/replay transition.
  const comparable = report => report.rows.map(({ existing, ...row }) => ({ ...row, existing: existing === 'identical' ? 'absent' : existing }));
  if (canonical(comparable(live)) !== canonical(comparable(approval.report))) fail('Live preflight changed; stop and obtain fresh review');
  return live;
}
async function page(db, table, select, configure = q => q) {
  const result = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await configure(db.from(table).select(select)).order('id').range(offset, offset + 499);
    if (error || !Array.isArray(data)) fail(`Read-only preflight query failed: ${table} (check schema and service authorization)`);
    result.push(...data);
    if (data.length < 500) break;
  }
  return result;
}
export async function readState(db, source, tenant) {
  const tenants = await page(db, 'tenant', 'id', q => q.eq('id', tenant));
  const members = [], native = [], imported = [];
  const ids = [...new Set(source.rows.map(r => r.member_id))].sort();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    // Deliberately unscoped UUID lookup distinguishes missing from cross-tenant.
    members.push(...await page(db, 'member', 'id,tenant_id', q => q.in('id', chunk)));
    native.push(...await page(db, 'member_cpd_points_ledger', 'id,member_id', q => q.eq('tenant_id', tenant).eq('entry_kind', 'event_award').in('member_id', chunk)));
  }
  imported.push(...await page(db, 'member_cpd_points_ledger', 'id,tenant_id,source_system,source_entry_id,row_hash', q => q.eq('tenant_id', tenant).eq('source_system', SOURCE_SYSTEM).not('source_entry_id', 'is', null)));
  return { tenantExists: tenants.length === 1, members, native, imported };
}
export async function applyApproved({ db, source, approval, approvalHash, target, tenant, actor, read = readState, onProgress = () => {} }) {
  validateApproval(source, approval, approvalHash, target, tenant);
  if (!actor?.trim()) fail('Explicit applying actor required');
  revalidateApproval(source, approval, await read(db, source, tenant));
  const accepted = new Set(approval.accepted_rows.map(r => r.source_entry_id));
  const rows = source.rows.filter(r => accepted.has(r.source_entry_id));
  let appliedCount = 0, skippedCount = 0, appliedPoints = 0n, skippedPoints = 0n;
  for (let offset = 0; offset < rows.length; offset += 100) {
    // Revalidate before every transaction, including resumed batches.
    revalidateApproval(source, approval, await read(db, source, tenant));
    const chunk = rows.slice(offset, offset + 100);
    const manifest = { workbook_sha256: source.workbook_sha256, approval_sha256: approvalHash,
      source_system: SOURCE_SYSTEM, target, row_count: chunk.length, points_total: total(chunk) };
    const { data, error } = await db.rpc('import_historical_cpd_points_batch', {
      p_tenant_id: tenant, p_batch_key: `${approvalHash}:${offset / 100}`,
      p_manifest: manifest, p_rows: chunk, p_actor: actor,
    });
    if (error) fail('Import transaction failed; no automatic retry. Review state and resume with the same approval.');
    const result = Array.isArray(data) ? data[0] : data;
    if (!result || !Number.isInteger(result.applied_count) || !Number.isInteger(result.skipped_count) ||
        result.applied_count < 0 || result.skipped_count < 0 || result.applied_count + result.skipped_count !== chunk.length) fail('RPC row reconciliation failed; stop and inspect durable state');
    const ap = units(result.applied_points), sp = units(result.skipped_points);
    if (ap + sp !== units(total(chunk))) fail('RPC points reconciliation failed; stop and inspect durable state');
    appliedCount += result.applied_count; skippedCount += result.skipped_count;
    appliedPoints += ap; skippedPoints += sp;
    await onProgress({ chunks_completed: offset / 100 + 1, applied_count: appliedCount, skipped_count: skippedCount,
      applied_points: decimal(appliedPoints), skipped_points: decimal(skippedPoints) });
  }
  const final = revalidateApproval(source, approval, await read(db, source, tenant));
  if (final.rows.some(r => accepted.has(r.source_entry_id) && r.existing !== 'identical')) fail('Post-apply source reconciliation failed');
  return { source_rows: source.rows.length, source_points: total(source.rows), accepted_rows: rows.length, accepted_points: total(rows),
    excluded: approval.report.reconciliation.skipped, blocked: approval.report.reconciliation.blocked,
    applied_count: appliedCount, skipped_count: skippedCount, applied_points: decimal(appliedPoints), skipped_points: decimal(skippedPoints) };
}
function save(filename, value) {
  if (!filename) fail('Explicit output path required');
  // No overwrite: reports are immutable approval artifacts. Operator supplies a new path.
  writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}
export async function main(argv = process.argv.slice(2)) {
  const allowed = new Set(['preflight', 'apply', 'approve', 'target', 'tenant', 'source', 'out', 'decisions', 'report', 'approval', 'approval-sha256', 'actor', 'confirm-write']);
  const flags = {};
  for (const arg of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!match || !allowed.has(match[1]) || Object.hasOwn(flags, match[1])) fail('Unknown or repeated argument');
    flags[match[1]] = match[2] ?? true;
  }
  const source = parseWorkbook(readFileSync(flags.source || FILE));
  const modes = ['preflight', 'apply', 'approve'].filter(k => flags[k]);
  if (modes.length > 1) fail('Choose one mode');
  if (!modes.length) {
    const audit = sourceAudit(source);
    if (flags.out) save(flags.out, audit);
    console.log(JSON.stringify(audit, null, 2));
    return;
  }
  validateTarget(flags.target, flags.tenant);
  if (!flags.out) fail('Explicit --out required before any live operation');
  const json = filename => JSON.parse(readFileSync(filename, 'utf8'));
  if (flags.approve) {
    const report = json(flags.report);
    if (report.target !== flags.target || report.tenant !== flags.tenant || report.audit.workbook_sha256 !== source.workbook_sha256) fail('Report target/tenant/source mismatch');
    const { report_sha256, ...payload } = report;
    if (hash(payload) !== report_sha256) fail('Report hash mismatch');
    const approval = approvalFor(source, report, flags.actor);
    save(flags.out, approval);
    console.log(`Approval SHA256: ${approval.approval_sha256}`);
    return;
  }
  let approval;
  if (flags.apply) {
    if (flags['confirm-write'] !== true) fail('Apply requires --confirm-write');
    approval = json(flags.approval);
    validateApproval(source, approval, flags['approval-sha256'], flags.target, flags.tenant);
    if (!flags.actor?.trim()) fail('Explicit --actor required');
  }
  // Never infer a target from generic SUPABASE_* or SOURCE/DEST aliases.
  const url = process.env.HISTORICAL_CPD_SUPABASE_URL;
  const key = process.env.HISTORICAL_CPD_SERVICE_KEY;
  if (url !== flags.target || !key) fail('Explicit import credentials missing or target mismatch');
  const { createClient } = await import('@supabase/supabase-js');
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  if (flags.preflight) {
    const report = preflight(source, await readState(db, source, flags.tenant), {
      target: flags.target, tenant: flags.tenant, decisions: flags.decisions ? json(flags.decisions) : {},
    });
    save(flags.out, report);
    console.log(JSON.stringify({ report_sha256: report.report_sha256, reconciliation: report.reconciliation }));
  } else {
    const result = await applyApproved({ db, source, approval, approvalHash: flags['approval-sha256'],
      target: flags.target, tenant: flags.tenant, actor: flags.actor });
    save(flags.out, result);
    console.log(JSON.stringify(result));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Never print SDK/network errors, stack traces, connection strings or credentials.
    const safe = /^(Workbook|Expected|Unexpected|Missing raw|Invalid|Formula|Cell error|Unsupported|Expiry|Ambiguous|Empty|Explicit|Unknown|Choose|Report|Approval|Preflight|Live preflight|Read-only|Target tenant|Duplicate live|Import transaction|RPC |Post-apply|Apply requires)/.test(error.message);
    console.error(safe ? error.message : 'Historical CPD import failed; inspect private inputs and configuration (details suppressed).');
    process.exitCode = 1;
  });
}