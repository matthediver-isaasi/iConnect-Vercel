/**
 * GSF Zoho-shaped map data builders (task: GSF map API).
 *
 * GSF's external map/search website used to pull two JSON payloads straight
 * from Zoho CRM:
 *   - "Members"  : one record per current member organisation (Zoho Accounts)
 *   - "Countries": one row per (member organisation x country of operation)
 *
 * These builders reproduce those payloads byte-compatibly from iConnect data
 * so the site can be repointed with zero changes. Reference payloads live in
 * attached_assets/Zoho_Raw_Payload_Members_*.json / ..._Countries_*.json and
 * scripts/verify-gsf-map.mjs diffs live output against them.
 *
 * Data sources:
 *   - The 38 field mappings in GSF's zoho_crm_sync_mapping row (organization
 *     -> Accounts) drive most Members fields, using the same outbound value
 *     translation the sync engine applies (multi-pick parse + value_map with
 *     dash/case-insensitive fallbacks).
 *   - Derived fields (contacts, logo, timestamps, filters) come from the
 *     organization/member tables and preference values.
 *   - Zoho-only data (country lookup metadata, Zoho row ids, legacy
 *     Account_ID_Number etc.) is seeded from the reference payloads into
 *     GSF-scoped system_settings rows by scripts/seed-gsf-map-legacy.mjs.
 *
 * HARD-SCOPED to the GSF tenant. Not a generic Zoho-compatible API.
 */

import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

export const GSF_TENANT_ID = '21296ad6-1350-483a-a90c-1b06ece70501';

// system_settings keys written by scripts/seed-gsf-map-legacy.mjs
export const SETTING_COUNTRY_LOOKUP = 'gsf_map_country_lookup';
export const SETTING_COUNTRY_ROW_IDS = 'gsf_map_country_row_ids';
export const SETTING_ORG_LEGACY = 'gsf_map_org_legacy';

// GSF preference-field ids used by derived (non-mapping) fields.
export const GSF_MAP_FIELD_IDS = {
  org_status: '077f1aa6-abdc-4bdc-a6ca-34b93c8726fd',
  org_type: '7af40750-1543-44e8-8022-0e0e27bc2c5c',
  member_type_sub_category: '0cf72e9f-000f-473a-a3f0-c8716bb14226',
  hq_location: 'b687c108-7ea5-450d-930d-7d5bf6b3acf0',
  year_established: 'c613c9be-8ae6-4201-b704-c5b24b24fe16',
  services_provided: '0d27775a-579b-49ac-8b63-9ebdcb2a1ffe',
  countries_of_operation: 'b799fad7-db74-443c-b461-93d30b7f4bba',
  ceo_flag: 'ee00b2a0-4ec4-4988-bac9-fd2b195b9d7a'
};

const FIELD_IDS = GSF_MAP_FIELD_IDS;

// iConnect country names that differ from Zoho's country-master names.
const COUNTRY_NAME_ALIASES = {
  'Congo, Dem. Rep.': 'Democratic Republic of the Congo',
  'Congo (Democratic Republic)': 'Democratic Republic of the Congo',
  'Egypt': 'Egypt, Arab Rep.',
  'Gambia': 'Gambia, The',
  'Laos': 'Lao PDR',
  'Ivory Coast': 'C\u00f4te d\u2019Ivoire',
  'Kyrgyzstan': 'Kyrgyz Republic'
};

// ---------------------------------------------------------------------------
// Zoho system constants (copied verbatim from the reference payloads).
// ---------------------------------------------------------------------------

const ZOHO_OWNER = {
  name: 'Sharon Bacon',
  id: '815132000000433001',
  email: 'sharon@onlinem.co.uk'
};

const MEMBERS_LAYOUT = {
  display_label: 'Standard',
  name: 'Standard',
  id: '815132000000032035'
};

const COUNTRIES_LAYOUT = {
  display_label: 'Standard',
  name: 'Standard',
  id: '815132000002869032'
};

const APPROVAL_OBJ = {
  delegate: false,
  takeover: false,
  approve: false,
  reject: false,
  resubmit: false
};

// ---------------------------------------------------------------------------
// Small local copies of the sync engine's outbound value helpers. Copied
// (not imported) so this read-only endpoint does not pull in the full
// zohoCrmSync module and its client dependencies.
// ---------------------------------------------------------------------------

const DASH_VARIANTS_RE = /[\u002D\u2013\u2014]/g;
const normDash = (s) => (typeof s === 'string' ? s.replace(DASH_VARIANTS_RE, '-') : s);

