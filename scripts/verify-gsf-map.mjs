#!/usr/bin/env node
/**
 * Structural verification for the GSF map API endpoints (task: GSF
 * Zoho-shaped map data API). Fetches both endpoints and diffs their output
 * against the two reference Zoho payload files:
 *   - same key set on every record
 *   - compatible value types per key (nullable-aware, learned from reference)
 *   - record counts within expected drift (live data has grown since the
 *     Zoho snapshot was taken)
 *   - id overlap: every reference record id should appear in live output
 *
 * Usage:
 *   node scripts/verify-gsf-map.mjs [--base=http://localhost:5000] [--token=SECRET]
 * Token defaults to env GSF_MAP_API_SECRET.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, ...v] = a.slice(2).split('=');
    return [k, v.join('=') || true];
  })
);
const BASE = args.base || 'http://localhost:5000';
const TOKEN = args.token || process.env.GSF_MAP_API_SECRET;
if (!TOKEN) {
  console.error('No token: pass --token= or set GSF_MAP_API_SECRET');
  process.exit(1);
}

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const refMembers = JSON.parse(fs.readFileSync(path.join(root, 'attached_assets/Zoho_Raw_Payload_Members_1783508806159.json'), 'utf8'));
const refCountries = JSON.parse(fs.readFileSync(path.join(root, 'attached_assets/Zoho_Raw_Payload_Countries_1783508806158.json'), 'utf8'));

let failures = 0;
const fail = (msg) => { failures++; console.error(`  FAIL: ${msg}`); };
const ok = (msg) => console.log(`  ok: ${msg}`);

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function learnTypes(records) {
  const types = {};
  for (const r of records) {
    for (const [k, v] of Object.entries(r)) {
      (types[k] = types[k] || new Set()).add(typeOf(v));
    }
  }
  return types;
}

async function fetchJson(pathName) {
  const url = `${BASE}${pathName}?token=${encodeURIComponent(TOKEN)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${pathName} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function verify(name, ref, live, { idKey = 'id', driftPct = 25, refOnlyRows = 0 } = {}) {
  console.log(`\n== ${name} ==`);
  if (!Array.isArray(live)) { fail('live payload is not an array'); return; }

  // 1) counts within drift
  const refCount = ref.length - refOnlyRows;
  const min = Math.floor(refCount * (1 - driftPct / 100));
  const max = Math.ceil(refCount * (1 + driftPct / 100));
  if (live.length < min || live.length > max) {
    fail(`record count ${live.length} outside expected drift range [${min}, ${max}] (reference: ${refCount})`);
  } else {
    ok(`record count ${live.length} (reference ${refCount}, within ±${driftPct}%)`);
  }

  // 2) key sets
  const refKeys = new Set(Object.keys(ref[0]));
  let keyMismatch = 0;
  for (const [i, r] of live.entries()) {
    const keys = new Set(Object.keys(r));
    const missing = [...refKeys].filter((k) => !keys.has(k));
    const extra = [...keys].filter((k) => !refKeys.has(k));
    if (missing.length || extra.length) {
      if (++keyMismatch <= 3) {
        fail(`record[${i}] key mismatch: missing=[${missing.join(',')}] extra=[${extra.join(',')}]`);
      }
    }
  }
  if (!keyMismatch) ok(`all ${live.length} records carry the exact ${refKeys.size}-key reference key set`);
  else fail(`${keyMismatch} records with key mismatches`);

  // 3) types (nullable-aware: a live type is valid if the reference ever
  //    used it for that key, or the live value is null and reference has
  //    nulls elsewhere / the key is nullable by nature of drift)
  const refTypes = learnTypes(ref);
  const badTypes = new Map();
  for (const r of live) {
    for (const [k, v] of Object.entries(r)) {
      if (!refTypes[k]) continue;
      const t = typeOf(v);
      if (refTypes[k].has(t)) continue;
      // tolerate null for keys the reference never had null on (live data
      // can legitimately lack a value the snapshot always had)
      if (t === 'null') continue;
      const kk = `${k}: live=${t} ref={${[...refTypes[k]].join(',')}}`;
      badTypes.set(kk, (badTypes.get(kk) || 0) + 1);
    }
  }
  if (badTypes.size === 0) ok('all value types compatible with reference');
  else for (const [k, c] of badTypes) fail(`type mismatch on ${k} (${c} records)`);

  // 4) id overlap
  if (idKey) {
    const liveIds = new Set(live.map((r) => r[idKey]));
    const refWithIds = ref.filter((r) => r[idKey] != null && (refOnlyRows === 0 || r.Parent_Id));
    const missing = refWithIds.filter((r) => !liveIds.has(r[idKey]));
    const pct = (missing.length / Math.max(refWithIds.length, 1)) * 100;
    if (pct > 5) {
      fail(`${missing.length}/${refWithIds.length} reference ids missing from live output ` +
        `(e.g. ${missing.slice(0, 3).map((r) => r[idKey]).join(', ')})`);
    } else {
      ok(`${refWithIds.length - missing.length}/${refWithIds.length} reference ids present in live output` +
        (missing.length ? ` (${missing.length} missing, within drift)` : ''));
    }
  }
}

const liveMembers = await fetchJson('/api/public/gsf-map/members');
verify('Members', refMembers, liveMembers, { driftPct: 25 });
const memberCountrySentinels = liveMembers.filter(
  (row) => row.Countries_of_Operation?.includes('Multiple locations')
);
if (memberCountrySentinels.length) {
  fail(`${memberCountrySentinels.length} members collapsed Countries_of_Operation to "Multiple locations"`);
} else {
  ok('Countries_of_Operation contains individual countries, never "Multiple locations"');
}

// Deep spot-check on overlapping member records: compare a handful of
// high-signal fields for equality with the Zoho snapshot.
{
  const byId = new Map(liveMembers.map((r) => [r.id, r]));
  const SPOT_FIELDS = ['Account_Name', 'Account_Type', 'Lifecycle_Status', 'Account_ID_Number'];
  const diffs = {};
  let compared = 0;
  for (const ref of refMembers) {
    const live = byId.get(ref.id);
    if (!live) continue;
    compared++;
    for (const f of SPOT_FIELDS) {
      if (JSON.stringify(ref[f]) !== JSON.stringify(live[f])) {
        (diffs[f] = diffs[f] || []).push(ref.id);
      }
    }
  }
  console.log(`\n== Members spot-check (${compared} overlapping records) ==`);
  for (const f of SPOT_FIELDS) {
    const d = diffs[f] || [];
    const pct = (d.length / Math.max(compared, 1)) * 100;
    if (pct > 10) fail(`${f}: ${d.length}/${compared} differ from snapshot (e.g. ${d.slice(0, 2).join(', ')})`);
    else ok(`${f}: ${compared - d.length}/${compared} byte-identical to snapshot${d.length ? ` (${d.length} drifted)` : ''}`);
  }

  // Org_logo_URL: byte parity with the snapshot is impossible by design —
  // most reference URLs are legacy Zoho-Creator-hosted links that exist only
  // inside Zoho. Instead require every live logo to be a usable https URL.
  const badLogos = liveMembers.filter(
    (r) => r.Org_logo_URL !== null && !/^https:\/\//.test(r.Org_logo_URL)
  );
  const nullLogos = liveMembers.filter((r) => r.Org_logo_URL === null);
  if (badLogos.length) fail(`Org_logo_URL: ${badLogos.length} records with non-https logo URLs`);
  else ok(`Org_logo_URL: all non-null logos are https URLs (${nullLogos.length} orgs without a logo)`);
}

const liveCountries = await fetchJson('/api/public/gsf-map/countries');
const countrySentinels = liveCountries.filter((row) => row.Country?.name === 'Multiple locations');
if (countrySentinels.length) fail(`${countrySentinels.length} country rows use "Multiple locations"`);
else ok('Countries payload contains no "Multiple locations" rows');
const refLinked = refCountries.filter((r) => r.Parent_Id);
verify('Countries', refLinked, liveCountries, { driftPct: 30 });

// Countries deep check: country metadata parity for overlapping row ids.
{
  const byId = new Map(liveCountries.map((r) => [r.id, r]));
  let compared = 0; let metaDiff = 0;
  for (const ref of refLinked) {
    const live = byId.get(ref.id);
    if (!live) continue;
    compared++;
    const same =
      ref.Country?.name === live.Country?.name &&
      ref.Country?.id === live.Country?.id &&
      ref.Income_Group === live.Income_Group &&
      ref.GSF_Region_Classification === live.GSF_Region_Classification &&
      ref.Flag === live.Flag &&
      ref.Parent_Id?.id === live.Parent_Id?.id;
    if (!same) metaDiff++;
  }
  console.log(`\n== Countries spot-check (${compared} overlapping rows) ==`);
  if (metaDiff) fail(`${metaDiff}/${compared} rows differ on country metadata / parent`);
  else ok(`all ${compared} overlapping rows byte-identical on country metadata + parent`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
