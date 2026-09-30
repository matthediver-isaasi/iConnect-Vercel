#!/usr/bin/env node
/**
 * Dry-run-first batch approval and fee-email delivery for an explicit member
 * cohort. This is intentionally not a CRM/CSV importer: the cohort file only
 * identifies already-imported members by member_id, email, or legacy_id.
 *
 * Examples:
 *   node scripts/bulk-process-imported-member-fees.mjs \
 *     --tenant <tenant-uuid> --cohort ./cohort.json --report ./fee-report.json
 *   node scripts/bulk-process-imported-member-fees.mjs \
 *     --tenant <tenant-uuid> --cohort ./cohort.csv --year 2026/2027 \
 *     --limit 25 --after <cursor> --apply --report ./fee-report.json
 *
 * No --apply means dry run. The script never prints or writes payment-token
 * values; the report contains only token lifecycle state.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { parse as parseCsv } from 'csv-parse/sync';
import {
  BATCH_OUTCOMES,
  PROCESSABLE_OUTCOMES,
  classifyCountRows,
  classifyMemberFee,
  executeMemberFeeBatch,
  pageByCursor,
} from '../api/_lib/memberFeeBatch.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = `Usage:
  node scripts/bulk-process-imported-member-fees.mjs --tenant <uuid> --cohort <json-or-csv> [options]

Required:
  --tenant <uuid>       Exact tenant to process
  --cohort <path>       Explicit imported cohort (member_id, email, or legacy_id)

Options:
  --year <yyyy/yyyy>    Restrict processing to the resolved membership year
  --member-id <uuid>    Restrict to one or more cohort member IDs (repeat or comma-separate)
  --email <address>     Restrict to one or more cohort emails (repeat or comma-separate)
  --limit <1-${MAX_LIMIT}>       Maximum cohort rows in this invocation (default ${DEFAULT_LIMIT})
  --after <cursor>      Resume strictly after the prior report's nextCursor
  --report <path>       Also write the machine-readable JSON report to this path
  --apply               Approve and send; omitted means dry run with no writes/emails
  --help                Show this usage
`;

function fail(message) {
  throw new Error(message);
}

function normalizeKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function emailKey(value) {
  return String(value || '').trim().toLowerCase();
}

function parseArgs(args = process.argv.slice(2)) {
  const options = {
    apply: false,
    tenantId: null,
    cohortPath: null,
    targetYear: null,
    memberIds: [],
    emails: [],
    after: null,
    limit: DEFAULT_LIMIT,
    reportPath: null,
    help: false,
  };
  const valueArgs = new Set(['--tenant', '--cohort', '--year', '--member-id', '--email', '--after', '--limit', '--report']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help') {
      options.help = true;
      continue;
    }
    if (arg === '--apply') {
      options.apply = true;
      continue;
    }
    if (!valueArgs.has(arg) || !args[index + 1] || args[index + 1].startsWith('--')) {
      fail(`Unknown or incomplete argument "${arg}". Use --tenant and --cohort; --apply is optional.`);
    }
    const value = args[++index];
    if (arg === '--tenant') options.tenantId = value;
    else if (arg === '--cohort') options.cohortPath = path.resolve(value);
    else if (arg === '--year') options.targetYear = value;
    else if (arg === '--member-id') options.memberIds.push(...value.split(',').filter(Boolean));
    else if (arg === '--email') options.emails.push(...value.split(',').map(emailKey).filter(Boolean));
    else if (arg === '--after') options.after = value;
    else if (arg === '--limit') options.limit = Number(value);
    else if (arg === '--report') options.reportPath = path.resolve(value);
  }
  if (options.help) return options;
  if (!options.tenantId || !UUID_RE.test(options.tenantId)) fail('--tenant must be a valid tenant UUID.');
  if (!options.cohortPath) fail('--cohort is required; refusing to sweep a tenant without an explicit cohort.');
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MAX_LIMIT) {
    fail(`--limit must be an integer from 1 to ${MAX_LIMIT}.`);
  }
  for (const id of options.memberIds) if (!UUID_RE.test(id)) fail(`Invalid --member-id "${id}".`);
  return options;
}

function identityFromObject(raw, index) {
  const values = Object.fromEntries(Object.entries(raw || {}).map(([key, value]) => [normalizeKey(key), value]));
  const memberId = String(values.memberid || values.memberuuid || '').trim() || null;
  const email = emailKey(values.email || values.memberemail);
  const legacyId = String(
    values.legacyid
      || values.ymwebsitememberid
      || values.importid
      || '',
  ).trim() || null;
  if (!memberId && !email && !legacyId) {
    fail(`Cohort row ${index + 1} must contain member_id, email, or legacy_id.`);
  }
  if (memberId && !UUID_RE.test(memberId)) fail(`Cohort row ${index + 1} has an invalid member_id.`);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(`Cohort row ${index + 1} has an invalid email.`);
  return { memberId, email: email || null, legacyId };
}

// Kept separate from identityFromObject so tests can use the same contract for
// JSON manifests and source-like CSV files with verbose column names.
export function parseCohortText(text, fileName = 'cohort') {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === '.json' || String(text).trim().startsWith('{') || String(text).trim().startsWith('[')) {
    let document;
    try {
      document = JSON.parse(text);
    } catch (error) {
      fail(`Could not parse cohort JSON: ${error.message}`);
    }
    const rows = Array.isArray(document)
      ? document
      : document?.members || document?.rows || (
        Array.isArray(document?.memberIds)
          ? document.memberIds.map((memberId) => ({ memberId }))
          : Array.isArray(document?.emails)
            ? document.emails.map((email) => ({ email }))
            : null
      );
    if (!Array.isArray(rows) || rows.length === 0) fail('Cohort JSON must contain a non-empty array of members, rows, memberIds, or emails.');
    return rows.map((row, index) => typeof row === 'string'
      ? identityFromObject({ memberId: row }, index)
      : identityFromObject(row, index));
  }
  let rows;
  try {
    rows = parseCsv(text, { columns: true, bom: true, skip_empty_lines: true, relax_column_count: false });
  } catch (error) {
    fail(`Could not parse cohort CSV: ${error.message}`);
  }
  if (!rows.length) fail('Cohort CSV must contain at least one data row.');
  return rows.map((row, index) => identityFromObject(row, index));
}

export function readCohort(filePath) {
  const bytes = readFileSync(filePath);
  return {
    rows: parseCohortText(bytes.toString('utf8'), filePath)
      .map((row, cohortIndex) => ({ ...row, cohortIndex })),
    fingerprint: createHash('sha256').update(bytes).digest('hex'),
  };
}

async function queryRows(query, label) {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data || [];
}

async function resolveCohortMembers(db, tenantId, entries) {
  const ids = [...new Set(entries.map((entry) => entry.memberId).filter(Boolean))];
  const emails = [...new Set(entries.map((entry) => entry.email).filter(Boolean))];
  const legacyIds = [...new Set(entries.map((entry) => entry.legacyId).filter(Boolean))];

  const [byId, byEmail] = await Promise.all([
    ids.length
      ? queryRows(db.from('member').select('id,tenant_id,email,first_name,last_name,created_on').in('id', ids), 'Could not resolve cohort member IDs')
      : [],
    emails.length
      ? queryRows(db.from('member').select('id,tenant_id,email,first_name,last_name,created_on').in('email', emails), 'Could not resolve cohort member emails')
      : [],
  ]);

  let byLegacy = [];
  const legacyMemberIdsByValue = new Map();
  if (legacyIds.length) {
    const fields = await queryRows(
      db.from('preference_field').select('id').eq('tenant_id', tenantId).eq('entity_scope', 'member').eq('name', 'ym_web_site_member_id'),
      'Could not resolve the imported-member ID field',
    );
    if (fields.length > 1) fail('More than one member field is named ym_web_site_member_id; refusing ambiguous cohort resolution.');
    if (fields.length === 1) {
      const values = await queryRows(
        db.from('member_preference_value').select('member_id,value').eq('field_id', fields[0].id).in('value', legacyIds),
        'Could not resolve cohort legacy IDs',
      );
      for (const value of values) {
        const key = String(value.value || '').trim();
        legacyMemberIdsByValue.set(key, [...(legacyMemberIdsByValue.get(key) || []), value.member_id]);
      }
      const legacyMemberIds = [...new Set(values.map((row) => row.member_id).filter(Boolean))];
      if (legacyMemberIds.length) {
        byLegacy = await queryRows(
          db.from('member').select('id,tenant_id,email,first_name,last_name,created_on').in('id', legacyMemberIds),
          'Could not load members resolved from cohort legacy IDs',
        );
      }
    }
  }

  const candidates = new Map();
  for (const member of [...byId, ...byEmail, ...byLegacy]) {
    if (candidates.has(member.id) && candidates.get(member.id).tenant_id !== member.tenant_id) {
      fail(`Conflicting tenant records resolved for member ${member.id}.`);
    }
    candidates.set(member.id, member);
  }
  const result = entries.map((entry) => {
    const legacyMatches = new Set(legacyMemberIdsByValue.get(entry.legacyId) || []);
    const matches = [...candidates.values()].filter((member) => (
      (entry.memberId && member.id === entry.memberId)
      || (entry.email && emailKey(member.email) === entry.email)
      || (entry.legacyId && legacyMatches.has(member.id))
    ));
    const distinctIds = [...new Set(matches.map((member) => member.id))];
    if (distinctIds.length > 1) {
      fail(`Cohort identity "${entry.memberId || entry.email || entry.legacyId}" resolves to more than one member.`);
    }
    const member = matches[0] || null;
    return {
      ...entry,
      cursor: `${String(entry.cohortIndex ?? 0).padStart(10, '0')}:${entry.memberId || entry.email || `legacy:${entry.legacyId}`}`,
      member: member || null,
      tenantMismatch: member ? member.tenant_id !== tenantId : false,
    };
  });
  const seenMembers = new Set();
  return result.map((entry) => {
    if (!entry.member || !seenMembers.has(entry.member.id)) {
      if (entry.member) seenMembers.add(entry.member.id);
      return entry;
    }
    return {
      ...entry,
      duplicateMember: true,
    };
  });
}

function publicRow(row) {
  return {
    cursor: row.cursor,
    memberId: row.memberId || null,
    email: row.email || null,
    memberName: row.memberName || null,
    membershipYear: row.membershipYear || null,
    outcome: row.outcome,
    action: row.action || 'not_processed',
    reason: row.reason || null,
    approvalRequired: row.approvalRequired ?? null,
    approved: row.approved ?? null,
    tokenStatus: row.tokenStatus || null,
    finalCost: row.finalCost ?? null,
    currency: row.currency || null,
    tierLabel: row.tierLabel || null,
    configId: row.configId || null,
    emailed: row.emailed || false,
    sentTo: row.sentTo || [],
  };
}

function setEnvironmentForDestination() {
  if (!process.env.DEST_SUPABASE_URL || !process.env.DEST_SUPABASE_KEY) {
    fail('DEST_SUPABASE_URL and DEST_SUPABASE_KEY are required; refusing source or default Supabase credentials.');
  }
  // The membership services use the API process-global client. Set those
  // aliases before their dynamic imports so simulation and email use DEST.
  process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
}

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    console.log(USAGE);
    return null;
  }
  setEnvironmentForDestination();
  const [
    { supabase: serviceClient },
    { simulateMembershipForMember },
    { resolveMemberFeeApproval, setMemberFeeApproval },
    { sendMembershipFeeTokenEmail },
  ] = await Promise.all([
    import('../api/_lib/database.js'),
    import('../api/_lib/membershipSimulation.js'),
    import('../api/_lib/membershipFeeApproval.js'),
    import('../api/_lib/membershipFeeTokenEmail.js'),
  ]);
  const db = serviceClient || createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, { auth: { persistSession: false } });
  const cohort = readCohort(options.cohortPath);
  const resolved = await resolveCohortMembers(db, options.tenantId, cohort.rows);
  const filters = {
    memberIds: new Set(options.memberIds),
    emails: new Set(options.emails),
  };
  const selected = resolved.filter((entry) => (
    (!filters.memberIds.size || filters.memberIds.has(entry.member?.id || entry.memberId))
    && (!filters.emails.size || filters.emails.has(emailKey(entry.member?.email || entry.email)))
  ));
  const page = pageByCursor(selected, { after: options.after, limit: options.limit });

  const loadHistory = async (tenantId, memberId, membershipYear) => queryRows(
    db.from('member_membership_history')
      .select('id,member_id,membership_year,final_cost,status,payment_status')
      .eq('tenant_id', tenantId).eq('member_id', memberId).eq('membership_year', membershipYear),
    'Could not read member membership history',
  );
  const loadTokens = async (tenantId, memberId, membershipYear) => queryRows(
    db.from('membership_fee_token')
      .select('id,status,expires_at,created_at')
      .eq('tenant_id', tenantId).eq('member_id', memberId).eq('membership_year', membershipYear)
      .in('status', ['pending', 'po_submitted', 'paid', 'expired', 'cancelled']),
    'Could not read member fee tokens',
  );
  const classified = [];
  for (const entry of page.rows) {
    let row;
    if (entry.duplicateMember) {
      row = {
        cursor: entry.cursor,
        memberId: entry.member?.id || entry.memberId,
        email: entry.member?.email || entry.email,
        outcome: BATCH_OUTCOMES.OTHER_SKIPPED,
        reason: 'Duplicate cohort identity resolves to a member already selected in this cohort',
      };
    } else if (!entry.member) {
      row = {
        cursor: entry.cursor,
        memberId: entry.memberId,
        email: entry.email,
        outcome: entry.tenantMismatch ? BATCH_OUTCOMES.TENANT_MISMATCH : BATCH_OUTCOMES.MISSING_MEMBER,
        reason: entry.tenantMismatch ? 'Member belongs to a different tenant' : 'Member was not found',
      };
    } else {
      row = await classifyMemberFee(entry.member, {
        tenantId: options.tenantId,
        targetYear: options.targetYear,
        simulate: simulateMembershipForMember,
        resolveApproval: (input) => resolveMemberFeeApproval(db, input),
        loadHistory,
        loadTokens,
      });
      row.cursor = entry.cursor;
    }
    classified.push(row);
  }

  const preflightCounts = classifyCountRows(classified);
  let appliedRows = [];
  if (options.apply) {
    console.error(`Preflight complete before writes: ${JSON.stringify(preflightCounts)}`);
    appliedRows = await executeMemberFeeBatch(classified, {
      apply: true,
      tenantId: options.tenantId,
      client: db,
      setApproval: ({ client, ...input }) => setMemberFeeApproval(client, input),
      sendEmail: (payload) => sendMembershipFeeTokenEmail({
        ...payload,
        client: db,
        requireAtomicMemberClaim: true,
      }),
      loadHistory,
      loadTokens,
      recordNote: async ({ memberId, membershipYear, email, finalCost }) => {
        const row = classified.find((item) => item.memberId === memberId && item.membershipYear === membershipYear);
        const { error } = await db.from('member_note').insert({
          target_member_id: memberId,
          author_member_id: null,
          content: `[Membership Fee Email] Fee notification sent to ${email} for ${membershipYear}. Amount: ${row?.currency === 'GBP' ? '£' : `${row?.currency || ''} `}${Number(finalCost || 0).toFixed(2)}.`,
          attachments: [],
        });
        // The individual UI treats its audit note as non-fatal. Preserve that
        // behavior so a note-column mismatch does not resend a fee.
        if (error) console.warn(`[bulk member fees] note not recorded for ${memberId}: ${error.message}`);
      },
    });
  }

  const outputRows = options.apply
    ? classified.map((row) => {
      const applied = appliedRows.find((item) => item.cursor === row.cursor);
      return publicRow(applied || row);
    })
    : classified.map(publicRow);
  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    mode: options.apply ? 'apply' : 'dry_run',
    tenantId: options.tenantId,
    cohort: {
      path: path.relative(ROOT, options.cohortPath) || options.cohortPath,
      sha256: cohort.fingerprint,
      inputRows: cohort.rows.length,
      selectedRows: selected.length,
    },
    filters: {
      memberIds: options.memberIds,
      emails: options.emails,
      membershipYear: options.targetYear,
      after: options.after,
      limit: options.limit,
    },
    page: {
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
      processedRows: outputRows.length,
    },
    preflightCounts,
    counts: classifyCountRows(outputRows),
    apply: options.apply ? {
      attempted: appliedRows.length,
      applied: appliedRows.filter((row) => row.action === 'applied').length,
      replaySkipped: appliedRows.filter((row) => row.action === 'skipped_replay').length,
      errors: appliedRows.filter((row) => row.action === 'error').length,
    } : null,
    rows: outputRows,
  };
  if (options.reportPath) {
    writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`\nERROR: ${error.message}`);
    process.exit(1);
  });
}
