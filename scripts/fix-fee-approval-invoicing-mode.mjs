#!/usr/bin/env node
// Task #3244 — Heal invoicing rows whose `invoicing_mode: 'manual'` was set as
// a side effect of fee approval (auto-approve or the approve-fees button),
// not by an explicit admin choice in the invoicing settings UI.
//
// Heuristic for a side-effect row: fees_approved = true, invoicing_mode =
// 'manual', and none of the fields the settings endpoint always writes
// (invoice_date, purchase_order_number) are set. The settings endpoint also
// always writes an explicit mode, so a deliberate "manual" choice with a PO
// or schedule date is never touched; a deliberate bare "manual" save is
// indistinguishable and is why this script is review-then-apply.
//
// Resets invoicing_mode to 'automatic' (the org table's column is NOT NULL).
// Idempotent: healed rows no longer match.
//
// Usage:
//   node scripts/fix-fee-approval-invoicing-mode.mjs --tenant "<name or uuid>"          # dry run
//   node scripts/fix-fee-approval-invoicing-mode.mjs --tenant "<name or uuid>" --apply
//
// Targets the production (DEST) database.

import { createClient } from '@supabase/supabase-js';

const url = process.env.DEST_SUPABASE_URL;
const key = process.env.DEST_SUPABASE_KEY;
if (!url || !key) {
  console.error('DEST_SUPABASE_URL / DEST_SUPABASE_KEY are required');
  process.exit(1);
}
const supabase = createClient(url, key);

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const tenantArgIdx = args.indexOf('--tenant');
const tenantArg = tenantArgIdx >= 0 ? args[tenantArgIdx + 1] : null;
if (!tenantArg) {
  console.error('--tenant <name or uuid> is required');
  process.exit(1);
}

const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantArg);
let tenantId = tenantArg;
let tenantName = tenantArg;
if (!isUuid) {
  const { data: tenants, error } = await supabase.from('tenant').select('id, name').ilike('name', tenantArg);
  if (error) { console.error('Tenant lookup failed:', error.message); process.exit(1); }
  if (!tenants || tenants.length !== 1) {
    console.error(`Expected exactly one tenant matching "${tenantArg}", found ${tenants?.length || 0}:`, (tenants || []).map(t => t.name));
    process.exit(1);
  }
  tenantId = tenants[0].id;
  tenantName = tenants[0].name;
} else {
  const { data: t } = await supabase.from('tenant').select('name').eq('id', tenantId).maybeSingle();
  tenantName = t?.name || tenantArg;
}
console.log(`Tenant: ${tenantName} (${tenantId})  mode: ${apply ? 'APPLY' : 'dry run'}`);

const TABLES = [
  { table: 'member_membership_invoicing', target: 'member_id' },
  { table: 'organisation_membership_invoicing', target: 'organization_id' },
];

let totalHealed = 0;
for (const { table, target } of TABLES) {
  const { data: rows, error } = await supabase
    .from(table)
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('invoicing_mode', 'manual')
    .eq('fees_approved', true)
    .order('id');
  if (error) { console.error(`[${table}] select failed:`, error.message); process.exit(1); }

  const candidates = (rows || []).filter(r => !r.invoice_date && !r.purchase_order_number);
  console.log(`\n[${table}] manual+approved rows: ${(rows || []).length}, side-effect candidates: ${candidates.length}`);
  for (const r of candidates) {
    console.log(`  id=${r.id} ${target}=${r[target]} year=${r.membership_year} updated_at=${r.updated_at || null}`);
  }
  if (apply && candidates.length > 0) {
    const ids = candidates.map(r => r.id);
    const { error: upErr, count } = await supabase
      .from(table)
      .update({ invoicing_mode: 'automatic', updated_at: new Date().toISOString() }, { count: 'exact' })
      .in('id', ids);
    if (upErr) { console.error(`[${table}] update failed:`, upErr.message); process.exit(1); }
    console.log(`  → healed ${count ?? ids.length} row(s): invoicing_mode set to 'automatic'`);
    totalHealed += count ?? ids.length;
  }
}
console.log(apply ? `\nDone. Healed ${totalHealed} row(s).` : '\nDry run only — re-run with --apply to heal the listed rows.');