function applyValueMapOutbound(mapping, value) {
  if (value === undefined || value === null || value === '') return value;
  const dir = mapping?.value_map?.iconnect_to_zoho;
  if (!dir || typeof dir !== 'object' || Object.keys(dir).length === 0) return value;
  const key = String(value);
  if (Object.prototype.hasOwnProperty.call(dir, key)) return dir[key];
  const cmp = normDash(key);
  for (const k of Object.keys(dir)) {
    if (normDash(k) === cmp) return dir[k];
  }
  const ci = key.trim().toLowerCase();
  for (const k of Object.keys(dir)) {
    if (typeof k === 'string' && k.trim().toLowerCase() === ci) return dir[k];
  }
  return value;
}

export function parseMultiPickValue(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (Array.isArray(raw)) {
    return raw.filter((v) => v !== undefined && v !== null && v !== '').map(String);
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed.filter((v) => v !== undefined && v !== null && v !== '').map(String);
        }
      } catch {
        // fall through
      }
    }
    if (trimmed.includes(',')) {
      return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
    }
    return trimmed ? [trimmed] : null;
  }
  return [String(raw)];
}

const NUMERIC_TYPES = new Set(['number', 'decimal', 'percent', 'currency']);

/**
 * Translate one mapped iConnect value into the Zoho-shaped output value,
 * mirroring the sync engine's outbound behaviour:
 *   - multi-pick -> always an array (empty array when unset, matching Zoho's
 *     representation of an empty multi-select)
 *   - value_map applied per element / scalar with dash + CI fallbacks
 *   - numeric field types coerced to JSON numbers
 *   - empty string / undefined -> null (Zoho emits null for empty scalars)
 */
function formatMappedValue(mapping, raw) {
  if (mapping.is_multi_pick) {
    const arr = parseMultiPickValue(raw);
    if (arr === null) return [];
    return arr.map((v) => applyValueMapOutbound(mapping, v));
  }
  if (raw === undefined || raw === null || raw === '') return null;
  const translated = applyValueMapOutbound(mapping, raw);
  if (NUMERIC_TYPES.has(String(mapping.iconnect_field_type || '').toLowerCase())) {
    const n = Number(translated);
    return Number.isFinite(n) ? n : null;
  }
  return translated === '' ? null : translated;
}

/**
 * Format a timestamp the way Zoho CRM does for a Europe/London org:
 * `YYYY-MM-DDTHH:mm:ss+01:00` (or +00:00 in winter).
 */
export function formatZohoTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });
  const parts = {};
  for (const p of dtf.formatToParts(d)) parts[p.type] = p.value;
  // Intl can emit "24" for midnight with hour12:false in some ICU versions.
  const hour = parts.hour === '24' ? '00' : parts.hour;
  const asUtcMs = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(hour), Number(parts.minute), Number(parts.second)
  );
  const offsetMin = Math.round((asUtcMs - (d.getTime() - (d.getMilliseconds() || 0))) / 60000);
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  const oh = String(Math.floor(abs / 60)).padStart(2, '0');
  const om = String(abs % 60).padStart(2, '0');
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}${sign}${oh}:${om}`;
}

// Reference logo URLs point at vault.iconn.app; the DB stores the raw
// Supabase public-storage host. Rewrite so URLs stay byte-identical.
function rewriteLogoUrl(url, supabaseUrl) {
  if (!url || typeof url !== 'string') return null;
  if (supabaseUrl && url.startsWith(supabaseUrl)) {
    return `https://vault.iconn.app${url.slice(supabaseUrl.length)}`;
  }
  return url;
}

const isSignedPrivateUrl = (url) =>
  typeof url === 'string' && url.includes('/storage/v1/object/sign/');

/**
 * Resolve the best logo URL for an org:
 *  1. a stable public org.logo_url (rewritten to vault.iconn.app)
 *  2. else the approved DD submission document's published public copy
 *     (documents/published/... — same source the Zoho payload used)
 *  3. else whatever org.logo_url holds (may be a long-lived signed URL)
 */
