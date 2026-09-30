#!/usr/bin/env node
/**
 * Seed the Zoho-only legacy data behind the GSF map API endpoints
 * (api/public/gsf-map/*) from the two reference Zoho payload files.
 *
 * Extracts from attached_assets/Zoho_Raw_Payload_*.json:
 *   1. gsf_map_country_lookup  — country name -> { id, income_group, region, flag }
 *      (Income_Group / GSF_Region_Classification / Flag exist only in Zoho)
 *   2. gsf_map_country_row_ids — "parentZohoId|CountryName" -> { id, created_time }
 *      (preserves the original Zoho row ids for existing org x country rows)
 *   3. gsf_map_org_legacy      — org zoho id -> { account_id_number, category, tag }
 *      (Zoho auto-number + legacy pre-membership fields with no iConnect source)
 *
 * Writes three GSF-scoped rows into system_settings on the DEST database.
 * Idempotent: re-running overwrites the same rows. Defaults to dry-run;
 * pass --apply to write.
 *
 * Usage: node scripts/seed-gsf-map-legacy.mjs [--apply]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const GSF_TENANT_ID = '21296ad6-1350-483a-a90c-1b06ece70501';
const MEMBERS_FILE = 'attached_assets/Zoho_Raw_Payload_Members_1783508806159.json';
const COUNTRIES_FILE = 'attached_assets/Zoho_Raw_Payload_Countries_1783508806158.json';

const apply = process.argv.includes('--apply');

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const members = JSON.parse(fs.readFileSync(path.join(root, MEMBERS_FILE), 'utf8'));
const countries = JSON.parse(fs.readFileSync(path.join(root, COUNTRIES_FILE), 'utf8'));

// 1) Country metadata lookup
const countryLookup = {};
for (const row of countries) {
  const name = row.Country?.name;
  if (!name || countryLookup[name]) continue;
  countryLookup[name] = {
    id: row.Country.id ?? null,
    income_group: row.Income_Group ?? null,
    region: row.GSF_Region_Classification ?? null,
    flag: row.Flag ?? null
  };
}

// 2) Existing Zoho row ids per (parent org, country)
const countryRowIds = {};
for (const row of countries) {
  const parentId = row.Parent_Id?.id;
  const name = row.Country?.name;
  if (!parentId || !name) continue; // skip orphan rows
  countryRowIds[`${parentId}|${name}`] = {
    id: row.id,
    created_time: row.Created_Time ?? null
  };
}

// 3) Per-org legacy values with no iConnect source
const orgLegacy = {};
for (const rec of members) {
  orgLegacy[rec.id] = {
    account_id_number: rec.Account_ID_Number ?? null,
    category: rec.Please_select_the_category_that_best_describes_you ?? null,
    tag: Array.isArray(rec.Tag) ? rec.Tag : []
  };
}

const settings = [
  {
    setting_key: 'gsf_map_country_lookup',
    setting_value: JSON.stringify(countryLookup),
    description: 'GSF map API: Zoho country metadata lookup (seeded by scripts/seed-gsf-map-legacy.mjs)'
  },
  {
    setting_key: 'gsf_map_country_row_ids',
    setting_value: JSON.stringify(countryRowIds),
    description: 'GSF map API: original Zoho Countries row ids per org|country (seeded by scripts/seed-gsf-map-legacy.mjs)'
  },
  {
    setting_key: 'gsf_map_org_legacy',
    setting_value: JSON.stringify(orgLegacy),
    description: 'GSF map API: Zoho-only per-org legacy values (seeded by scripts/seed-gsf-map-legacy.mjs)'
  }
];

console.log(`Extracted: ${Object.keys(countryLookup).length} countries, ` +
  `${Object.keys(countryRowIds).length} country row ids, ` +
  `${Object.keys(orgLegacy).length} org legacy records`);
for (const s of settings) {
  console.log(`  ${s.setting_key}: ${s.setting_value.length} bytes`);
}

if (!apply) {
  console.log('\nDry run — pass --apply to write to system_settings.');
  process.exit(0);
}

const supabaseUrl = process.env.DEST_SUPABASE_URL;
const supabaseKey = process.env.DEST_SUPABASE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('DEST_SUPABASE_URL / DEST_SUPABASE_KEY not set');
  process.exit(1);
}
const sb = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

for (const s of settings) {
  const { data: existing, error: selErr } = await sb
    .from('system_settings')
    .select('id')
    .eq('tenant_id', GSF_TENANT_ID)
    .eq('setting_key', s.setting_key)
    .maybeSingle();
  if (selErr) {
    console.error(`Select failed for ${s.setting_key}:`, selErr.message);
    process.exit(1);
  }
  const row = {
    tenant_id: GSF_TENANT_ID,
    setting_key: s.setting_key,
    setting_value: s.setting_value,
    setting_type: 'json',
    description: s.description
  };
  const { error } = existing
    ? await sb.from('system_settings').update(row).eq('id', existing.id)
    : await sb.from('system_settings').insert(row);
  if (error) {
    console.error(`Write failed for ${s.setting_key}:`, error.message);
    process.exit(1);
  }
  console.log(`${existing ? 'Updated' : 'Inserted'} ${s.setting_key}`);
}
console.log('Done.');
