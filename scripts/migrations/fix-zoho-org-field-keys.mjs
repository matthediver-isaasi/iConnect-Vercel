#!/usr/bin/env node
// One-shot migration to align saved Zoho organisation field mappings with
// the corrected ENTITY_CORE_FIELDS.organization keys.
//
// Background: ENTITY_CORE_FIELDS.organization previously declared keys
// ('website', 'email', 'address_line_1', 'address_line_2', 'city',
// 'country') that don't correspond to columns the rest of iConnect
// reads/writes. The org sync engine therefore read empty values from
// the wrong (legacy) columns and would have written back to them too.
// The metadata now uses the canonical column names ('website_url',
// 'invoicing_email', 'invoicing_address'). This script rewrites every
// saved zoho_crm_sync_mapping.field_mappings JSON so any rule that
// references an old key is moved onto the new one.
//
// Behaviour:
//   - 'website'         -> 'website_url'
//   - 'email'           -> 'invoicing_email'
//   - 'address_line_1', 'address_line_2', 'city', 'country' have no
//     equivalent single column. They're dropped from field_mappings and
//     reported so admins can reconfigure them (typically as a single
//     mapping into 'invoicing_address' or as custom fields).
//
// Idempotent: running twice produces no further changes.

import pg from 'pg';

const RENAMES = {
  website: 'website_url',
  email: 'invoicing_email'
};
const DROPS = new Set(['address_line_1', 'address_line_2', 'city', 'country']);

const url = process.env.DEST_DATABASE_URL;
if (!url) {
  console.error('DEST_DATABASE_URL is required');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

const { rows } = await client.query(
  `SELECT id, tenant_id, field_mappings
   FROM zoho_crm_sync_mapping
   WHERE entity_type = 'organization'`
);

let touched = 0;
let renamed = 0;
let dropped = 0;
let deduped = 0;
const droppedReport = [];
const dedupReport = [];

for (const row of rows) {
  const fm = Array.isArray(row.field_mappings) ? row.field_mappings : [];
  if (fm.length === 0) continue;

  const interim = [];
  let changed = false;
  for (const m of fm) {
    if (!m || typeof m !== 'object') {
      interim.push(m);
      continue;
    }
    const key = m.iconnect_field;
    if (typeof key !== 'string' || key.startsWith('custom:')) {
      interim.push(m);
      continue;
    }
    if (DROPS.has(key)) {
      dropped += 1;
      droppedReport.push({
        tenant_id: row.tenant_id,
        iconnect_field: key,
        zoho_field: m.zoho_field
      });
      changed = true;
      continue;
    }
    if (RENAMES[key]) {
      interim.push({ ...m, iconnect_field: RENAMES[key] });
      renamed += 1;
      changed = true;
      continue;
    }
    interim.push(m);
  }

  // Dedupe by iconnect_field. Renaming may collide with a pre-existing
  // mapping for the canonical key (e.g. tenant had separate `website` and
  // `website_url` rows that both referenced different Zoho fields). Keep
  // the first non-empty mapping for each iconnect_field and report the
  // collisions so admins can re-confirm which Zoho field should win. The
  // first occurrence is preserved deliberately because it usually
  // reflects the longer-standing, intentional pairing — anything coming
  // after is most likely an artefact of older bug-state mappings.
  const seen = new Map();
  const next = [];
  for (const m of interim) {
    if (!m || typeof m !== 'object') {
      next.push(m);
      continue;
    }
    const key = m.iconnect_field;
    if (typeof key !== 'string') {
      next.push(m);
      continue;
    }
    if (seen.has(key)) {
      deduped += 1;
      dedupReport.push({
        tenant_id: row.tenant_id,
        iconnect_field: key,
        kept_zoho_field: seen.get(key),
        dropped_zoho_field: m.zoho_field
      });
      changed = true;
      continue;
    }
    seen.set(key, m.zoho_field);
    next.push(m);
  }

  if (!changed) continue;
  await client.query(
    `UPDATE zoho_crm_sync_mapping
     SET field_mappings = $1::jsonb,
         updated_at = NOW()
     WHERE id = $2`,
    [JSON.stringify(next), row.id]
  );
  touched += 1;
}

console.log(`mappings inspected: ${rows.length}`);
console.log(`mappings updated:   ${touched}`);
console.log(`fields renamed:     ${renamed}`);
console.log(`fields dropped:     ${dropped}`);
if (droppedReport.length > 0) {
  console.log('\nDropped (no equivalent column — reconfigure manually):');
  for (const d of droppedReport) {
    console.log(`  tenant=${d.tenant_id}  ${d.iconnect_field} <- ${d.zoho_field}`);
  }
}

await client.end();