function resolveLogoUrl(org, publishedLogoByOrg, supabaseUrl) {
  const direct = org.logo_url || null;
  if (direct && !isSignedPrivateUrl(direct)) return rewriteLogoUrl(direct, supabaseUrl);
  const published = publishedLogoByOrg.get(org.id);
  if (published) return rewriteLogoUrl(published, supabaseUrl);
  return rewriteLogoUrl(direct, supabaseUrl);
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

// NOTE: PostgREST range-pagination is nondeterministic without a stable
// ORDER BY — pages can repeat/skip rows. Always order by a unique column.
async function fetchAll(query, pageSize = 1000, orderColumn = 'id') {
  let rows = [];
  const ordered = orderColumn ? query.order(orderColumn, { ascending: true }) : query;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await ordered.range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    rows = rows.concat(data || []);
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

function getSupabase() {
  const url = process.env.DEST_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.DEST_SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase not configured');
  return { supabase: createClient(url, key, { auth: { persistSession: false } }), supabaseUrl: url };
}

async function loadSeedSetting(supabase, key) {
  const { data, error } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('tenant_id', GSF_TENANT_ID)
    .eq('setting_key', key)
    .maybeSingle();
  if (error) throw new Error(`Failed loading ${key}: ${error.message}`);
  if (!data || !data.setting_value) return {};
  try {
    return JSON.parse(data.setting_value);
  } catch {
    return {};
  }
}

/**
 * Load everything both endpoints need in one pass:
 * current member orgs (filtered), their preference values, contacts,
 * sync mapping and the Zoho-legacy seeds.
 */
export async function loadGsfMapData() {
  const { supabase, supabaseUrl } = getSupabase();

  const [mappingRow, orgs, countryLookup, countryRowIds, orgLegacy] = await Promise.all([
    supabase
      .from('zoho_crm_sync_mapping')
      .select('field_mappings')
      .eq('tenant_id', GSF_TENANT_ID)
      .eq('entity_type', 'organization')
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) throw new Error(`Failed loading sync mapping: ${error.message}`);
        return data;
      }),
    fetchAll(
      supabase
        .from('organization')
        .select('id, name, zoho_crm_id, logo_url, phone, website_url, created_at, updated_at, status, is_sample')
        .eq('tenant_id', GSF_TENANT_ID)
        .order('name', { ascending: true })
    ),
    loadSeedSetting(supabase, SETTING_COUNTRY_LOOKUP),
    loadSeedSetting(supabase, SETTING_COUNTRY_ROW_IDS),
    loadSeedSetting(supabase, SETTING_ORG_LEGACY)
  ]);

  const fieldMappings = mappingRow?.field_mappings || [];

  // Every custom field id referenced by the mapping plus the derived fields.
  const neededFieldIds = new Set(Object.values(FIELD_IDS));
  for (const m of fieldMappings) {
    if (m.iconnect_field && m.iconnect_field.startsWith('custom:')) {
      neededFieldIds.add(m.iconnect_field.slice('custom:'.length));
    }
  }

  const prefRows = await fetchAll(
    supabase
      .from('organization_preference_value')
      .select('organization_id, field_id, value')
      .in('field_id', [...neededFieldIds])
  );
  // orgId -> fieldId -> value
  const prefByOrg = new Map();
  for (const r of prefRows) {
    let m = prefByOrg.get(r.organization_id);
    if (!m) prefByOrg.set(r.organization_id, (m = {}));
    m[r.field_id] = r.value;
  }

  const memberRows = await fetchAll(
    supabase
      .from('member')
      .select('id, organization_id, first_name, last_name, email, job_title, created_on')
      .eq('tenant_id', GSF_TENANT_ID)
  );
  const ceoRows = await fetchAll(
    supabase
      .from('member_preference_value')
      .select('member_id, value')
      .eq('field_id', FIELD_IDS.ceo_flag)
  );

  // Published DD document copies (documents/published/...) — the stable
  // public logo source used when org.logo_url is a signed private URL.
  const publishedDocs = await fetchAll(
    supabase
      .from('submission_document')
      .select('form_submission_id, public_file_url, status, is_current_version, created_at')
      .eq('tenant_id', GSF_TENANT_ID)
      .not('public_file_url', 'is', null)
  );
  const publishedLogoByOrg = new Map();
  const docSubIds = [...new Set(publishedDocs.map((d) => d.form_submission_id).filter(Boolean))];
  if (docSubIds.length) {
    const { data: subs, error: subErr } = await supabase
      .from('form_submission')
      .select('id, organization_id, created_organization_id')
      .in('id', docSubIds);
    if (subErr) throw new Error(`Failed loading form submissions: ${subErr.message}`);
    const subToOrg = new Map(
      (subs || []).map((s) => [s.id, s.organization_id || s.created_organization_id])
    );
    const sorted = publishedDocs
      .filter((d) => d.status === 'approved' && d.is_current_version !== false)
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    for (const d of sorted) {
      const orgId = subToOrg.get(d.form_submission_id);
      if (orgId && !publishedLogoByOrg.has(orgId)) {
        publishedLogoByOrg.set(orgId, d.public_file_url);
      }
    }
  }
  const ceoIds = new Set(
    ceoRows.filter((r) => String(r.value).toLowerCase() === 'true').map((r) => r.member_id)
  );
  const membersByOrg = new Map();
  for (const m of memberRows) {
    if (!m.organization_id) continue;
    const list = membersByOrg.get(m.organization_id) || [];
    list.push(m);
    membersByOrg.set(m.organization_id, list);
  }
  for (const list of membersByOrg.values()) {
    list.sort((a, b) => String(a.created_on || '').localeCompare(String(b.created_on || '')));
  }

  // Membership filter: org_status Active + org_type SO/ESO (the two fields
  // behind Zoho's Lifecycle_Status="Current" / Account_Type member values).
  const memberOrgs = orgs.filter((o) => {
    if (o.is_sample) return false;
    if (o.status && !['active'].includes(String(o.status).toLowerCase())) return false;
    const prefs = prefByOrg.get(o.id) || {};
    const st = String(prefs[FIELD_IDS.org_status] || '').trim();
    const ty = String(prefs[FIELD_IDS.org_type] || '').trim();
    return st === 'Active' && (ty === 'SO' || ty === 'ESO');
  });

  return {
    supabaseUrl,
    fieldMappings,
    orgs,
    memberOrgs,
    prefByOrg,
    membersByOrg,
    ceoIds,
    publishedLogoByOrg,
    countryLookup,
    countryRowIds,
    orgLegacy
  };
}

