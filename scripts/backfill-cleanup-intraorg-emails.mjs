/**
 * Backfill Cleanup: Remove intra-organisation emails from member_email table
 *
 * Identifies and deletes member_email rows where the sender AND every To/CC
 * recipient all belong to exactly one shared organisation within the tenant.
 * These are internal staff-to-staff emails that should not be recorded in
 * member communication history.
 *
 * The matching logic mirrors isIntraOrgEmail() in api/_lib/agentEmails.js:
 *   - resolve each participant (from + to + cc) to a member's organization_id
 *   - skip (keep) the email if any participant is unresolved (external address)
 *   - skip (keep) the email if participants span more than one organisation
 *   - delete only when all participants share exactly one organisation
 *
 * Usage:
 *   node scripts/backfill-cleanup-intraorg-emails.mjs                    # Dry run
 *   node scripts/backfill-cleanup-intraorg-emails.mjs --dry-run          # Dry run (explicit)
 *   node scripts/backfill-cleanup-intraorg-emails.mjs --apply            # Apply deletions
 *   node scripts/backfill-cleanup-intraorg-emails.mjs --tenant=<uuid>    # Single tenant
 *   node scripts/backfill-cleanup-intraorg-emails.mjs --apply --tenant=<uuid>
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.DEST_SUPABASE_URL || 'https://lvmzliemqnieeoruhkik.supabase.co';
const SUPABASE_KEY = process.env.DEST_SUPABASE_KEY;

if (!SUPABASE_KEY) {
  console.error('Error: DEST_SUPABASE_KEY environment variable is required');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--apply');
const SPECIFIC_TENANT = args.find(a => a.startsWith('--tenant='))?.split('=')[1];

const BATCH_SIZE = 500;
const SAMPLE_SIZE = 5;

console.log('='.repeat(60));
console.log('Intra-Organisation Email Cleanup Script');
console.log('='.repeat(60));
console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes will be made)' : 'APPLY (rows will be deleted)'}`);
if (SPECIFIC_TENANT) console.log(`Tenant filter: ${SPECIFIC_TENANT}`);
console.log('');

async function getTenants() {
  if (SPECIFIC_TENANT) {
    return [SPECIFIC_TENANT];
  }
  const { data, error } = await supabase.from('tenant').select('id').eq('status', 'active');
  if (error) {
    console.error('Failed to fetch tenants:', error);
    process.exit(1);
  }
  return (data || []).map(t => t.id);
}

/**
 * Returns a Map of lowercased email → organization_id for all members in the tenant
 * that have both an email and an organization_id. First row wins for duplicate emails.
 */
async function buildOrgMap(tenantId) {
  const { data, error } = await supabase
    .from('member')
    .select('email, organization_id')
    .eq('tenant_id', tenantId)
    .not('email', 'is', null)
    .not('organization_id', 'is', null);

  if (error) {
    console.error(`  [tenant ${tenantId}] Failed to fetch member org map:`, error);
    return new Map();
  }

  const map = new Map();
  for (const m of data || []) {
    const key = m.email.toLowerCase();
    if (!map.has(key)) {
      map.set(key, m.organization_id);
    }
  }
  return map;
}

/**
 * Given an orgMap, decides whether a member_email row should be deleted.
 * Returns true (delete) when all participants resolve to exactly one org.
 */
function isIntraOrg(row, orgMap) {
  const from = (row.from_address || '').toLowerCase();
  if (!from) return false;

  const toList = (row.to_addresses || []).map(r => ((r.address || r) + '').toLowerCase()).filter(Boolean);
  const ccList = (row.cc_addresses || []).map(r => ((r.address || r) + '').toLowerCase()).filter(Boolean);
  const allRecipients = [...toList, ...ccList];

  if (allRecipients.length === 0) return false;

  const fromOrg = orgMap.get(from);
  if (!fromOrg) return false;

  const orgIds = new Set([fromOrg]);
  for (const email of allRecipients) {
    const orgId = orgMap.get(email);
    if (!orgId) return false;
    orgIds.add(orgId);
  }

  return orgIds.size === 1;
}

async function processEmails(tenantId, orgMap) {
  if (orgMap.size === 0) {
    console.log(`  Skipping: no member→org mappings found`);
    return { toDelete: [], sample: [] };
  }

  let offset = 0;
  const toDelete = [];
  const sample = [];

  while (true) {
    const { data: rows, error } = await supabase
      .from('member_email')
      .select('id, from_address, to_addresses, cc_addresses, subject, sent_at')
      .eq('tenant_id', tenantId)
      .range(offset, offset + BATCH_SIZE - 1)
      .order('id');

    if (error) {
      console.error(`  Error fetching emails at offset ${offset}:`, error);
      break;
    }

    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      if (isIntraOrg(row, orgMap)) {
        toDelete.push(row.id);
        if (sample.length < SAMPLE_SIZE) {
          sample.push({
            id: row.id,
            subject: row.subject,
            from: row.from_address,
            sent_at: row.sent_at
          });
        }
      }
    }

    if (rows.length < BATCH_SIZE) break;
    offset += BATCH_SIZE;
  }

  return { toDelete, sample };
}

async function deleteInBatches(ids, tenantId) {
  let deleted = 0;
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('member_email')
      .delete()
      .eq('tenant_id', tenantId)
      .in('id', batch);

    if (error) {
      console.error(`  Error deleting batch at index ${i}:`, error);
    } else {
      deleted += batch.length;
    }
  }
  return deleted;
}

async function main() {
  const tenantIds = await getTenants();
  console.log(`Processing ${tenantIds.length} tenant(s)\n`);

  let grandTotal = 0;

  for (const tenantId of tenantIds) {
    console.log(`Tenant: ${tenantId}`);

    const orgMap = await buildOrgMap(tenantId);
    console.log(`  Member→org mappings: ${orgMap.size}`);

    const { toDelete, sample } = await processEmails(tenantId, orgMap);
    console.log(`  Intra-org emails found: ${toDelete.length}`);

    if (sample.length > 0) {
      console.log(`  Sample rows:`);
      for (const s of sample) {
        console.log(`    - [${s.id}] "${s.subject}" from ${s.from} at ${s.sent_at}`);
      }
    }

    if (!DRY_RUN && toDelete.length > 0) {
      const deleted = await deleteInBatches(toDelete, tenantId);
      console.log(`  Deleted: ${deleted}`);
      grandTotal += deleted;
    } else {
      grandTotal += toDelete.length;
    }

    console.log('');
  }

  console.log('='.repeat(60));
  if (DRY_RUN) {
    console.log(`DRY RUN complete. Would delete ${grandTotal} intra-org email row(s).`);
    console.log('Run with --apply to perform the deletions.');
  } else {
    console.log(`Done. Deleted ${grandTotal} intra-org email row(s).`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