// ---------------------------------------------------------------------------
// Members payload
// ---------------------------------------------------------------------------

const asStr = (v) => (v === undefined || v === null || v === '' ? null : String(v));

export function buildMembersPayload(data) {
  const {
    supabaseUrl, fieldMappings, memberOrgs, prefByOrg,
    membersByOrg, ceoIds, publishedLogoByOrg, orgLegacy
  } = data;

  return memberOrgs.map((org) => {
    const prefs = prefByOrg.get(org.id) || {};
    const zohoId = org.zoho_crm_id || org.id;
    const legacy = orgLegacy[org.zoho_crm_id] || orgLegacy[org.id] || {};

    const contacts = membersByOrg.get(org.id) || [];
    const poc = contacts[0] || null;
    const ceo = contacts.find((m) => ceoIds.has(m.id)) || null;

    const record = {};

    // 1) Sync-mapped fields (38) — same outbound translation as the sync.
    for (const m of fieldMappings) {
      if (!m.zoho_field || !m.iconnect_field) continue;
      let raw;
      if (m.iconnect_field.startsWith('custom:')) {
        raw = prefs[m.iconnect_field.slice('custom:'.length)];
      } else {
        raw = org[m.iconnect_field];
      }
      record[m.zoho_field] = formatMappedValue(m, raw);
    }

    // 2) Derived fields.
    record.id = zohoId;
    record.Org_logo_URL = resolveLogoUrl(org, publishedLogoByOrg, supabaseUrl);
    record.Lifecycle_Status = 'Current';

    const mts = asStr(prefs[FIELD_IDS.member_type_sub_category]);
    record.Member_Type_Sub_category = mts ? [mts] : [];

    record.Account_ID_Number = legacy.account_id_number ?? null;
    record.Country = asStr(prefs[FIELD_IDS.hq_location]);

    const ye = asStr(prefs[FIELD_IDS.year_established]);
    record.What_year_was_your_organisation_established = ye ? ye.slice(0, 7) : null;

    record.Services_provided_to_partner_schools =
      parseMultiPickValue(prefs[FIELD_IDS.services_provided]) || [];

    record.Please_select_the_category_that_best_describes_you = legacy.category ?? null;
    record.Tag = Array.isArray(legacy.tag) ? legacy.tag : [];

    // Contact-derived fields. Zoho held a linked Contact plus flattened
    // POC_*/CEO_* copies; we emit the org's first linked member as the
    // contact/point-of-contact and the member flagged CEO for CEO_*.
    record.First_Name = asStr(poc?.first_name);
    record.Last_Name = asStr(poc?.last_name);
    record.Email = asStr(poc?.email);
    record.Job_Title = asStr(poc?.job_title);
    const fullName = [poc?.first_name, poc?.last_name].filter(Boolean).join(' ').trim();
    record.Name1 = fullName || null;
    record.POC_First_Name = asStr(poc?.first_name);
    record.POC_Last_Name = asStr(poc?.last_name);
    record.Email_of_point_of_contact = asStr(poc?.email);
    record.Job_title_point_of_contact = asStr(poc?.job_title);
    record.CEO_First_Name = asStr(ceo?.first_name);
    record.CEO_Last_Name = asStr(ceo?.last_name);
    record.Email_of_CEO = asStr(ceo?.email);

    // Timestamps (iConnect created/updated, Zoho time format).
    record.Created_Time = formatZohoTime(org.created_at);
    record.Modified_Time = formatZohoTime(org.updated_at);
    record.Last_Activity_Time = formatZohoTime(org.updated_at || org.created_at);

    // 3) Zoho system constants / legacy nulls (verbatim from reference).
    record.Owner = ZOHO_OWNER;
    record.Created_By = ZOHO_OWNER;
    record.Modified_By = ZOHO_OWNER;
    record.Layout = MEMBERS_LAYOUT;
    record.$layout_id = MEMBERS_LAYOUT;
    record.$approval = APPROVAL_OBJ;
    record.$review_process = { approve: false, reject: false, resubmit: false };
    record.$currency_symbol = '$';
    record.$field_states = null;
    record.$state = 'save';
    record.$process_flow = false;
    record.$locked_for_me = false;
    record.$approved = true;
    record.$editable = true;
    record.$zia_owner_assignment = 'owner_recommendation_unavailable';
    record.$is_duplicate = false;
    record.$review = null;
    record.$orchestration = false;
    record.$in_merge = false;
    record.$approval_state = 'approved';
    record.Locked__s = false;
    record.Record_Image = null;
    record.Contact = null;
    record.Trading_as = null;
    record.If_other_please_describe_your_organisation = null;
    record.If_other_specify_services_provided_to_school = null;
    record.What_services_do_you_provide_to_the_organisations = [];
    record.What_type_of_funder_best_describes_your_organisati = [];

    return record;
  });
}

// ---------------------------------------------------------------------------
// Countries payload
// ---------------------------------------------------------------------------

export function buildCountriesPayload(data) {
  const { fieldMappings, memberOrgs, prefByOrg, countryLookup, countryRowIds } = data;

  // Account_Name may be the plain org name; use the mapped source if present.
  const nameMapping = fieldMappings.find((m) => m.zoho_field === 'Account_Name');

  const rows = [];
  for (const org of memberOrgs) {
    const prefs = prefByOrg.get(org.id) || {};
    const zohoId = org.zoho_crm_id || org.id;
    const orgName = (nameMapping && !nameMapping.iconnect_field.startsWith('custom:')
      ? org[nameMapping.iconnect_field]
      : org.name) || org.name;

    const countries = parseMultiPickValue(prefs[FIELD_IDS.countries_of_operation]) || [];
    const seen = new Set();
    for (const rawName of countries) {
      const zohoName = COUNTRY_NAME_ALIASES[rawName] || rawName;
      if (seen.has(zohoName)) continue;
      seen.add(zohoName);
      const meta = countryLookup[zohoName] || null;
      const rowSeed = countryRowIds[`${org.zoho_crm_id}|${zohoName}`] || null;

      rows.push({
        id: rowSeed?.id || `${zohoId}::${zohoName}`,
        Parent_Id: { name: orgName, id: zohoId },
        Country: { name: zohoName, id: meta?.id ?? null },
        Income_Group: meta?.income_group ?? null,
        GSF_Region_Classification: meta?.region ?? null,
        Flag: meta ? meta.flag : 'Show',
        Created_Time: rowSeed?.created_time || formatZohoTime(org.created_at),
        Layout: COUNTRIES_LAYOUT,
        $layout_id: COUNTRIES_LAYOUT,
        $approval: APPROVAL_OBJ,
        $currency_symbol: '$',
        $field_states: null,
        $review_process: null,
        $editable: true,
        $orchestration: false,
        $review: null,
        $state: 'save',
        $process_flow: false,
        $in_merge: false,
        $approval_state: 'approved',
        $approved: true
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Endpoint helper: auth + cache headers
// ---------------------------------------------------------------------------

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function checkGsfMapAuth(req, res) {
  const secret = process.env.GSF_MAP_API_SECRET;
  if (!secret) {
    res.status(503).json({ error: 'GSF map API not configured' });
    return false;
  }
  const provided =
    req.headers['x-api-key'] ||
    (typeof req.query?.token === 'string' ? req.query.token : null);
  if (!provided || !timingSafeEqualStr(provided, secret)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

export function setGsfMapCacheHeaders(res) {
  // Read-only snapshot polled by a website: allow CDN caching for 5 minutes
  // with stale-while-revalidate so the origin isn't hit on every poll.
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300, stale-while-revalidate=600');
  res.setHeader('Access-Control-Allow-Origin', '*');
}
