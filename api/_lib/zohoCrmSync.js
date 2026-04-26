import crypto from 'crypto';
import { supabase } from './database.js';
import {
  upsertZohoCrmRecord,
  updateZohoCrmRecordById,
  deleteZohoCrmRecord,
  isZohoCrmConnected,
  zohoCrmApiCall,
  searchZohoCrmRecords,
  fetchZohoCrmRecordRichText,
  getZohoCrmModuleFieldTypes,
  getZohoCrmModuleFields
} from './zohoCrmClient.js';

/**
 * Self-heal `is_multi_pick` and `is_rich_text` flags on legacy mapping
 * rows that were saved before the field-type stamping landed (#424).
 *
 * The mapping save endpoint stamps these flags per row from cached Zoho
 * metadata, but rows that haven't been re-saved since the new code
 * shipped are missing both flags entirely. Without `is_multi_pick` the
 * outbound translation falls through to scalar handling, the
 * stringified JSON value `'["A","B"]'` is forwarded unchanged, and
 * Zoho rejects with HTTP 400 INVALID_DATA `expected_data_type:
 * jsonarray` — the exact failure mode #424 was meant to fix.
 *
 * Self-heal: re-resolve the same Sets at sync time from a lightweight
 * single-call `/settings/fields?type=all` lookup (#430), then mutate
 * `mapping.field_mappings[i]` in-place to set the missing flags. The
 * save endpoint still uses the heavier `getZohoCrmModuleFields` source
 * to populate the admin dropdown, but the runtime path here only needs
 * `data_type` per `api_name` — and multi-pick (the bug we have to fix)
 * is always present in `/settings/fields`. Persisted-flag rows still
 * take the fast path; this only adds work for rows where the flag is
 * absent.
 *
 * Best-effort: any failure logs a warning and returns silently —
 * downstream code falls back to today's persisted-flag-only behaviour
 * (no regression for working tenants). The metadata fetch is cached
 * for 5 minutes per tenant+module so the cost in steady state is a
 * memory map lookup, not an HTTP round-trip.
 */
// Derived-flag memo: caches the (multiPickSet, richTextSet) tuple per
// tenant+module for the same 5-minute TTL as the upstream
// `fieldTypesCache` so the per-record reconciliation path doesn't
// re-scan the field list on every inbound apply.
const derivedFlagSetsCache = new Map();
const DERIVED_FLAG_SETS_TTL_MS = 5 * 60 * 1000;

/**
 * Invalidate the derived-flag memo. Mirrors the
 * `clearZohoCrmModuleFieldsCache` shape exposed by `zohoCrmClient.js`:
 *  - call with `(tenantId, module)` to drop one entry,
 *  - call with `(tenantId)` to drop every entry for one tenant,
 *  - call with no args to clear the whole cache.
 *
 * Used by the mapping save endpoint and the one-off mapping-migration
 * tooling (`scripts/migrate-zoho-overview.mjs` via the
 * `/api/admin/zoho-crm-sync/invalidate-mapping-cache` endpoint) so a
 * mapping flip takes effect on the very next sync without waiting for
 * the 5-minute TTL or restarting the running app.
 */
export function clearZohoCrmDerivedFlagSetsCache(tenantId, zohoModule) {
  if (!tenantId) {
    derivedFlagSetsCache.clear();
    return;
  }
  if (!zohoModule) {
    const prefix = `${tenantId}::`;
    for (const k of derivedFlagSetsCache.keys()) {
      if (k.startsWith(prefix)) derivedFlagSetsCache.delete(k);
    }
    return;
  }
  derivedFlagSetsCache.delete(`${tenantId}::${zohoModule}`);
}

async function getDerivedFlagSets(tenantId, zohoModule) {
  const key = `${tenantId}::${zohoModule}`;
  const cached = derivedFlagSetsCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.sets;
  // #430: use the lightweight single-call lookup instead of the heavy
  // `getZohoCrmModuleFields` (which adds 5–9 HTTP round-trips and was
  // starving the fire-and-forget Vercel sync before the actual record
  // write could run). Multi-pick — the bug we have to fix here — is
  // always present in `/settings/fields`, so the lightweight path is
  // sufficient for self-heal.
  const moduleFieldTypes = await getZohoCrmModuleFieldTypes(tenantId, zohoModule);
  if (!moduleFieldTypes || moduleFieldTypes.size === 0) return null;
  const multiPickSet = new Set();
  const richTextSet = new Set();
  // #463: also collect plain-picklist field names and per-field picklist
  // option sets so the outbound dash canonicaliser can decide whether a
  // hyphen→en-dash swap matches a known Zoho option. #472: the option
  // set is now Zoho `display_value` strings (the wire-format identifier),
  // not `actual_value` — see `getZohoCrmModuleFieldTypes`.
  const picklistSet = new Set();
  const picklistOptionsByField = new Map();
  for (const [apiName, info] of moduleFieldTypes) {
    const dataType = info?.dataType ?? info; // tolerate legacy string shape
    const pickListValues = info?.pickListValues || null;
    const dt = String(dataType || '').toLowerCase();
    if (/rich/i.test(dt)) richTextSet.add(apiName);
    if (dt.includes('multi')) {
      multiPickSet.add(apiName);
    } else if (dt === 'picklist') {
      picklistSet.add(apiName);
    }
    if (pickListValues && pickListValues.size > 0) {
      picklistOptionsByField.set(apiName, pickListValues);
    }
  }
  const sets = { multiPickSet, richTextSet, picklistSet, picklistOptionsByField };
  derivedFlagSetsCache.set(key, { sets, expiresAt: Date.now() + DERIVED_FLAG_SETS_TTL_MS });
  return sets;
}

async function enrichMappingFlagsFromMetadata(tenantId, mapping) {
  if (!mapping || !mapping.zoho_module || !Array.isArray(mapping.field_mappings)) return;
  // Always resolve picklist option sets in-memory so the outbound dash
  // canonicaliser (#463) can use them regardless of whether the persisted
  // is_* flags are already populated. Cheap: a single cached metadata
  // lookup per (tenant, module) per 5 minutes. Persisted-flag rows still
  // take the fast path for is_multi_pick / is_rich_text / is_picklist —
  // we only stamp those when missing.
  let sets;
  try {
    sets = await getDerivedFlagSets(tenantId, mapping.zoho_module);
  } catch (err) {
    console.warn('[ZohoCrmSync] Could not resolve field-type flags from Zoho metadata at sync time — falling back to persisted flags only:', err?.message || err);
  }
  if (sets) {
    const { multiPickSet, richTextSet, picklistSet, picklistOptionsByField } = sets;
    for (const m of mapping.field_mappings) {
      if (!m?.zoho_field) continue;
      if (m.is_multi_pick !== true && multiPickSet.has(m.zoho_field)) {
        m.is_multi_pick = true;
      }
      if (m.is_rich_text !== true && richTextSet.has(m.zoho_field)) {
        m.is_rich_text = true;
      }
      if (m.is_picklist !== true && picklistSet.has(m.zoho_field)) {
        m.is_picklist = true;
      }
      // Stamp per-row picklist option set in-memory (NEVER persisted —
      // mappings.js only writes the explicit allowlist of keys). Used by
      // `applyMappingValueOutbound` to canonicalise dash-style drift on
      // outbound picklist values (#463).
      const opts = picklistOptionsByField.get(m.zoho_field);
      if (opts && opts.size > 0) {
        m._picklistOptions = opts;
      }
    }
  }

  // #468: stamp `_iconnectOptionAliases` for every `custom:<id>` mapping
  // row so `applyValueMap` can resolve a stored value to its canonical
  // shape even when the value_map was authored against a different shape
  // (e.g. the value_map keys are option labels but the entity stores the
  // option `value`). Without this the lookup misses, `applyValueMap`
  // returns the raw value unchanged, and the picklist-omit guard in
  // `applyMappingValueOutbound` then drops the field — leaving Zoho to
  // substitute its field default.
  await enrichMappingIconnectOptionAliases(tenantId, mapping);
}

/**
 * Build a per-`custom:` mapping-row alias map: every alternate shape of
 * a preference_field option (id, name, key, label, value — coerced to
 * string) → the canonical value resolved by `deriveCustomAllowedValues`.
 *
 * Stamped on `mapping.field_mappings[i]._iconnectOptionAliases` as a
 * `Map<altKey, canonicalValue>`. NEVER persisted. Used by `applyValueMap`
 * as the final fallback after direct + dash-equivalent + case-insensitive
 * lookups against `value_map[direction]` keys.
 *
 * Best-effort: a single batched query per sync. Failure is non-fatal —
 * the lookup just falls through to today's behaviour.
 */
async function enrichMappingIconnectOptionAliases(tenantId, mapping) {
  if (!tenantId || !mapping?.entity_type || !Array.isArray(mapping.field_mappings)) return;
  const customFieldIds = [];
  for (const m of mapping.field_mappings) {
    if (typeof m?.iconnect_field !== 'string') continue;
    if (!m.iconnect_field.startsWith('custom:')) continue;
    const fieldId = m.iconnect_field.slice('custom:'.length);
    if (fieldId) customFieldIds.push(fieldId);
  }
  if (customFieldIds.length === 0) return;
  try {
    const { data, error } = await supabase
      .from('preference_field')
      .select('id, name, label, field_type, options')
      .eq('tenant_id', tenantId)
      .in('id', [...new Set(customFieldIds)]);
    if (error) {
      console.warn('[ZohoCrmSync] Could not load preference_field for option-alias enrichment:', error.message);
      return;
    }
    const byId = new Map((data || []).map(r => [r.id, r]));
    for (const m of mapping.field_mappings) {
      if (typeof m?.iconnect_field !== 'string') continue;
      if (!m.iconnect_field.startsWith('custom:')) continue;
      const fieldId = m.iconnect_field.slice('custom:'.length);
      const field = byId.get(fieldId);
      if (!field) continue;
      const opts = Array.isArray(field.options) ? field.options : null;
      if (!opts || opts.length === 0) continue;
      const aliases = new Map();
      for (const opt of opts) {
        if (opt == null) continue;
        if (typeof opt === 'string' || typeof opt === 'number') continue;
        if (typeof opt !== 'object') continue;
        // Same canonical-value resolution as `deriveCustomAllowedValues`
        // (id intentionally excluded so a UUID-only option contributes
        // nothing to the alias map — it would just point UUID → UUID).
        const canonical = opt.value ?? opt.key ?? opt.name ?? opt.label;
        if (canonical == null) continue;
        const canonicalStr = String(canonical);
        // Map every alternate shape (including id) to canonical so a
        // value_map keyed by the legacy id-form still resolves to the
        // option that the user-facing form now stores.
        for (const k of [opt.value, opt.key, opt.name, opt.label, opt.id]) {
          if (k == null) continue;
          const ks = String(k);
          if (ks === '') continue;
          if (!aliases.has(ks)) aliases.set(ks, canonicalStr);
        }
      }
      if (aliases.size > 0) m._iconnectOptionAliases = aliases;
    }
  } catch (err) {
    console.warn('[ZohoCrmSync] preference_field alias enrichment threw:', err?.message || err);
  }
}

/**
 * Merge a record's rich-text field values into the record JSON before the
 * normal field-mapping pipeline runs. Zoho excludes rich-text fields from
 * the regular `GET /{module}/{id}` payload — without this enrichment any
 * mapping that targets a rich-text field arrives with `null` and overwrites
 * good iConnect data with empty.
 *
 * Gating is read-only: the mapping save endpoint (`api/admin/zoho-crm-sync/
 * mappings.js`) stamps `is_rich_text: true` on each field-mapping row whose
 * Zoho field is rich-text. Here we only check that flag — no live metadata
 * call — so mappings without any rich-text fields incur ZERO extra Zoho API
 * calls per inbound record. Already-populated values short-circuit the per-
 * field fetch (handles the case where a future Zoho behaviour starts
 * inlining rich-text in the regular payload). Per-record rich-text fetch
 * failures are non-fatal: warn + continue, leave the field null.
 */
/**
 * Normalise an HTML-ish rich-text value for the post-write verification
 * comparator. Strips a single outer `<div>`/`<p>` wrapper (Zoho's
 * WYSIWYG often re-wraps content with one of its own), collapses runs
 * of whitespace to a single space, normalises `&nbsp;` ↔ space, decodes
 * the basic HTML entities (`&lt;`, `&gt;`, `&amp;`, `&quot;`, `&#39;`)
 * so a Zoho-side encode/decode of literal punctuation doesn't trip the
 * comparator, and trims. This filters out cosmetic diffs (re-wrapping,
 * attribute reordering, whitespace, entity-encoding round-trips) so the
 * strict-equality check downstream only fires on real content drift.
 */
function verificationNormaliseRichText(value) {
  if (value == null) return '';
  let s = String(value);
  // Strip exactly one outer <div>...</div> or <p>...</p> wrapper if the
  // entire value is wrapped — Zoho's WYSIWYG often re-wraps content with
  // a <p> on round-trip even when we sent bare text or a <div>.
  const wrapped = s.match(/^\s*<(div|p)\b[^>]*>([\s\S]*)<\/\1>\s*$/i);
  if (wrapped) s = wrapped[2];
  // Decode the basic HTML entities so a Zoho-side encode/decode of literal
  // `<`, `>`, `&`, `"`, `'` doesn't trip the comparator. Order matters:
  // decode `&amp;` last so we don't double-decode pre-encoded `&amp;lt;`.
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
  // Collapse <br>/<br/> to newline-equivalent space, then collapse all
  // whitespace runs (including the converted br) to a single space.
  s = s.replace(/<br\s*\/?>/gi, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Truncate a string for inclusion in mismatch payloads / toast suffixes.
 * Returns the string itself when short enough, otherwise the first
 * `maxLen` chars followed by an ellipsis. JSON.stringify-safe.
 */
function previewForMismatch(value, maxLen = 120) {
  if (value == null) return '';
  const s = String(value);
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '…';
}

async function enrichRecordWithRichText(tenantId, mapping, zohoModule, zohoRecord) {
  if (!zohoRecord || typeof zohoRecord !== 'object') return zohoRecord;
  const fieldMappings = Array.isArray(mapping?.field_mappings) ? mapping.field_mappings : [];
  if (fieldMappings.length === 0) return zohoRecord;
  const wanted = fieldMappings
    .filter(m => m?.is_rich_text === true && m.zoho_field)
    .map(m => m.zoho_field);
  if (wanted.length === 0) return zohoRecord;
  const recordId = zohoRecord.id || zohoRecord.Id;
  if (!recordId) return zohoRecord;
  const missing = wanted.filter(name => zohoRecord[name] == null || zohoRecord[name] === '');
  if (missing.length === 0) return zohoRecord;
  try {
    const rt = await fetchZohoCrmRecordRichText(tenantId, zohoModule, recordId, missing);
    return { ...zohoRecord, ...rt };
  } catch (err) {
    console.warn('[ZohoCrmSync] Rich-text fetch failed for', zohoModule, recordId, '-', err?.message || err);
    return zohoRecord;
  }
}

const ENTITY_TABLE = {
  member: 'member',
  organization: 'organization'
};

const PREF_VALUE_TABLE = {
  member: 'member_preference_value',
  organization: 'organization_preference_value'
};

const PREF_VALUE_FK = {
  member: 'member_id',
  organization: 'organization_id'
};

const ECHO_DEBOUNCE_MS = 30 * 1000;

// In-memory tracker of entities recently written by an inbound Zoho sync.
// Any outbound sync triggered for the same entity within the TTL is short-
// circuited regardless of who calls `triggerZohoCrmSync`. This is the
// first-line origin-loop guard; the payload-hash debounce is the second.
const inboundOriginTracker = new Map();
const INBOUND_ORIGIN_TTL_MS = 30 * 1000;

function inboundOriginKey(tenantId, entityType, entityId) {
  return `${tenantId}:${entityType}:${entityId}`;
}

function markInboundOrigin(tenantId, entityType, entityId) {
  if (!tenantId || !entityType || !entityId) return;
  const key = inboundOriginKey(tenantId, entityType, entityId);
  inboundOriginTracker.set(key, Date.now() + INBOUND_ORIGIN_TTL_MS);
}

function hasInboundOrigin(tenantId, entityType, entityId) {
  const key = inboundOriginKey(tenantId, entityType, entityId);
  const expiresAt = inboundOriginTracker.get(key);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    inboundOriginTracker.delete(key);
    return false;
  }
  return true;
}

// Periodic cleanup to keep the tracker bounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of inboundOriginTracker) {
    if (now > exp) inboundOriginTracker.delete(k);
  }
}, 60 * 1000).unref?.();

function computeHash(obj) {
  try {
    const normalized = JSON.stringify(sortKeys(obj || {}));
    return crypto.createHash('sha256').update(normalized).digest('hex');
  } catch {
    return null;
  }
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, k) => {
      acc[k] = sortKeys(value[k]);
      return acc;
    }, {});
  }
  return value;
}

async function loadEntity(tenantId, entityType, entityId) {
  const table = ENTITY_TABLE[entityType];
  if (!table) throw new Error(`Unsupported entity type: ${entityType}`);
  const { data, error } = await supabase
    .from(table)
    .select('*')
    .eq('id', entityId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function loadCustomFieldValues(tenantId, entityType, entityId) {
  const table = PREF_VALUE_TABLE[entityType];
  const fk = PREF_VALUE_FK[entityType];
  if (!table || !fk) return {};
  const { data, error } = await supabase
    .from(table)
    .select('field_id, value, preference_field:field_id(id, label, name)')
    .eq(fk, entityId);
  if (error) {
    console.error('[ZohoCrmSync] Failed to load custom values:', error);
    return {};
  }
  const result = {};
  for (const row of data || []) {
    if (row.field_id) result[row.field_id] = row.value;
  }
  return result;
}

function resolveMappedValue(mapping, entity, customValues) {
  const src = mapping.iconnect_field;
  if (!src) return undefined;
  if (src.startsWith('custom:')) {
    const fieldId = src.slice('custom:'.length);
    return customValues[fieldId];
  }
  return entity?.[src];
}

// Best-effort human-readable label for an entity surfaced in
// remediation samples (organisation name, member full name, etc).
function describeEntityForRemediationSample(entityType, entity) {
  if (!entity) return null;
  if (entityType === 'organization') return entity.name || null;
  if (entityType === 'member') {
    const composed = [entity.first_name, entity.last_name].filter(Boolean).join(' ').trim();
    return composed || entity.email || entity.name || null;
  }
  return null;
}

// #463 dash normalisation. Zoho picklist options frequently use the en-dash
// (`–`, U+2013) — e.g. `Member – Education Support Organisations` — while
// the same logical value typed into iConnect comes off the keyboard as a
// plain hyphen (`-`, U+002D). The strict string comparison used by the
// one-time import treated these as different, pushed iConnect's hyphen up
// to Zoho, and overwrote the canonical picklist value on every Account.
//
// Two helpers:
//   - `normalizeDashesForCompare`: collapse hyphen / en-dash / em-dash to
//     the same character (we pick the plain hyphen) so equality checks
//     and value_map lookups match across dash styles. Used for COMPARISON
//     ONLY — it never changes what we send on the wire.
//   - `normalizeDashesToEnDash`: rewrite hyphen / em-dash to en-dash. Used
//     by the outbound picklist canonicaliser as the safe-by-default
//     fallback when no Zoho picklist metadata is available (the common
//     Zoho convention is en-dash for these options).
const DASH_VARIANTS_RE = /[\u002D\u2013\u2014]/g;
export function normalizeDashesForCompare(s) {
  if (typeof s !== 'string') return s;
  return s.replace(DASH_VARIANTS_RE, '-');
}
export function normalizeDashesToEnDash(s) {
  if (typeof s !== 'string') return s;
  return s.replace(DASH_VARIANTS_RE, '\u2013');
}
function dashEquivalent(a, b) {
  if (a === b) return true;
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return normalizeDashesForCompare(a) === normalizeDashesForCompare(b);
}

/**
 * Pick the Zoho-canonical form of `value` for a picklist / multi-pick
 * outbound push (#463). Order:
 *   1. If metadata enumerates the picklist options for this field and
 *      `value` is already an exact option → keep as-is.
 *   2. If a known option matches `value` under dash-equivalence (only
 *      hyphen/en-dash/em-dash differ) → return that exact option string.
 *      This is the metadata-aware path that fixes the original bug
 *      without risk of mutating non-dash content.
 *   3. If no metadata is available → fall back to a generic
 *      hyphen→en-dash rewrite. Idempotent for values that are already
 *      en-dashed or have no dashes; mirrors the dominant Zoho
 *      convention. `value_map` remains the override for tenants whose
 *      picklist legitimately uses hyphens.
 */
function canonicalizePicklistOptionForOutbound(options, value) {
  if (typeof value !== 'string' || value === '') return value;
  if (options && options.size > 0) {
    if (options.has(value)) return value;
    const compareValue = normalizeDashesForCompare(value);
    for (const opt of options) {
      if (normalizeDashesForCompare(opt) === compareValue) return opt;
    }
    // Value not in the picklist at all — Zoho will likely reject. Send
    // unchanged so the failure surfaces visibly rather than silently
    // mutating to a different option.
    return value;
  }
  return normalizeDashesToEnDash(value);
}

/**
 * Apply a per-row value translation in the requested direction. Returns the
 * translated value when a mapping exists, otherwise the original value. When
 * the row has a value_map but the value is not in it, push a warning entry
 * onto `warnings` so the caller can surface unmapped values to the sync log.
 *
 * Operates on a single scalar — `applyMappingValue` (below) handles the
 * multi-pick case by parsing into an array first and calling this per
 * element so each unmapped element generates its own warning row.
 */
function applyValueMap(mapping, value, direction, warnings, info) {
  // `info`, when provided, is mutated to record how the lookup
  // resolved (`hit`: 'direct' | 'dash' | 'ci' | 'alias' | null).
  // Used by `buildPayload` to emit accurate `value_map_hit`
  // breadcrumbs that reflect the actual resolution path, not just
  // whether the raw key happens to be a direct value_map entry.
  if (info && typeof info === 'object') info.hit = null;
  if (value === undefined || value === null || value === '') return value;
  const vm = mapping?.value_map;
  if (!vm || typeof vm !== 'object') return value;
  const dir = direction === 'iconnect_to_zoho' ? vm.iconnect_to_zoho : vm.zoho_to_iconnect;
  if (!dir || typeof dir !== 'object' || Object.keys(dir).length === 0) return value;
  const key = String(value);
  if (Object.prototype.hasOwnProperty.call(dir, key)) {
    if (info && typeof info === 'object') info.hit = 'direct';
    return dir[key];
  }
  // Dash-equivalent fallback (#463): a value_map keyed by the en-dash
  // canonical form (e.g. `Member – ...`) should also satisfy a lookup
  // for the hyphen variant that arrives from iConnect, and vice-versa.
  // Avoids needing two entries per option.
  const compareKey = normalizeDashesForCompare(key);
  if (compareKey !== key) {
    for (const k of Object.keys(dir)) {
      if (normalizeDashesForCompare(k) === compareKey) {
        if (info && typeof info === 'object') info.hit = 'dash';
        return dir[k];
      }
    }
  }
  // #468: case-insensitive trimmed fallback. A value_map keyed by
  // `ESO` should still satisfy a stored value of ` eso ` so admins
  // don't have to author per-casing entries (Zoho options are stored
  // case-sensitively but iConnect form values often arrive with
  // surface-only differences).
  const ciKey = key.trim().toLowerCase();
  if (ciKey && ciKey !== key) {
    for (const k of Object.keys(dir)) {
      if (typeof k === 'string' && k.trim().toLowerCase() === ciKey) {
        if (info && typeof info === 'object') info.hit = 'ci';
        return dir[k];
      }
    }
  }
  // #468: alternate-shape fallback (iConnect→Zoho only). When the
  // value_map was authored against one shape of the option (e.g. the
  // option `name`) but the entity stored a different shape (e.g. the
  // option `value`), translate via the alias map stamped at sync time
  // to the canonical shape and retry the lookup once. This recovers
  // mappings whose value_map keys predate the canonical-key migration
  // (`scripts/migrate-picklist-value-map-keys.mjs`) without needing the
  // migration to have run yet.
  if (direction === 'iconnect_to_zoho' && mapping?._iconnectOptionAliases instanceof Map) {
    const canonical = mapping._iconnectOptionAliases.get(key);
    if (canonical && canonical !== key) {
      if (Object.prototype.hasOwnProperty.call(dir, canonical)) {
        if (info && typeof info === 'object') info.hit = 'alias';
        return dir[canonical];
      }
      const canonicalCompare = normalizeDashesForCompare(canonical);
      if (canonicalCompare !== canonical) {
        for (const k of Object.keys(dir)) {
          if (normalizeDashesForCompare(k) === canonicalCompare) {
            if (info && typeof info === 'object') info.hit = 'alias';
            return dir[k];
          }
        }
      }
    }
  }
  if (Array.isArray(warnings)) {
    warnings.push({
      direction,
      iconnect_field: mapping.iconnect_field,
      zoho_field: mapping.zoho_field,
      unmapped_value: key
    });
  }
  return value;
}

/**
 * Coerce any stored representation of a multi-pick value into an actual JS
 * array of scalar elements. Accepts:
 *   - A real array → returned as-is (with empty/null elements stripped).
 *   - A JSON-encoded array string (e.g. `'["A","B"]'`) → parsed and returned.
 *   - A comma-separated string (e.g. `'A,B'`) → split and trimmed (this is
 *     Zoho's older serialisation for Multi-Select Lookup Fields and the
 *     fallback when iConnect's preference_value column predates JSON
 *     storage). Empty pieces are dropped.
 *   - Any single scalar (string/number) → wrapped as a one-element array.
 *   - null/undefined/empty-string → `null` (caller should drop the field).
 *
 * Always returns either `null` or an array of strings. The array is never
 * empty: an empty array round-trips through Zoho as a clear, which we want
 * — empty arrays are passed through, not silently dropped, so the caller
 * can decide whether the iConnect intent was "clear all values".
 */
function parseMultiPickValue(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (Array.isArray(raw)) {
    const cleaned = raw
      .filter(v => v !== undefined && v !== null && v !== '')
      .map(v => String(v));
    return cleaned;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed
            .filter(v => v !== undefined && v !== null && v !== '')
            .map(v => String(v));
        }
      } catch {
        // fall through to comma-split fallback
      }
    }
    if (trimmed.includes(',')) {
      return trimmed
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    }
    return [trimmed];
  }
  return [String(raw)];
}

/**
 * Outbound translation for a single mapping row. Routes through
 * `parseMultiPickValue` + per-element `applyValueMap` for multi-pick
 * mapping rows (so each unmapped element generates its own warning),
 * otherwise behaves identically to the scalar `applyValueMap` so plain
 * picklist / text / number fields are unchanged.
 *
 * Returns the value to write to Zoho (`undefined` to drop the field). For
 * multi-pick this is always an actual JS array — the wire layer must
 * NOT JSON-encode it back to a string or Zoho rejects with HTTP 400
 * INVALID_DATA `expected_data_type: jsonarray`.
 */
function applyMappingValueOutbound(mapping, raw, warnings, infoOut) {
  // #463: for picklist / multi-picklist field types, normalise dash
  // style to whatever Zoho's actual picklist option uses (or fall back
  // to en-dash when metadata is unavailable). Plain text / number /
  // date / boolean fields pass through unchanged. The picklist option
  // set is stamped in-memory by `enrichMappingFlagsFromMetadata`.
  //
  // `infoOut`, when provided, is mutated to record:
  //   - `value_map_hit`: did the value_map lookup actually resolve via
  //     direct/dash/ci/alias path (true), miss entirely (false), or was
  //     skipped because the value_map is empty / value is empty (null)?
  //   - `kept_count`, `omitted_count`: per-element accounting for
  //     multi-pick fields so the breadcrumb panel can show partial drops.
  const isPicklistLike = mapping?.is_multi_pick === true || mapping?.is_picklist === true;
  const opts = mapping?._picklistOptions;
  const finalize = (translated) => {
    if (!isPicklistLike) return translated;
    return canonicalizePicklistOptionForOutbound(opts, translated);
  };
  // #468: when Zoho metadata gives us an authoritative picklist option
  // set, treat anything outside that set as an UNKNOWN value and OMIT
  // it from the outbound payload. Previously we forwarded the unknown
  // value unchanged — Zoho silently substituted its field default
  // (e.g. `Account_Type → Vendor`) and the override was invisible
  // because the API still returned 2xx. Omitting leaves Zoho's
  // existing value intact and surfaces the gap in the sync log.
  const isKnownPicklistOption = (v) => {
    if (!isPicklistLike) return true;
    if (!opts || opts.size === 0) return true; // metadata unavailable: don't gate
    if (typeof v !== 'string' || v === '') return false;
    if (opts.has(v)) return true;
    const cmp = normalizeDashesForCompare(v);
    for (const opt of opts) {
      if (normalizeDashesForCompare(opt) === cmp) return true;
    }
    return false;
  };
  const recordOmitted = (rawElement, translatedElement) => {
    if (!Array.isArray(warnings)) return;
    warnings.push({
      direction: 'iconnect_to_zoho',
      iconnect_field: mapping.iconnect_field,
      zoho_field: mapping.zoho_field,
      unmapped_value: String(translatedElement ?? rawElement ?? ''),
      reason: 'unknown_picklist_option_omitted',
      ...(translatedElement !== rawElement
        ? { raw_value: rawElement == null ? null : String(rawElement) }
        : {})
    });
  };
  const wantInfo = infoOut && typeof infoOut === 'object';
  if (mapping?.is_multi_pick) {
    const arr = parseMultiPickValue(raw);
    if (arr === null) return undefined;
    // Empty input array means "clear all values" — admins can
    // intentionally clear a multi-pick field. Preserve only if the
    // input was already empty before filtering.
    const inputCount = arr.length;
    let anyHit = false;
    let anyAttempt = false;
    const out = [];
    for (const v of arr) {
      const probe = wantInfo ? { hit: null } : null;
      const translated = finalize(applyValueMap(mapping, v, 'iconnect_to_zoho', warnings, probe));
      if (probe && probe.hit) anyHit = true;
      if (v !== undefined && v !== null && v !== '') anyAttempt = true;
      if (!isKnownPicklistOption(translated)) {
        recordOmitted(v, translated);
        continue;
      }
      out.push(translated);
    }
    if (wantInfo) {
      infoOut.value_map_hit = anyAttempt ? anyHit : null;
      infoOut.kept_count = out.length;
      infoOut.omitted_count = inputCount - out.length;
    }
    // CRITICAL (#468): if the input had elements but every single one
    // was unmappable / unknown, OMIT the field entirely. Returning `[]`
    // here would tell Zoho to clear the multi-pick — silently
    // overwriting whatever value Zoho currently holds. Only return `[]`
    // when the input was already empty (intentional clear).
    if (inputCount > 0 && out.length === 0) return undefined;
    return out;
  }
  if (raw === undefined || raw === null || raw === '') {
    if (wantInfo) {
      infoOut.value_map_hit = null;
      infoOut.kept_count = 0;
      infoOut.omitted_count = 0;
    }
    return undefined;
  }
  const probe = wantInfo ? { hit: null } : null;
  const translated = finalize(applyValueMap(mapping, raw, 'iconnect_to_zoho', warnings, probe));
  if (wantInfo) {
    infoOut.value_map_hit = probe && probe.hit ? true : false;
  }
  if (!isKnownPicklistOption(translated)) {
    recordOmitted(raw, translated);
    if (wantInfo) {
      infoOut.kept_count = 0;
      infoOut.omitted_count = 1;
    }
    return undefined;
  }
  if (wantInfo) {
    infoOut.kept_count = 1;
    infoOut.omitted_count = 0;
  }
  return translated;
}

// Zoho CRM rejects the entire PUT payload with HTTP 400 INVALID_DATA when
// any single text field exceeds its `maximum_length` (e.g.
// `Schools_demographic` is capped at 255 chars in some tenants). One bad
// field kills every other backfilled / overwritten field on the same
// record, so the offenders never get persisted and re-appear on the next
// import run. We clamp string-like values at push time using the cached
// `getZohoCrmModuleFields` metadata so mapping-row state stays neutral
// (a length change in Zoho takes effect on the next 5-min cache miss
// rather than requiring an admin to re-save mappings). Picklist /
// multi-pick / lookup / date / boolean / numeric fields are skipped —
// Zoho's `length` for those is the on-the-wire string size, not a
// truncate-able limit, and clamping a picklist value would silently
// corrupt the mapped option.
const CLAMPABLE_DATA_TYPES = new Set([
  'text',
  'textarea',
  'phone',
  'email',
  'website',
  'url'
]);
function isClampableDataType(dataType) {
  if (!dataType) return false;
  return CLAMPABLE_DATA_TYPES.has(String(dataType).toLowerCase());
}

/**
 * Clamp `value` to `field.length` if the field's data_type is a string-
 * like type with a defined max length. Returns `{ value, truncated }`
 * where `truncated` is `null` when no clamp happened or
 * `{ original_length, max_length }` when the value was shortened.
 *
 * For multi-pick the elements are clamped independently — Zoho's per-
 * element length cap applies to each picklist value, not the joined
 * payload. Picklist-style multi-pick is excluded here because
 * `is_multi_pick` mappings always go through `applyMappingValueOutbound`
 * which produces an array of mapped picklist values; if a tenant
 * happens to have a free-text-multi field configured, the per-element
 * clamp keeps each entry within the metadata length while preserving
 * array shape.
 */
function clampValueToZohoLength(field, value) {
  if (!field || value === undefined || value === null) return { value, truncated: null };
  const maxLength = Number(field.length);
  if (!Number.isFinite(maxLength) || maxLength <= 0) return { value, truncated: null };
  if (!isClampableDataType(field.data_type)) return { value, truncated: null };
  if (Array.isArray(value)) {
    let anyTruncated = false;
    let maxOriginal = 0;
    const next = value.map(v => {
      if (typeof v !== 'string') return v;
      if (v.length > maxLength) {
        anyTruncated = true;
        if (v.length > maxOriginal) maxOriginal = v.length;
        return v.slice(0, maxLength);
      }
      return v;
    });
    if (!anyTruncated) return { value, truncated: null };
    return {
      value: next,
      truncated: { original_length: maxOriginal, max_length: maxLength }
    };
  }
  if (typeof value !== 'string') return { value, truncated: null };
  if (value.length <= maxLength) return { value, truncated: null };
  return {
    value: value.slice(0, maxLength),
    truncated: { original_length: value.length, max_length: maxLength }
  };
}

// Zoho rejects the entire PUT with HTTP 400 INVALID_DATA
// `expected_data_type: website` (or `url`) when a single value mapped to
// a URL-typed field doesn't look like a real URL — e.g. a Twitter handle
// `@user`, a free-text label, or a bare host without scheme. Same blast
// radius as the length issue: one bad URL kills every other backfilled
// or overwritten field in the same record. We coerce at push time:
//   - If the value already parses as an http(s)/ftp URL → unchanged.
//   - If it looks like a bare host (e.g. `twitter.com/foo`,
//     `example.co.uk`) → auto-prefix `https://` and re-validate.
//   - Otherwise → return `{ ok: false }` so the caller drops the field
//     from the outbound payload and records it in `invalid_url_fields`.
const URL_DATA_TYPES = new Set(['website', 'url']);
function isUrlDataType(dataType) {
  if (!dataType) return false;
  return URL_DATA_TYPES.has(String(dataType).toLowerCase());
}

// Allow `http://`, `https://`, `ftp://`, `ftps://`. Anything else
// (mailto, javascript, custom scheme) is treated as not-a-URL — Zoho's
// website validator rejects them with the same 400.
const ALLOWED_URL_PROTOCOLS = new Set(['http:', 'https:', 'ftp:', 'ftps:']);

// Bare-host detector: at least one dot, no whitespace, doesn't start
// with `@` or `/`, and the first dot-segment looks like a hostname
// label. Path / query / fragment after the host is fine. Conservative
// on purpose: if it's ambiguous we'd rather report `invalid` than push
// a malformed URL that Zoho will still reject.
function looksLikeBareHost(s) {
  if (typeof s !== 'string') return false;
  const trimmed = s.trim();
  if (!trimmed) return false;
  if (/\s/.test(trimmed)) return false;
  if (trimmed.startsWith('@') || trimmed.startsWith('/')) return false;
  // Strip path/query/fragment for the host check.
  const hostPart = trimmed.split(/[/?#]/)[0];
  if (!hostPart.includes('.')) return false;
  // Each label must be 1..63 chars, alphanum + hyphen, no leading/trailing
  // hyphen. TLD must be at least 2 alphabetic chars.
  const labelRe = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
  const labels = hostPart.split('.');
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (!labelRe.test(label)) return false;
  }
  if (!/^[a-zA-Z]{2,}$/.test(labels[labels.length - 1])) return false;
  return true;
}

function tryParseUrl(s) {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

/**
 * Coerce `value` into a URL acceptable to Zoho for `website` / `url`
 * data_types. Returns one of:
 *   - `{ ok: true, value, coerced: false }`   — already a valid URL
 *   - `{ ok: true, value, coerced: true }`    — host without scheme; we
 *     prefixed `https://`
 *   - `{ ok: false, reason }`                  — not coercible; caller
 *     should drop the field from the outbound payload
 *
 * Multi-pick / array values are coerced per-element. If even a single
 * element is invalid, the whole array is reported invalid (Zoho
 * validates element-wise and rejects the record on the first bad
 * entry, so partial arrays would still kill the record). Picklist /
 * lookup / boolean / number / date fields are not URL-typed and never
 * reach this function.
 */
function coerceUrlValueForZoho(field, value) {
  if (!field || !isUrlDataType(field.data_type)) return { ok: true, value, coerced: false };
  if (value === undefined || value === null || value === '') return { ok: true, value, coerced: false };
  if (Array.isArray(value)) {
    const next = [];
    let anyCoerced = false;
    for (const v of value) {
      const r = coerceUrlValueForZoho(field, v);
      if (!r.ok) return { ok: false, reason: r.reason };
      next.push(r.value);
      if (r.coerced) anyCoerced = true;
    }
    return { ok: true, value: next, coerced: anyCoerced };
  }
  if (typeof value !== 'string') return { ok: false, reason: 'not_a_string' };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value, coerced: false };
  // Already-parseable URL with an allowed scheme.
  const parsed = tryParseUrl(trimmed);
  if (parsed && ALLOWED_URL_PROTOCOLS.has(parsed.protocol)) {
    return { ok: true, value: trimmed, coerced: trimmed !== value };
  }
  // Bare host? Try prefixing https:// and re-parsing.
  if (looksLikeBareHost(trimmed)) {
    const candidate = `https://${trimmed}`;
    const reparsed = tryParseUrl(candidate);
    if (reparsed && ALLOWED_URL_PROTOCOLS.has(reparsed.protocol)) {
      return { ok: true, value: candidate, coerced: true };
    }
  }
  return { ok: false, reason: 'not_a_url' };
}

/**
 * Inbound translation for a single mapping row. Mirror of the outbound
 * helper. For multi-pick fields the inbound value coming from Zoho's GET
 * response is already a real array — we map each element through the
 * Zoho→iConnect side of value_map and return a real JS array so the
 * canonical hash (computed before storage) matches symmetrically with the
 * outbound canonical (which parses the stored JSON string back to an
 * array). The actual storage layer (`formatStoredCustomValue`) JSON-
 * encodes arrays back to strings on its own.
 */
function applyMappingValueInbound(mapping, raw, warnings) {
  if (mapping?.is_multi_pick) {
    const arr = parseMultiPickValue(raw);
    if (arr === null) return null;
    return arr.map(v => applyValueMap(mapping, v, 'zoho_to_iconnect', warnings));
  }
  return applyValueMap(mapping, raw, 'zoho_to_iconnect', warnings);
}

/**
 * Stable canonical form for hash comparison. Multi-pick arrays are sorted
 * so an inbound `["A","B"]` and an outbound `["B","A"]` (semantically
 * identical for set-valued fields) hash to the same value and don't
 * trigger an infinite ping-pong of "different payload" syncs. Sorting is
 * for the hash ONLY — the original (user-authored) order is preserved on
 * the wire.
 */
function canonicalizeForHash(mapping, value) {
  if (value === undefined || value === null) return value;
  if (mapping?.is_multi_pick) {
    const arr = parseMultiPickValue(value);
    if (arr === null) return null;
    return [...arr].sort();
  }
  return value;
}

function buildPayload(mappings, entity, customValues, warnings, breadcrumbs) {
  const payload = {};
  const wantBreadcrumbs = Array.isArray(breadcrumbs);
  for (const m of mappings || []) {
    if (!m?.zoho_field) continue;
    const raw = resolveMappedValue(m, entity, customValues);
    // For multi-pick fields we let the helper decide whether to drop the
    // field — `parseMultiPickValue` returning `null` means truly empty,
    // but an empty-string element list is still a valid "clear" intent.
    if (!m?.is_multi_pick && (raw === undefined || raw === null || raw === '')) continue;
    const isPicklistLike = m.is_picklist === true || m.is_multi_pick === true;
    const info = wantBreadcrumbs && isPicklistLike ? {} : null;
    const translated = applyMappingValueOutbound(m, raw, warnings, info);

    // #468: per-picklist breadcrumb so the sync log can show — for every
    // picklist-like field — exactly what arrived from iConnect, what
    // shipped to Zoho (or that the field was omitted), whether the
    // value_map was consulted, and whether the result matched a known
    // active Zoho option. Plain text / number / date fields do NOT emit
    // a breadcrumb to keep the log payload small.
    if (info) {
      // matched_picklist_option: strict boolean. True iff the translated
      // value is a known active Zoho picklist option (single-pick) or
      // every kept element is (multi-pick). Null when Zoho metadata is
      // unavailable so the breadcrumb truthfully reports "unknown".
      const opts = m._picklistOptions;
      let matchedPicklistOption = null;
      if (opts && opts.size > 0) {
        if (translated === undefined) {
          matchedPicklistOption = false;
        } else if (Array.isArray(translated)) {
          matchedPicklistOption = translated.length > 0
            && translated.every(v => typeof v === 'string' && opts.has(v));
        } else {
          matchedPicklistOption = typeof translated === 'string' && opts.has(translated);
        }
      }
      breadcrumbs.push({
        iconnect_field: m.iconnect_field,
        zoho_field: m.zoho_field,
        is_multi_pick: m.is_multi_pick === true,
        raw_value: raw === undefined || raw === null ? null
          : (Array.isArray(raw) ? raw.map(v => v == null ? null : String(v)) : String(raw)),
        translated_value: translated === undefined ? null
          : (Array.isArray(translated) ? translated : String(translated)),
        matched_picklist_option: matchedPicklistOption,
        value_map_hit: info.value_map_hit ?? null,
        omitted: translated === undefined,
        ...(m.is_multi_pick === true ? {
          kept_count: info.kept_count ?? 0,
          omitted_count: info.omitted_count ?? 0
        } : {})
      });
    }

    if (translated === undefined) continue;
    payload[m.zoho_field] = translated;
  }
  return payload;
}

/**
 * Build a canonical payload — keyed by iConnect field name (or `custom:<id>`
 * for preference fields) — for hash-based echo/loop detection. The same
 * shape is produced from either direction so outbound and inbound hashes
 * are directly comparable. Multi-pick fields are normalised (parsed +
 * sorted) so order-only differences in the array don't cause false-
 * positive hash mismatches.
 */
function buildCanonicalPayload(mappings, entity, customValues) {
  const canonical = {};
  for (const m of mappings || []) {
    if (!m?.iconnect_field || !m?.zoho_field) continue;
    const v = resolveMappedValue(m, entity, customValues);
    if (v === undefined || v === null || v === '') continue;
    canonical[m.iconnect_field] = canonicalizeForHash(m, v);
  }
  return canonical;
}

export async function writeSyncLog(row) {
  return writeLog(row);
}

async function writeLog(row) {
  try {
    const { data, error } = await supabase
      .from('zoho_crm_sync_log')
      .insert({ direction: 'outbound', ...row })
      .select()
      .single();
    if (error) {
      console.error('[ZohoCrmSync] Failed to write log:', error);
      return null;
    }
    return data;
  } catch (err) {
    console.error('[ZohoCrmSync] Log insert exception:', err);
    return null;
  }
}

async function persistZohoIdOnEntity(tenantId, entityType, entityId, zohoId, zohoModule) {
  if (!zohoId) return;
  const table = ENTITY_TABLE[entityType];
  try {
    await supabase
      .from(table)
      .update({ zoho_crm_id: zohoId, zoho_crm_module: zohoModule })
      .eq('id', entityId)
      .eq('tenant_id', tenantId);
  } catch (err) {
    console.error('[ZohoCrmSync] Failed to persist zoho_crm_id:', err);
  }
}

async function getSyncState(tenantId, entityType, entityId, direction) {
  const { data } = await supabase
    .from('zoho_crm_sync_state')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .eq('direction', direction)
    .maybeSingle();
  return data || null;
}

async function recordSyncState(tenantId, entityType, entityId, direction, hash) {
  if (!hash) return;
  try {
    await supabase
      .from('zoho_crm_sync_state')
      .upsert({
        tenant_id: tenantId,
        entity_type: entityType,
        entity_id: entityId,
        direction,
        payload_hash: hash,
        last_synced_at: new Date().toISOString()
      }, { onConflict: 'tenant_id,entity_type,entity_id,direction' });
  } catch (err) {
    console.error('[ZohoCrmSync] Failed to record sync state:', err);
  }
}

/**
 * Outbound: push the iConnect entity to Zoho CRM.
 */
export async function syncEntityToZohoCrm(tenantId, entityType, entityId, options = {}) {
  if (!tenantId || !entityType || !entityId) {
    console.warn('[ZohoCrmSync] Missing params, skipping');
    return null;
  }
  const action = options.action || 'sync';
  const source = options.source || 'trigger';

  // Origin loop short-circuit: do not push back out a write that originated
  // from an inbound sync from Zoho. Two layers:
  //   1. Explicit `fromInbound` option (when callers know).
  //   2. In-memory tracker that records every inbound write for 30s, so
  //      indirect callers (e.g. PATCH endpoints, realtime relays) cannot
  //      accidentally bounce an inbound write back out.
  if (options.fromInbound || hasInboundOrigin(tenantId, entityType, entityId)) {
    console.log('[ZohoCrmSync] Outbound short-circuited (origin: inbound)');
    return null;
  }

  try {
    const { data: mapping, error: mappingErr } = await supabase
      .from('zoho_crm_sync_mapping')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('entity_type', entityType)
      .maybeSingle();
    if (mappingErr) throw mappingErr;
    if (!mapping || !mapping.is_enabled) return null;

    // Self-heal `is_multi_pick` / `is_rich_text` flags on legacy mapping
    // rows that pre-date the per-row stamping introduced in #424. Without
    // this, multi-pick fields fall through to scalar handling and Zoho
    // 400s with `expected_data_type: jsonarray` on the whole record.
    await enrichMappingFlagsFromMetadata(tenantId, mapping);

    // Honour sync_direction: only push if outbound or bidirectional.
    const direction = mapping.sync_direction || 'outbound';
    if (direction === 'inbound') {
      return null;
    }

    const connected = await isZohoCrmConnected(tenantId);
    if (!connected) {
      return await writeLog({
        tenant_id: tenantId, entity_type: entityType, entity_id: entityId,
        zoho_module: mapping.zoho_module, status: 'failed', action, source,
        error_message: 'Zoho CRM is not connected for this tenant'
      });
    }

    const entity = await loadEntity(tenantId, entityType, entityId);
    if (!entity) {
      return await writeLog({
        tenant_id: tenantId, entity_type: entityType, entity_id: entityId,
        zoho_module: mapping.zoho_module, status: 'failed', action, source,
        error_message: 'Entity not found'
      });
    }

    const customValues = await loadCustomFieldValues(tenantId, entityType, entityId);
    const translationWarnings = [];
    const picklistTranslations = [];
    const payload = buildPayload(
      mapping.field_mappings, entity, customValues,
      translationWarnings, picklistTranslations
    );
    const canonicalPayload = buildCanonicalPayload(mapping.field_mappings, entity, customValues);
    if (translationWarnings.length > 0) {
      console.warn('[ZohoCrmSync] Outbound value translation gaps:', translationWarnings);
    }

    if (Object.keys(payload).length === 0) {
      return await writeLog({
        tenant_id: tenantId, entity_type: entityType, entity_id: entityId,
        zoho_module: mapping.zoho_module, status: 'skipped', action, source,
        error_message: 'No mapped fields had a value to sync'
      });
    }

    // Canonical hash (iConnect-keyed) so it can be compared against inbound
    // payload hashes from `applyInboundFromZoho`.
    const payloadHash = computeHash(canonicalPayload);

    // Echo / no-op detection. If we already pushed this exact payload, skip.
    const lastOutbound = await getSyncState(tenantId, entityType, entityId, 'outbound');
    if (lastOutbound && lastOutbound.payload_hash === payloadHash) {
      return await writeLog({
        tenant_id: tenantId, entity_type: entityType, entity_id: entityId,
        zoho_module: mapping.zoho_module, status: 'skipped', action, source,
        payload_hash: payloadHash,
        error_message: 'No-op: payload identical to last outbound sync'
      });
    }

    // Inbound debounce: if Zoho just pushed us this exact payload moments ago,
    // do not echo it back.
    const lastInbound = await getSyncState(tenantId, entityType, entityId, 'inbound');
    if (lastInbound && lastInbound.payload_hash === payloadHash &&
        Date.now() - new Date(lastInbound.last_synced_at).getTime() < ECHO_DEBOUNCE_MS) {
      return await writeLog({
        tenant_id: tenantId, entity_type: entityType, entity_id: entityId,
        zoho_module: mapping.zoho_module, status: 'skipped', action, source,
        payload_hash: payloadHash,
        error_message: 'Debounced: matches recent inbound sync'
      });
    }

    // Build the combined payload for Zoho's standard record-update path.
    // Since #422 we no longer split rich-text fields off into a dedicated
    // PUT — that split was originally introduced (see #413) to target an
    // undocumented `actions/rich_text` endpoint which #419 retired in
    // favour of the documented v8 `actions/fetch_full_data` for reads.
    // The interim writer (#419) kept the split but pointed at a
    // mixed-pattern URL (`PUT /{module}/{record_id}` with id ALSO in the
    // body) which Zoho's gateway accepted but silently dropped rich-text
    // values from. Merging the rich-text and regular fields into one
    // standard `updateZohoCrmRecordById` call removes the malformed
    // mixed-URL request, removes an extra HTTP round-trip per outbound
    // sync, and matches the documented Zoho update shape (`PUT /{module}`
    // with `data:[{id, ...fields}], trigger:['workflow']`).
    //
    // The `is_rich_text` flag (stamped at mapping save by
    // `api/admin/zoho-crm-sync/mappings.js`) is still tracked here — not
    // for routing, but for the post-write verification step further
    // down. After the combined PUT lands successfully we re-read every
    // rich-text field that was part of this write via the v8
    // `fetchZohoCrmRecordRichText` endpoint and confirm the value
    // actually persisted on Zoho's side. This catches Zoho's
    // historical silent-drop failure mode loudly instead of letting it
    // sit invisibly behind a 2xx response (the same lesson #419
    // hardened on the read side).
    const richTextZohoFields = new Set(
      (mapping.field_mappings || [])
        .filter(m => m?.is_rich_text === true && m?.zoho_field)
        .map(m => m.zoho_field)
    );
    const richTextFieldsInPayload = Object.keys(payload).filter(k => richTextZohoFields.has(k));
    // No outbound transformation for rich-text values: send what the
    // mapping resolved to. The previous wrap-as-HTML defence (#432) was
    // ineffective — Zoho's gateway stripped both the wrapper AND the
    // user's trailing `!<CAPITAL>` characters from the same payload
    // (verified on gsf Account 815132000006866409). The fix that stuck
    // (#433) was to retire the broken Zoho field and re-point the
    // mapping at a plain-text field instead, so this code path now sees
    // far fewer rich-text writes — and any that remain go through Zoho's
    // pipeline unwrapped. The post-write verification below still runs
    // and will surface any future silent drift loudly.
    // Track multi-pick fields in this payload so the operational
    // `mechanisms` log line surfaces them — useful when diagnosing future
    // jsonarray/picklist failures (the original bug behind #424 was hidden
    // because no log line called out which fields were multi-pick).
    const multiPickZohoFields = new Set(
      (mapping.field_mappings || [])
        .filter(m => m?.is_multi_pick === true && m?.zoho_field)
        .map(m => m.zoho_field)
    );
    const multiPickFieldsInPayload = Object.keys(payload).filter(k => multiPickZohoFields.has(k));

    const mechanismsUsed = [];
    if (multiPickFieldsInPayload.length > 0) {
      mechanismsUsed.push(`multi_pick_fields:${multiPickFieldsInPayload.length}`);
    }
    let result;
    let zohoRecordId = entity.zoho_crm_id;

    if (zohoRecordId && entity.zoho_crm_module === mapping.zoho_module) {
      result = await updateZohoCrmRecordById(tenantId, mapping.zoho_module, zohoRecordId, payload);
      mechanismsUsed.push(`update_by_id:${Object.keys(payload).length}`);
    } else {
      // Upsert path. Without any payload Zoho's upsert has nothing to
      // dedupe on, so fail loud rather than create a blank record. The
      // unique_key_field (Email/Account_Name/etc.) is never rich-text in
      // practice so the merged payload is always safe to upsert.
      if (Object.keys(payload).length === 0) {
        result = {
          success: false,
          error: 'Cannot upsert a new Zoho record with an empty payload — at least one mapped field (including the unique key) must have a value'
        };
        mechanismsUsed.push('upsert:skipped_empty_payload');
      } else {
        result = await upsertZohoCrmRecord(tenantId, mapping.zoho_module, payload, mapping.unique_key_field);
        mechanismsUsed.push(`upsert:${Object.keys(payload).length}`);
      }
    }

    // Post-write verification for rich-text fields. The standard Zoho
    // update endpoint *should* persist rich-text values inline, but the
    // gateway has been historically reported to silently drop them
    // under certain conditions (and the recently-fixed `actions/rich_text`
    // quirk in #419 is fresh proof that 2xx + status:'success' from
    // this gateway is not a guarantee of persistence). We re-read every
    // rich-text field we just wrote via the v8 `fetch_full_data`
    // endpoint and compare strictly. ANY inequality between the
    // expected (sent) value and the actual (fetched) value is
    // considered a mismatch — this catches both failure modes:
    //   1. silent drop: sent non-empty HTML, server returned empty
    //   2. silent retain: sent new HTML, server kept the old value
    // Strict equality may produce false positives if Zoho's rich-text
    // editor normalises HTML server-side (whitespace, attribute order,
    // `&nbsp;` vs space, auto-inserted `<p>` wrappers). When that
    // surfaces operationally we'll add a normaliser; for now we want
    // the noise so we can SEE every drift. Verification failures are
    // reported but non-fatal — other fields landed cleanly per Zoho's
    // response and the log message highlights the mismatch so
    // operators can spot patterns. A verification miss also suppresses
    // the outbound payload-hash stamp so the same payload will be
    // retried on the next sync trigger.
    let richTextVerification = null;
    if (result.success && richTextFieldsInPayload.length > 0) {
      const writtenRecordId = result.id || zohoRecordId;
      if (writtenRecordId) {
        try {
          const fetched = await fetchZohoCrmRecordRichText(
            tenantId, mapping.zoho_module, writtenRecordId, richTextFieldsInPayload
          );
          const mismatches = [];
          for (const apiName of richTextFieldsInPayload) {
            const expected = payload[apiName];
            const actual = fetched ? fetched[apiName] : undefined;
            // First pass: HTML-aware normalisation that strips a single
            // outer wrapper, decodes basic entities, normalises &nbsp;
            // and collapses whitespace. This filters out cosmetic diffs
            // from Zoho's WYSIWYG round-trip (it often re-wraps in
            // <p>...</p>, sometimes adds trailing whitespace) so the
            // strict-equality check below only fires on real content
            // drift. Second pass: bare-string fallback (null → '') so
            // an explicit clear still matches a server-returned null.
            const expectedNorm = verificationNormaliseRichText(expected);
            const actualNorm = verificationNormaliseRichText(actual);
            if (expectedNorm !== actualNorm) {
              const expectedStr = expected == null ? '' : String(expected);
              const actualStr = actual == null ? '' : String(actual);
              mismatches.push({
                api_name: apiName,
                expected_length: expectedStr.length,
                actual_length: actualStr.length,
                expected_preview: previewForMismatch(expectedStr),
                actual_preview: previewForMismatch(actualStr)
              });
            }
          }
          if (mismatches.length === 0) {
            richTextVerification = { success: true, fields: richTextFieldsInPayload };
            mechanismsUsed.push(`rich_text_verified:${richTextFieldsInPayload.length}`);
          } else {
            richTextVerification = { success: false, mismatches };
            mechanismsUsed.push(`rich_text_verification_mismatch:${mismatches.map(m => m.api_name).join(',')}`);
            for (const m of mismatches) {
              console.warn(
                '[ZohoCrmSync] Rich-text verification mismatch on', mapping.zoho_module, writtenRecordId,
                '- field', m.api_name,
                'expected length', m.expected_length, 'actual length', m.actual_length,
                '(Zoho did not persist the value as sent)'
              );
            }
          }
        } catch (vErr) {
          // Verification call itself failed — surface in log so operators
          // can spot patterns but do NOT roll back the write (Zoho
          // reported it succeeded and other fields landed cleanly).
          richTextVerification = { success: false, error: vErr?.message || String(vErr), verification_error: true };
          mechanismsUsed.push(`rich_text_verification_threw:${vErr?.message || vErr}`);
          console.warn('[ZohoCrmSync] Rich-text verification threw for', entityType, entityId, '-', vErr?.message || vErr);
        }
      } else {
        mechanismsUsed.push('rich_text_verification_skipped:no_record_id');
      }
    }

    console.log('[ZohoCrmSync] Outbound mechanisms:', mechanismsUsed.join(' + '));

    const warningSuffix = translationWarnings.length > 0
      ? ` [translation warnings: ${translationWarnings
          .map(w => `${w.iconnect_field}→${w.zoho_field}="${w.unmapped_value}"`).join('; ')}]`
      : '';
    // Keep the inline suffix tight — just field names + lengths, no
    // user content. Previews and full diagnostic detail live in the
    // structured `rich_text_verification` object on `response_payload`
    // (rendered cleanly by the save-toast). Embedding user-supplied
    // text here would make the suffix unsafe to strip on the client.
    const richTextSuffix = (richTextVerification && !richTextVerification.success)
      ? (richTextVerification.verification_error
          ? ` [rich-text verification threw: ${richTextVerification.error || 'unknown'} — write itself reported success]`
          : ` [rich-text verification mismatch: Zoho silently altered ${
              richTextVerification.mismatches.map(m =>
                `${m.api_name} (sent ${m.expected_length}ch → got ${m.actual_length}ch)`
              ).join('; ')
            } — other fields synced OK; see rich_text_verification.mismatches for previews]`)
      : '';

    if (result.success) {
      await persistZohoIdOnEntity(tenantId, entityType, entityId, result.id, mapping.zoho_module);
      // Only stamp the outbound payload hash if the write *and* the
      // rich-text verification both landed cleanly. If verification
      // flagged a silent drop (or threw), a future sync of the identical
      // payload should still run so the write can be retried — recording
      // the hash here would no-op that retry (see lastOutbound short-
      // circuit above) and let the rich-text drift sit until an
      // unrelated field change forces a new payload.
      const verificationFailed = !!(richTextVerification && !richTextVerification.success);
      if (!verificationFailed) {
        await recordSyncState(tenantId, entityType, entityId, 'outbound', payloadHash);
      }
      const okMessage = (warningSuffix || richTextSuffix)
        ? `OK${warningSuffix}${richTextSuffix}`
        : null;
      return await writeLog({
        tenant_id: tenantId, entity_type: entityType, entity_id: entityId,
        zoho_module: mapping.zoho_module, zoho_record_id: result.id,
        status: 'success', action: result.action || action, source,
        payload_hash: payloadHash,
        error_message: okMessage,
        request_payload: payload,
        response_payload: {
          ...(result.details || {}),
          mechanisms: mechanismsUsed,
          ...(richTextVerification ? { rich_text_verification: richTextVerification } : {}),
          ...(translationWarnings.length > 0 ? { translation_warnings: translationWarnings } : {}),
          ...(picklistTranslations.length > 0 ? { picklist_translations: picklistTranslations } : {})
        }
      });
    }

    return await writeLog({
      tenant_id: tenantId, entity_type: entityType, entity_id: entityId,
      zoho_module: mapping.zoho_module, status: 'failed', action, source,
      payload_hash: payloadHash,
      error_message: (result.error || 'Unknown failure') + warningSuffix + richTextSuffix,
      request_payload: payload,
      response_payload: {
        ...(result.details || result.raw || {}),
        mechanisms: mechanismsUsed,
        ...(translationWarnings.length > 0 ? { translation_warnings: translationWarnings } : {}),
        ...(picklistTranslations.length > 0 ? { picklist_translations: picklistTranslations } : {})
      }
    });
  } catch (err) {
    console.error('[ZohoCrmSync] Sync failed:', err);
    return await writeLog({
      tenant_id: tenantId, entity_type: entityType, entity_id: entityId,
      status: 'failed', action, source,
      error_message: err?.message || String(err)
    });
  }
}

/**
 * Triggers an outbound Zoho CRM sync and returns a Promise resolving to
 * the resulting `zoho_crm_sync_log` row (or `null` if nothing was
 * dispatched / the sync threw fatally).
 *
 * Existing callers can keep ignoring the return value — the dispatch
 * still happens immediately and any errors are logged. New callers that
 * want to surface the result (e.g. the entity PATCH/POST handlers, so
 * the UI can render the sync outcome in the save toast) can `await` it.
 *
 * Pass `fromInbound: true` to suppress outbound echo.
 */
export function triggerZohoCrmSync(tenantId, entityType, entityId, options = {}) {
  if (!tenantId || !entityType || !entityId) return Promise.resolve(null);
  if (entityType !== 'member' && entityType !== 'organization') return Promise.resolve(null);
  return Promise.resolve()
    .then(() => syncEntityToZohoCrm(tenantId, entityType, entityId, options))
    .catch(err => {
      console.error('[ZohoCrmSync] Background sync error:', err);
      return null;
    });
}

/**
 * Awaits a `triggerZohoCrmSync` Promise up to `timeoutMs` and returns a
 * compact summary suitable for inclusion in an HTTP response. If the
 * sync hasn't completed by the timeout, the returned summary marks
 * `status: 'pending'` and `timed_out: true` — the underlying sync
 * Promise keeps running in the background but the caller doesn't wait
 * any longer (Vercel may then reap it; same fail-open semantics as the
 * pre-#430 fire-and-forget pattern).
 *
 * Returns `null` if no sync was dispatched (no mapping, wrong entity
 * type, or fatal error inside the sync) — the toast layer should treat
 * `null` as "nothing to show".
 */
export async function awaitZohoCrmSyncForResponse(syncPromise, timeoutMs = 8000) {
  if (!syncPromise || typeof syncPromise.then !== 'function') return null;
  let timer;
  const TIMEOUT_MARKER = Symbol('zoho_sync_timeout');
  const timeoutPromise = new Promise(resolve => {
    timer = setTimeout(() => resolve(TIMEOUT_MARKER), timeoutMs);
  });
  try {
    const result = await Promise.race([syncPromise, timeoutPromise]);
    if (result === TIMEOUT_MARKER) {
      return {
        status: 'pending',
        timed_out: true,
        timeout_ms: timeoutMs,
        message: `Zoho CRM sync did not complete within ${Math.round(timeoutMs / 1000)}s. The sync is continuing in the background but may be terminated by the serverless host before it finishes — check the sync log to confirm the outcome.`
      };
    }
    if (!result || typeof result !== 'object') return null;
    const mechanisms = Array.isArray(result.response_payload?.mechanisms)
      ? result.response_payload.mechanisms
      : null;
    const richTextVerification = result.response_payload?.rich_text_verification || null;
    return {
      log_id: result.id || null,
      status: result.status || null,
      zoho_module: result.zoho_module || null,
      zoho_record_id: result.zoho_record_id || null,
      action: result.action || null,
      error_message: result.error_message || null,
      mechanisms,
      rich_text_verification: richTextVerification
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function retryZohoCrmSyncLog(tenantId, logId) {
  if (!tenantId) throw new Error('tenantId is required');
  if (!logId) throw new Error('logId is required');
  const { data: log, error } = await supabase
    .from('zoho_crm_sync_log')
    .select('*')
    .eq('id', logId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw error;
  if (!log) throw new Error('Log entry not found');
  if (!log.entity_id || !log.entity_type) {
    throw new Error('Log entry has no entity to retry');
  }
  // Inbound logs retry through the inbound path with the ORIGINAL Zoho
  // payload (request_payload is always the raw Zoho record for inbound logs).
  if (log.direction === 'inbound') {
    if (!log.zoho_module) throw new Error('Inbound log missing zoho_module');
    const rawPayload = log.request_payload || {};
    if (!rawPayload || (typeof rawPayload === 'object' && Object.keys(rawPayload).length === 0)) {
      throw new Error('Inbound log has no original Zoho payload to replay');
    }
    if (!rawPayload.id && log.zoho_record_id) rawPayload.id = log.zoho_record_id;
    return await applyInboundFromZoho(tenantId, log.zoho_module, rawPayload, { source: 'retry' });
  }
  return await syncEntityToZohoCrm(log.tenant_id, log.entity_type, log.entity_id, { action: 'retry', source: 'retry' });
}

// ===========================================================================
// Reverse sync: Zoho CRM → iConnect
// ===========================================================================

const MODULE_TO_ENTITY_TYPE = {
  Contacts: 'member',
  Leads: 'member',
  Accounts: 'organization'
};

/**
 * Build an iConnect update payload from a Zoho CRM record by reversing the
 * configured field_mappings. Returns { coreUpdates, customUpdates } where
 * `customUpdates` is a map of preference_field id → value to upsert.
 */
/**
 * Canonical-form view of an inbound payload for hash comparison. Mirrors
 * `buildCanonicalPayload` (outbound) so the two hashes are directly
 * comparable: multi-pick arrays are sorted; everything else is passed
 * through unchanged. Empty values are dropped (matches outbound).
 */
function canonicalizeInboundForHash(mapping, coreUpdates, customUpdates) {
  const canonical = {};
  for (const m of mapping?.field_mappings || []) {
    if (!m?.iconnect_field) continue;
    let v;
    if (m.iconnect_field.startsWith('custom:')) {
      const fieldId = m.iconnect_field.slice('custom:'.length);
      v = customUpdates?.[fieldId];
    } else {
      v = coreUpdates?.[m.iconnect_field];
    }
    if (v === undefined || v === null || v === '') continue;
    canonical[m.iconnect_field] = canonicalizeForHash(m, v);
  }
  return canonical;
}

function buildReversePayload(mapping, zohoRecord, warnings) {
  const coreUpdates = {};
  const customUpdates = {};
  for (const m of mapping.field_mappings || []) {
    const zohoField = m?.zoho_field;
    const iconnectField = m?.iconnect_field;
    if (!zohoField || !iconnectField) continue;
    if (!Object.prototype.hasOwnProperty.call(zohoRecord, zohoField)) continue;
    const raw = zohoRecord[zohoField];
    // For multi-pick the resolved value is a real JS array (or null when
    // Zoho returned an empty list). `applyCustomFieldUpdates` /
    // `formatStoredCustomValue` will JSON-encode it for storage.
    const value = applyMappingValueInbound(m, raw, warnings);
    if (iconnectField.startsWith('custom:')) {
      const fieldId = iconnectField.slice('custom:'.length);
      customUpdates[fieldId] = value;
    } else {
      coreUpdates[iconnectField] = value;
    }
  }
  return { coreUpdates, customUpdates };
}

async function findEntityByZohoId(tenantId, entityType, zohoModule, zohoId) {
  const table = ENTITY_TABLE[entityType];
  if (!table) return null;
  // Prefer an exact match on (zoho_crm_id, zoho_crm_module) — but fall back
  // to a module-agnostic match so legacy records linked before
  // `zoho_crm_module` was populated still resolve. Within a tenant, a Zoho
  // record id is effectively unique across modules in practice, and we only
  // call this when the module came from the inbound webhook anyway.
  const { data: scoped } = await supabase
    .from(table)
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('zoho_crm_id', zohoId)
    .eq('zoho_crm_module', zohoModule)
    .maybeSingle();
  if (scoped) return scoped;
  const { data: fallback } = await supabase
    .from(table)
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('zoho_crm_id', zohoId)
    .or('zoho_crm_module.is.null,zoho_crm_module.eq.' + zohoModule)
    .limit(2);
  if (Array.isArray(fallback) && fallback.length === 1) {
    // Backfill the module so subsequent lookups take the scoped path.
    await persistZohoIdOnEntity(tenantId, entityType, fallback[0].id, zohoId, zohoModule);
    return fallback[0];
  }
  return null;
}

// Returns one of:
//   { entity: <row> }                 — exactly one match
//   { entity: null, reason: 'none' }  — no rows
//   { entity: null, reason: 'ambiguous', count: N } — multiple matches
//   { entity: null, reason: 'error', error: <msg> }
async function findEntityByUniqueField(tenantId, entityType, fieldName, value) {
  if (!fieldName || value === undefined || value === null || value === '') {
    return { entity: null, reason: 'none' };
  }
  const table = ENTITY_TABLE[entityType];
  if (!table) return { entity: null, reason: 'none' };
  try {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .eq('tenant_id', tenantId)
      .eq(fieldName, value)
      .limit(2);
    if (error) return { entity: null, reason: 'error', error: error.message };
    if (!Array.isArray(data) || data.length === 0) return { entity: null, reason: 'none' };
    if (data.length > 1) return { entity: null, reason: 'ambiguous', count: data.length };
    return { entity: data[0] };
  } catch (err) {
    return { entity: null, reason: 'error', error: err?.message || String(err) };
  }
}

function resolveLocalKeyForZohoUnique(mapping) {
  // Map the configured Zoho unique_key_field back to the iConnect column it
  // was paired with in field_mappings (only useful when that pairing is a
  // core field, not a custom: one).
  const m = (mapping.field_mappings || []).find(r => r.zoho_field === mapping.unique_key_field);
  if (!m) return null;
  if (!m.iconnect_field || m.iconnect_field.startsWith('custom:')) return null;
  return m.iconnect_field;
}

function formatStoredCustomValue(value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value) || typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

async function applyCustomFieldUpdates(tenantId, entityType, entityId, customUpdates) {
  const fk = PREF_VALUE_FK[entityType];
  const table = PREF_VALUE_TABLE[entityType];
  if (!fk || !table) return;
  for (const [fieldId, value] of Object.entries(customUpdates)) {
    const stored = formatStoredCustomValue(value);
    const { data: existing, error: selectError } = await supabase
      .from(table)
      .select('id')
      .eq(fk, entityId)
      .eq('field_id', fieldId)
      .maybeSingle();
    if (selectError) {
      throw new Error(`Failed to read custom value (field_id=${fieldId}): ${selectError.message}`);
    }
    if (existing) {
      const { error: updateError } = await supabase
        .from(table)
        .update({ value: stored, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
      if (updateError) {
        throw new Error(`Failed to update custom value (field_id=${fieldId}): ${updateError.message}`);
      }
    } else {
      const { error: insertError } = await supabase
        .from(table)
        .insert({ [fk]: entityId, field_id: fieldId, value: stored });
      if (insertError) {
        throw new Error(`Failed to insert custom value (field_id=${fieldId}): ${insertError.message}`);
      }
    }
  }
}

/**
 * Apply an inbound Zoho CRM record to the matching iConnect entity.
 * Performs loop / echo detection, conflict resolution, and writes a log entry.
 */
export async function applyInboundFromZoho(tenantId, zohoModule, zohoRecord, options = {}) {
  const source = options.source || 'webhook';
  const entityType = MODULE_TO_ENTITY_TYPE[zohoModule];
  if (!entityType) {
    return await writeLog({
      tenant_id: tenantId, entity_type: 'unknown',
      zoho_module: zohoModule, status: 'failed',
      direction: 'inbound', source, action: 'inbound',
      error_message: `Unsupported Zoho module: ${zohoModule}`
    });
  }

  // Mapping lookup — must match the incoming Zoho module so that, for
  // example, a Contacts webhook is never processed against a Leads-mapped
  // member configuration.
  const { data: mapping } = await supabase
    .from('zoho_crm_sync_mapping')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('entity_type', entityType)
    .eq('zoho_module', zohoModule)
    .maybeSingle();

  if (!mapping || !mapping.is_enabled) {
    return await writeLog({
      tenant_id: tenantId, entity_type: entityType,
      zoho_module: zohoModule, status: 'skipped',
      direction: 'inbound', source, action: 'inbound',
      error_message: `No enabled mapping configured for tenant/entity/module (${entityType}/${zohoModule})`
    });
  }
  // Self-heal `is_multi_pick` / `is_rich_text` flags on legacy mapping
  // rows that pre-date #424. Inbound symmetry: both directions must
  // agree on what counts as multi-pick or the canonical hash diverges
  // and we ping-pong.
  await enrichMappingFlagsFromMetadata(tenantId, mapping);

  const direction = mapping.sync_direction || 'outbound';
  if (direction === 'outbound') {
    return await writeLog({
      tenant_id: tenantId, entity_type: entityType,
      zoho_module: zohoModule, status: 'skipped',
      direction: 'inbound', source, action: 'inbound',
      error_message: 'Mapping is outbound-only — inbound dropped'
    });
  }

  // Merge rich-text values that Zoho hides from the regular GET payload.
  // No-op for mappings without rich-text fields.
  zohoRecord = await enrichRecordWithRichText(tenantId, mapping, zohoModule, zohoRecord);

  const zohoId = zohoRecord?.id || zohoRecord?.Id || null;
  let entity = null;
  // Track every match attempt so the skip log can explain what failed instead
  // of just emitting the bare "No matching iConnect record" message that is
  // impossible to act on from the admin UI.
  const matchAttempts = [];
  if (zohoId) {
    entity = await findEntityByZohoId(tenantId, entityType, zohoModule, zohoId);
    matchAttempts.push(entity
      ? `zoho_crm_id=${zohoId} matched`
      : `zoho_crm_id=${zohoId} not linked to any iConnect ${entityType}`);
  } else {
    matchAttempts.push('Zoho payload had no id field');
  }
  if (!entity) {
    const localKey = resolveLocalKeyForZohoUnique(mapping);
    if (!localKey) {
      matchAttempts.push(
        `unique_key_field "${mapping.unique_key_field || '(unset)'}" is not paired with a core iConnect column in field_mappings — cannot match by unique key`
      );
    } else {
      const matchValue = zohoRecord[mapping.unique_key_field];
      const result = await findEntityByUniqueField(tenantId, entityType, localKey, matchValue);
      if (result.entity) {
        entity = result.entity;
        matchAttempts.push(`${localKey}="${matchValue}" matched 1 iConnect ${entityType}`);
        if (zohoId) {
          await persistZohoIdOnEntity(tenantId, entityType, entity.id, zohoId, zohoModule);
        }
      } else if (result.reason === 'ambiguous') {
        matchAttempts.push(
          `${localKey}="${matchValue}" is not unique — ${result.count}+ iConnect ${entityType} rows matched`
        );
      } else if (result.reason === 'error') {
        matchAttempts.push(`${localKey} lookup errored: ${result.error}`);
      } else {
        const valueRepr = matchValue === undefined || matchValue === null || matchValue === ''
          ? '(empty)'
          : `"${matchValue}"`;
        matchAttempts.push(`${localKey}=${valueRepr} did not match any iConnect ${entityType}`);
      }
    }
  }

  if (!entity) {
    const policy = mapping.unmatched_policy || 'ignore';
    const detail = matchAttempts.join('; ');
    if (policy === 'queue') {
      return await writeLog({
        tenant_id: tenantId, entity_type: entityType, entity_id: null,
        zoho_module: zohoModule, zoho_record_id: zohoId,
        status: 'pending', direction: 'inbound', source, action: 'inbound',
        error_message: `Queued: no matching iConnect record (policy=queue) — ${detail}`,
        request_payload: zohoRecord
      });
    }
    if (policy === 'create') {
      return await createEntityFromZoho(tenantId, entityType, mapping, zohoModule, zohoRecord, source);
    }
    return await writeLog({
      tenant_id: tenantId, entity_type: entityType, entity_id: null,
      zoho_module: zohoModule, zoho_record_id: zohoId,
      status: 'skipped', direction: 'inbound', source, action: 'inbound',
      error_message: `No matching iConnect record (policy=ignore) — ${detail}`,
      request_payload: zohoRecord
    });
  }

  const inboundWarnings = [];
  const { coreUpdates, customUpdates } = buildReversePayload(mapping, zohoRecord, inboundWarnings);
  if (inboundWarnings.length > 0) {
    console.warn('[ZohoCrmSync] Inbound value translation gaps:', inboundWarnings);
  }
  const inboundWarningSuffix = inboundWarnings.length > 0
    ? ` [translation warnings: ${inboundWarnings
        .map(w => `${w.zoho_field}→${w.iconnect_field}="${w.unmapped_value}"`).join('; ')}]`
    : '';
  const combinedPayload = { ...coreUpdates, ...Object.fromEntries(Object.entries(customUpdates).map(([k, v]) => [`custom:${k}`, v])) };

  if (Object.keys(combinedPayload).length === 0) {
    return await writeLog({
      tenant_id: tenantId, entity_type: entityType, entity_id: entity.id,
      zoho_module: zohoModule, zoho_record_id: zohoId,
      status: 'skipped', direction: 'inbound', source, action: 'inbound',
      error_message: 'Inbound payload had no mapped fields',
      request_payload: zohoRecord
    });
  }

  // Compute the hash from a canonical view (multi-pick arrays sorted) so
  // it lines up with the outbound canonical hash and we don't ping-pong
  // when Zoho returns the same set of multi-pick values in a different
  // order than we sent.
  const payloadHash = computeHash(canonicalizeInboundForHash(mapping, coreUpdates, customUpdates));

  // Echo: this exact payload was just pushed outbound — drop.
  const lastOutbound = await getSyncState(tenantId, entityType, entity.id, 'outbound');
  if (lastOutbound && lastOutbound.payload_hash === payloadHash &&
      Date.now() - new Date(lastOutbound.last_synced_at).getTime() < ECHO_DEBOUNCE_MS) {
    return await writeLog({
      tenant_id: tenantId, entity_type: entityType, entity_id: entity.id,
      zoho_module: zohoModule, zoho_record_id: zohoId,
      status: 'skipped', direction: 'inbound', source, action: 'inbound',
      payload_hash: payloadHash,
      error_message: 'Debounced: echo of recent outbound sync',
      request_payload: zohoRecord
    });
  }

  // No-op: same content as the last inbound write. We deliberately do NOT
  // write a `sync_log` row here — every outbound iConnect→Zoho push bumps
  // Zoho's `Modified_Time`, so the next inbound poll re-fetches the same
  // record, computes the same hash, and lands here. Logging that event
  // would fill the operator-visible log with noise that says literally
  // "nothing happened". Return a lightweight synthetic result so callers
  // (webhook handler, retry handler) that read `.id` / `.status` keep
  // working without a DB round-trip.
  const lastInbound = await getSyncState(tenantId, entityType, entity.id, 'inbound');
  if (lastInbound && lastInbound.payload_hash === payloadHash) {
    return {
      id: null,
      status: 'skipped',
      payload_hash: payloadHash,
      error_message: 'No-op: payload identical to last inbound sync (not logged)'
    };
  }

  // Conflict resolution. Compare Zoho Modified_Time vs entity.updated_at.
  const conflictPolicy = mapping.conflict_policy || 'last_write_wins';
  const zohoModifiedTime = zohoRecord.Modified_Time || zohoRecord.modified_time || null;
  const localUpdatedAt = entity.updated_at || null;
  let conflictResolution = 'no_conflict';
  if (lastInbound && localUpdatedAt &&
      new Date(localUpdatedAt).getTime() > new Date(lastInbound.last_synced_at).getTime()) {
    // Local has changed since the last successful inbound sync → potential conflict.
    if (conflictPolicy === 'iconnect_wins') {
      return await writeLog({
        tenant_id: tenantId, entity_type: entityType, entity_id: entity.id,
        zoho_module: zohoModule, zoho_record_id: zohoId,
        status: 'skipped', direction: 'inbound', source, action: 'inbound',
        payload_hash: payloadHash,
        conflict_resolution: 'iconnect_wins',
        error_message: 'Conflict: iConnect has newer changes (policy=iconnect_wins)',
        request_payload: zohoRecord
      });
    }
    if (conflictPolicy === 'last_write_wins') {
      const zohoTime = zohoModifiedTime ? new Date(zohoModifiedTime).getTime() : 0;
      const localTime = new Date(localUpdatedAt).getTime();
      if (localTime > zohoTime) {
        return await writeLog({
          tenant_id: tenantId, entity_type: entityType, entity_id: entity.id,
          zoho_module: zohoModule, zoho_record_id: zohoId,
          status: 'skipped', direction: 'inbound', source, action: 'inbound',
          payload_hash: payloadHash,
          conflict_resolution: 'last_write_wins:iconnect_newer',
          error_message: 'Conflict: iConnect updated_at newer than Zoho Modified_Time',
          request_payload: zohoRecord
        });
      }
      conflictResolution = 'last_write_wins:zoho_newer';
    } else {
      conflictResolution = 'zoho_wins';
    }
  }

  // No-change guard: if every resolved inbound value already matches the
  // current entity / custom-field value, skip the write entirely so we
  // don't bump updated_at and create avoidable churn.
  const currentCustomValues = await loadCustomFieldValues(tenantId, entityType, entity.id);
  const coreChanged = {};
  for (const [k, v] of Object.entries(coreUpdates)) {
    if (entity?.[k] !== v) coreChanged[k] = v;
  }
  const customChanged = {};
  for (const [k, v] of Object.entries(customUpdates)) {
    if (currentCustomValues[k] !== v) customChanged[k] = v;
  }
  if (Object.keys(coreChanged).length === 0 && Object.keys(customChanged).length === 0) {
    await recordSyncState(tenantId, entityType, entity.id, 'inbound', payloadHash);
    return await writeLog({
      tenant_id: tenantId, entity_type: entityType, entity_id: entity.id,
      zoho_module: zohoModule, zoho_record_id: zohoId,
      status: 'skipped', direction: 'inbound', source, action: 'inbound',
      payload_hash: payloadHash,
      conflict_resolution: conflictResolution,
      error_message: 'No-op: every mapped value already matches the iConnect record',
      request_payload: zohoRecord
    });
  }

  // Apply update. Mark inbound origin BEFORE the write so any indirectly
  // triggered outbound sync from a downstream listener is short-circuited.
  markInboundOrigin(tenantId, entityType, entity.id);
  const table = ENTITY_TABLE[entityType];
  try {
    if (Object.keys(coreChanged).length > 0) {
      const { error } = await supabase
        .from(table)
        .update({ ...coreChanged, updated_at: new Date().toISOString() })
        .eq('id', entity.id)
        .eq('tenant_id', tenantId);
      if (error) throw error;
    }
    if (Object.keys(customChanged).length > 0) {
      await applyCustomFieldUpdates(tenantId, entityType, entity.id, customChanged);
    }

    await recordSyncState(tenantId, entityType, entity.id, 'inbound', payloadHash);

    return await writeLog({
      tenant_id: tenantId, entity_type: entityType, entity_id: entity.id,
      zoho_module: zohoModule, zoho_record_id: zohoId,
      status: 'success', direction: 'inbound', source, action: 'inbound',
      payload_hash: payloadHash,
      conflict_resolution: conflictResolution,
      error_message: inboundWarningSuffix ? `OK${inboundWarningSuffix}` : null,
      request_payload: zohoRecord,
      response_payload: {
        core: coreChanged,
        custom: customChanged,
        ...(inboundWarnings.length > 0 ? { translation_warnings: inboundWarnings } : {})
      }
    });
  } catch (err) {
    console.error('[ZohoCrmSync] Inbound write failed:', err);
    return await writeLog({
      tenant_id: tenantId, entity_type: entityType, entity_id: entity.id,
      zoho_module: zohoModule, zoho_record_id: zohoId,
      status: 'failed', direction: 'inbound', source, action: 'inbound',
      payload_hash: payloadHash,
      conflict_resolution: conflictResolution,
      error_message: (err?.message || String(err)) + inboundWarningSuffix,
      request_payload: zohoRecord,
      response_payload: {
        core: coreChanged,
        custom: customChanged,
        ...(inboundWarnings.length > 0 ? { translation_warnings: inboundWarnings } : {})
      }
    });
  }
}

/**
 * Create a new iConnect entity from a Zoho record under the `create`
 * unmatched policy. Sets zoho_crm_id immediately so future inbound updates
 * find the record by id and never re-create. Marks inbound origin so any
 * downstream trigger doesn't echo the new record back to Zoho.
 */
async function createEntityFromZoho(tenantId, entityType, mapping, zohoModule, zohoRecord, source) {
  const zohoId = zohoRecord?.id || zohoRecord?.Id || null;
  const inboundWarnings = [];
  const { coreUpdates, customUpdates } = buildReversePayload(mapping, zohoRecord, inboundWarnings);
  if (inboundWarnings.length > 0) {
    console.warn(`[ZohoCrmSync] Inbound translation warnings on create (entity=${entityType} zoho_id=${zohoId}):`, inboundWarnings);
  }

  if (Object.keys(coreUpdates).length === 0 && Object.keys(customUpdates).length === 0) {
    return await writeLog({
      tenant_id: tenantId, entity_type: entityType, entity_id: null,
      zoho_module: zohoModule, zoho_record_id: zohoId,
      status: 'skipped', direction: 'inbound', source, action: 'create',
      error_message: 'Inbound payload had no mapped fields — cannot create',
      request_payload: zohoRecord
    });
  }

  const table = ENTITY_TABLE[entityType];
  const insertRow = {
    tenant_id: tenantId,
    ...coreUpdates,
    zoho_crm_id: zohoId,
    zoho_crm_module: zohoModule
  };
  try {
    const { data: created, error } = await supabase
      .from(table)
      .insert(insertRow)
      .select()
      .single();
    if (error) throw error;
    markInboundOrigin(tenantId, entityType, created.id);
    if (Object.keys(customUpdates).length > 0) {
      await applyCustomFieldUpdates(tenantId, entityType, created.id, customUpdates);
    }
    // Canonicalize so multi-pick array order doesn't ping-pong between
    // outbound and inbound hashes (matches `applyInboundFromZoho`).
    const payloadHash = computeHash(canonicalizeInboundForHash(mapping, coreUpdates, customUpdates));
    await recordSyncState(tenantId, entityType, created.id, 'inbound', payloadHash);
    return await writeLog({
      tenant_id: tenantId, entity_type: entityType, entity_id: created.id,
      zoho_module: zohoModule, zoho_record_id: zohoId,
      status: 'success', direction: 'inbound', source, action: 'create',
      payload_hash: payloadHash,
      request_payload: zohoRecord,
      response_payload: {
        core: coreUpdates,
        custom: customUpdates,
        created_id: created.id,
        ...(inboundWarnings.length > 0 ? { translation_warnings: inboundWarnings } : {})
      },
      error_message: inboundWarnings.length > 0
        ? `Translation warnings: ${inboundWarnings.join('; ')}`
        : undefined
    });
  } catch (err) {
    console.error('[ZohoCrmSync] Create-from-zoho failed:', err);
    return await writeLog({
      tenant_id: tenantId, entity_type: entityType, entity_id: null,
      zoho_module: zohoModule, zoho_record_id: zohoId,
      status: 'failed', direction: 'inbound', source, action: 'create',
      error_message: [err?.message || String(err), ...inboundWarnings].filter(Boolean).join(' | '),
      request_payload: zohoRecord,
      response_payload: inboundWarnings.length > 0 ? { translation_warnings: inboundWarnings } : undefined
    });
  }
}

/**
 * Apply an inbound DELETE notification from Zoho CRM. Looks up the matching
 * iConnect entity by `zoho_crm_id` (+ module), reads the mapping's
 * `deletion_policy`, and performs one of:
 *
 *   - `ignore`  → log only, take no destructive action (default).
 *   - `unlink`  → clear `zoho_crm_id` / `zoho_crm_module` so the iConnect
 *                 record stays but is no longer linked to Zoho.
 *   - `delete`  → hard-delete the iConnect entity. The DB tombstone trigger
 *                 fires AFTER DELETE; we immediately mark the just-created
 *                 tombstone row processed so the outbound reconcile cron
 *                 does NOT echo a delete back to Zoho (the delete originated
 *                 from Zoho — Zoho already knows).
 *
 * In all cases an `inboundOriginTracker` mark is left so any other listener
 * that observes the change (the unlink path's UPDATE, in particular) does
 * not push the change back outbound within the TTL window.
 *
 * Always idempotent — calling for a record we have no link to, or that was
 * already unlinked / deleted on a previous call, returns a `skipped` log
 * with a `reason` so the webhook can return 200 without re-running the
 * destructive path.
 *
 * Returns the inserted `zoho_crm_sync_log` row (or null on log-write
 * failure) so the caller can echo `{ status, reason, log_id }` to Zoho.
 */
export async function applyInboundDeleteFromZoho(tenantId, zohoModule, zohoId, options = {}) {
  const source = options.source || 'webhook';
  const action = 'delete_inbound';

  const entityType = MODULE_TO_ENTITY_TYPE[zohoModule];
  if (!entityType) {
    return await writeLog({
      tenant_id: tenantId, entity_type: 'unknown',
      zoho_module: zohoModule, zoho_record_id: zohoId,
      status: 'failed', direction: 'inbound', source, action,
      error_message: `Unsupported Zoho module: ${zohoModule}`
    });
  }
  if (!zohoId) {
    return await writeLog({
      tenant_id: tenantId, entity_type: entityType,
      zoho_module: zohoModule, zoho_record_id: null,
      status: 'failed', direction: 'inbound', source, action,
      error_message: 'Missing Zoho record id on delete payload'
    });
  }

  const { data: mapping } = await supabase
    .from('zoho_crm_sync_mapping')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('entity_type', entityType)
    .eq('zoho_module', zohoModule)
    .maybeSingle();

  // No mapping (or disabled) → nothing to act on, but still 200 so Zoho's
  // workflow rule does not retry forever. Log so admins can see why.
  if (!mapping || !mapping.is_enabled) {
    return await writeLog({
      tenant_id: tenantId, entity_type: entityType,
      zoho_module: zohoModule, zoho_record_id: zohoId,
      status: 'skipped', direction: 'inbound', source, action,
      error_message: `No enabled mapping configured for ${entityType}/${zohoModule} — delete ignored`
    });
  }

  // Outbound-only mappings deliberately don't react to inbound events
  // (matches `applyInboundFromZoho`'s behaviour for upserts).
  const direction = mapping.sync_direction || 'outbound';
  if (direction === 'outbound') {
    return await writeLog({
      tenant_id: tenantId, entity_type: entityType,
      zoho_module: zohoModule, zoho_record_id: zohoId,
      status: 'skipped', direction: 'inbound', source, action,
      error_message: 'Mapping is outbound-only — inbound delete dropped'
    });
  }

  const policy = mapping.deletion_policy || 'ignore';

  // Locate the iConnect entity by Zoho id. If none, there is no link to
  // act on — that's a clean idempotent no-op (Zoho deleted a record we
  // never knew about, or one already unlinked on a previous call).
  const entity = await findEntityByZohoId(tenantId, entityType, zohoModule, zohoId);
  if (!entity) {
    return await writeLog({
      tenant_id: tenantId, entity_type: entityType, entity_id: null,
      zoho_module: zohoModule, zoho_record_id: zohoId,
      status: 'skipped', direction: 'inbound', source, action,
      error_message: `No-op: no iConnect ${entityType} linked to ${zohoModule} id ${zohoId} (policy=${policy})`,
      response_payload: { reason: 'no_match', policy }
    });
  }

  // Mark the entity as "inbound origin" BEFORE any write so the in-process
  // outbound debounce treats any update/delete here as Zoho-originated and
  // does not echo back. Belt-and-braces — the explicit tombstone-suppression
  // for the delete path below covers the cross-process case.
  markInboundOrigin(tenantId, entityType, entity.id);

  if (policy === 'ignore') {
    return await writeLog({
      tenant_id: tenantId, entity_type: entityType, entity_id: entity.id,
      zoho_module: zohoModule, zoho_record_id: zohoId,
      status: 'skipped', direction: 'inbound', source, action,
      error_message: `Matched ${entityType} ${entity.id} but deletion_policy=ignore — left untouched`,
      response_payload: { reason: 'ignored_by_policy', policy, entity_id: entity.id }
    });
  }

  if (policy === 'unlink') {
    // Idempotent: if zoho_crm_id is already null, nothing to do.
    if (!entity.zoho_crm_id) {
      return await writeLog({
        tenant_id: tenantId, entity_type: entityType, entity_id: entity.id,
        zoho_module: zohoModule, zoho_record_id: zohoId,
        status: 'skipped', direction: 'inbound', source, action,
        error_message: `No-op: ${entityType} ${entity.id} is already unlinked`,
        response_payload: { reason: 'already_unlinked', policy, entity_id: entity.id }
      });
    }
    const table = ENTITY_TABLE[entityType];
    try {
      const { error } = await supabase
        .from(table)
        .update({
          zoho_crm_id: null,
          zoho_crm_module: null,
          updated_at: new Date().toISOString()
        })
        .eq('id', entity.id)
        .eq('tenant_id', tenantId);
      if (error) throw error;
      // Drop any saved sync_state rows so a future relink starts clean and
      // does not see a stale hash from before the unlink.
      try {
        await supabase
          .from('zoho_crm_sync_state')
          .delete()
          .eq('tenant_id', tenantId)
          .eq('entity_type', entityType)
          .eq('entity_id', entity.id);
      } catch (stateErr) {
        console.warn('[ZohoCrmSync] Inbound unlink: failed to clear sync_state', stateErr?.message || stateErr);
      }
      return await writeLog({
        tenant_id: tenantId, entity_type: entityType, entity_id: entity.id,
        zoho_module: zohoModule, zoho_record_id: zohoId,
        status: 'success', direction: 'inbound', source, action,
        error_message: `Unlinked ${entityType} ${entity.id} from ${zohoModule} ${zohoId} (deletion_policy=unlink)`,
        response_payload: { reason: 'unlinked', policy, entity_id: entity.id }
      });
    } catch (err) {
      console.error('[ZohoCrmSync] Inbound unlink failed:', err);
      return await writeLog({
        tenant_id: tenantId, entity_type: entityType, entity_id: entity.id,
        zoho_module: zohoModule, zoho_record_id: zohoId,
        status: 'failed', direction: 'inbound', source, action,
        error_message: `Unlink failed: ${err?.message || String(err)}`,
        response_payload: { reason: 'unlink_failed', policy, entity_id: entity.id }
      });
    }
  }

  if (policy === 'delete') {
    const table = ENTITY_TABLE[entityType];
    const entityId = entity.id;
    try {
      const { error } = await supabase
        .from(table)
        .delete()
        .eq('id', entityId)
        .eq('tenant_id', tenantId);
      if (error) throw error;

      // Tombstone suppression: the AFTER DELETE trigger from
      // 20260425_zoho_sync_tombstone.sql fires unconditionally inside the
      // same transaction, queuing an outbound delete. We just learned about
      // the deletion FROM Zoho — echoing a delete back would be wasted
      // calls (and a 404 from Zoho). Mark any pending tombstone for this
      // entity processed immediately. Best-effort: a failure here is
      // logged but does not roll back the inbound-delete success.
      try {
        const { error: tsErr } = await supabase
          .from('zoho_crm_sync_tombstone')
          .update({
            processed_at: new Date().toISOString(),
            last_error: 'Suppressed: delete originated from inbound Zoho webhook'
          })
          .eq('tenant_id', tenantId)
          .eq('entity_type', entityType)
          .eq('entity_id', entityId)
          .is('processed_at', null);
        if (tsErr) {
          console.warn('[ZohoCrmSync] Inbound delete: failed to suppress tombstone',
            tenantId, entityType, entityId, tsErr.message);
        }
      } catch (tsErr) {
        console.warn('[ZohoCrmSync] Inbound delete: tombstone suppression threw',
          tenantId, entityType, entityId, tsErr?.message || tsErr);
      }

      return await writeLog({
        tenant_id: tenantId, entity_type: entityType, entity_id: entityId,
        zoho_module: zohoModule, zoho_record_id: zohoId,
        status: 'success', direction: 'inbound', source, action,
        error_message: `Hard-deleted ${entityType} ${entityId} (deletion_policy=delete)`,
        response_payload: { reason: 'deleted', policy, entity_id: entityId }
      });
    } catch (err) {
      console.error('[ZohoCrmSync] Inbound delete failed:', err);
      return await writeLog({
        tenant_id: tenantId, entity_type: entityType, entity_id: entityId,
        zoho_module: zohoModule, zoho_record_id: zohoId,
        status: 'failed', direction: 'inbound', source, action,
        error_message: `Delete failed: ${err?.message || String(err)}`,
        response_payload: { reason: 'delete_failed', policy, entity_id: entityId }
      });
    }
  }

  // Unknown policy — should never happen given the CHECK constraint, but
  // log and bail rather than silently doing nothing.
  return await writeLog({
    tenant_id: tenantId, entity_type: entityType, entity_id: entity.id,
    zoho_module: zohoModule, zoho_record_id: zohoId,
    status: 'failed', direction: 'inbound', source, action,
    error_message: `Unknown deletion_policy="${policy}" — delete ignored`,
    response_payload: { reason: 'unknown_policy', policy, entity_id: entity.id }
  });
}

/**
 * Reconciliation poller: for every enabled inbound/bidirectional mapping,
 * pull records from Zoho whose Modified_Time is greater than the saved cursor
 * and run them through the inbound pipeline. Updates the cursor on success.
 */
export async function pollZohoCrmReconciliation(tenantId, options = {}) {
  const source = options.source || 'poller';
  const summary = { tenant_id: tenantId, mappings: [] };

  const { data: mappings, error } = await supabase
    .from('zoho_crm_sync_mapping')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('is_enabled', true);
  if (error) throw error;

  for (const mapping of mappings || []) {
    const dir = mapping.sync_direction || 'outbound';
    if (dir === 'outbound') continue;

    // Self-heal `is_multi_pick` / `is_rich_text` flags on legacy
    // mapping rows that pre-date #424 — see helper for context.
    await enrichMappingFlagsFromMetadata(tenantId, mapping);

    const sinceIso = mapping.last_inbound_cursor
      ? new Date(mapping.last_inbound_cursor).toISOString()
      : new Date(Date.now() - 60 * 60 * 1000).toISOString(); // first run: last hour

    const fields = (mapping.field_mappings || [])
      .map(m => m.zoho_field).filter(Boolean);
    fields.push('Modified_Time');
    if (mapping.unique_key_field) fields.push(mapping.unique_key_field);
    const fieldsParam = encodeURIComponent([...new Set(fields)].join(','));

    let page = 1;
    const perPage = 200;
    let processed = 0;
    let maxModified = mapping.last_inbound_cursor ? new Date(mapping.last_inbound_cursor).getTime() : 0;

    try {
      while (true) {
        const endpoint = `/${mapping.zoho_module}` +
          `?fields=${fieldsParam}` +
          `&sort_by=Modified_Time&sort_order=asc` +
          `&per_page=${perPage}&page=${page}`;
        const resp = await zohoCrmApiCall(tenantId, endpoint, {
          headers: { 'If-Modified-Since': sinceIso }
        });
        const records = resp?.data || [];
        if (records.length === 0) break;
        for (const rec of records) {
          // Defensive cursor check (Zoho's If-Modified-Since covers it but be strict)
          const modT = rec.Modified_Time ? new Date(rec.Modified_Time).getTime() : 0;
          if (mapping.last_inbound_cursor && modT <= new Date(mapping.last_inbound_cursor).getTime()) continue;
          await applyInboundFromZoho(tenantId, mapping.zoho_module, rec, { source });
          processed += 1;
          if (modT > maxModified) maxModified = modT;
        }
        const more = resp?.info?.more_records;
        if (!more) break;
        page += 1;
        if (page > 25) break; // safety stop — 5000 records / poll
      }

      if (maxModified > 0) {
        await supabase
          .from('zoho_crm_sync_mapping')
          .update({ last_inbound_cursor: new Date(maxModified).toISOString() })
          .eq('id', mapping.id);
      }
      summary.mappings.push({ entity_type: mapping.entity_type, processed });
    } catch (err) {
      console.error('[ZohoCrmSync] Poller error:', err);
      await writeLog({
        tenant_id: tenantId, entity_type: mapping.entity_type,
        zoho_module: mapping.zoho_module, status: 'failed',
        direction: 'inbound', source, action: 'reconcile',
        error_message: err?.message || String(err)
      });
      summary.mappings.push({ entity_type: mapping.entity_type, processed, error: err.message });
    }
  }

  return summary;
}

// ===========================================================================
// Relink: backfill iConnect → Zoho record-id links after a Zoho module
// switchover (e.g. Accounts module rebuilt) invalidates stored zoho_crm_id
// values. Link-only — does NOT update any field values.
// ===========================================================================

// Whitelist of organisation columns that may be used as the local
// unique-key for relink. Matches ENTITY_CORE_FIELDS.organization in
// api/admin/zoho-crm-sync/metadata.js and prevents PostgREST select-string
// injection via a tampered field_mappings JSON.
const ALLOWED_ORG_LOCAL_KEYS = new Set([
  'name', 'website_url', 'phone', 'invoicing_email',
  'invoicing_address', 'description', 'status'
]);

// Returns one of:
//   { status: 'valid', record }
//   { status: 'mismatch', record, zohoValue }   — Zoho has the id but the
//                                                 unique-key value differs
//   { status: 'missing' }                       — record no longer exists
async function validateExistingZohoLink(tenantId, module, recordId, uniqueKey, expectedValue) {
  try {
    const resp = await zohoCrmApiCall(tenantId, `/${module}/${encodeURIComponent(recordId)}`);
    const record = Array.isArray(resp?.data) ? resp.data[0] : null;
    if (!record) return { status: 'missing' };
    const zohoValue = record[uniqueKey];
    const norm = v => v === undefined || v === null ? '' : String(v).trim().toLowerCase();
    if (norm(zohoValue) !== norm(expectedValue)) {
      return { status: 'mismatch', record, zohoValue };
    }
    return { status: 'valid', record };
  } catch (err) {
    if (/\b404\b|invalid.?id|INVALID_DATA/i.test(err?.message || '')) return { status: 'missing' };
    throw err;
  }
}

function escapeZohoCriteriaValue(v) {
  // Zoho criteria values must escape special chars (parens, commas, etc.)
  // Conservative: backslash-escape parens, commas and backslashes.
  return String(v).replace(/([\\(),])/g, '\\$1');
}

// Deterministic search helper for relink: returns one of
//   { status: 'one',   records: [r] }
//   { status: 'none',  records: [] }
//   { status: 'many',  records: [...] }
//   { status: 'error', error: <msg> }
async function searchZohoByUniqueKey(tenantId, module, fieldName, value) {
  if (value === undefined || value === null || value === '') {
    return { status: 'none', records: [] };
  }
  try {
    const criteria = `(${fieldName}:equals:${escapeZohoCriteriaValue(value)})`;
    const records = await searchZohoCrmRecords(tenantId, module, criteria, ['id', fieldName]);
    if (records.length === 0) return { status: 'none', records: [] };
    if (records.length === 1) return { status: 'one', records };
    return { status: 'many', records };
  } catch (err) {
    return { status: 'error', error: err?.message || String(err) };
  }
}

/**
 * For every organization in the tenant, look it up in the new Zoho Accounts
 * module by the configured unique_key_field and persist the resulting
 * zoho_crm_id. Existing links are validated; stale ones are re-resolved.
 *
 * Decision matrix per org:
 *   - existing zoho_crm_id valid → log 'skipped' (already_linked)
 *   - existing zoho_crm_id stale → search; relink or log 'no_match'/'ambiguous'
 *   - no zoho_crm_id            → search; relink or log 'no_match'/'ambiguous'
 *
 * Returns a summary { processed, relinked, already_linked, no_match,
 * ambiguous, failed }.
 */
export async function relinkOrganizationsToZoho(tenantId, options = {}) {
  const source = options.source || 'admin_relink';
  // Optional resume cursor: only process orgs with id > startAfterId. Lets
  // the caller break a large tenant across multiple invocations without
  // re-validating already-processed records on every run.
  // organization.id is a varchar UUID, so the cursor is a UUID-shaped
  // string. PostgREST's .gt('id', cursorId) on a varchar column is a
  // lexicographic comparison, which is monotonic for UUIDs we generate
  // per row (id asc ordering preserved by our query).
  const startAfterIdRaw = options.startAfterId;
  let cursorId = null;
  if (startAfterIdRaw !== undefined && startAfterIdRaw !== null) {
    if (typeof startAfterIdRaw !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(startAfterIdRaw)) {
      throw new Error(`startAfterId must be a UUID-shaped id string (got ${JSON.stringify(startAfterIdRaw)})`);
    }
    cursorId = startAfterIdRaw;
  }
  const SAMPLE_CAP = 25;
  const summary = {
    tenant_id: tenantId,
    processed: 0,
    relinked: 0,
    already_linked: 0,
    no_match: 0,
    ambiguous: 0,
    failed: 0,
    skipped_no_value: 0
  };
  // Per-org outcome samples surfaced to the admin UI so a failed run is
  // diagnosable without grepping the sync log. Two buckets ensure the
  // diagnostic outcomes (failed/no_match/ambiguous/skipped_no_value) are
  // not crowded out by early already_linked rows in large tenants.
  const PROBLEM_STATUSES = new Set(['failed', 'no_match', 'ambiguous', 'skipped_no_value']);
  const PROBLEM_CAP = 20;
  const SUCCESS_CAP = 5;
  const problemSamples = [];
  const successSamples = [];
  const pushSample = (sample) => {
    if (PROBLEM_STATUSES.has(sample.status)) {
      if (problemSamples.length < PROBLEM_CAP) problemSamples.push(sample);
    } else if (successSamples.length < SUCCESS_CAP) {
      successSamples.push(sample);
    }
  };

  const { data: mapping } = await supabase
    .from('zoho_crm_sync_mapping')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('entity_type', 'organization')
    .maybeSingle();

  if (!mapping) {
    throw new Error('No organisation mapping configured for this tenant');
  }
  const zohoModule = mapping.zoho_module || 'Accounts';
  const uniqueKey = mapping.unique_key_field;
  if (!uniqueKey) throw new Error('Mapping has no unique_key_field configured');
  // Defence-in-depth: although unique_key_field is admin-controlled via the
  // mappings UI, refuse anything other than a plain Zoho API name so a
  // malicious value cannot break the criteria string syntax.
  if (!/^[A-Za-z0-9_]+$/.test(uniqueKey)) {
    throw new Error(`unique_key_field "${uniqueKey}" is not a valid Zoho API name`);
  }
  const localKey = resolveLocalKeyForZohoUnique(mapping);
  if (!localKey) {
    throw new Error(`unique_key_field "${uniqueKey}" is not paired with a core organisation column in field_mappings`);
  }
  // Whitelist the local column to prevent PostgREST select-string injection
  // via a tampered field_mappings JSON (the admin UI is the only writer, but
  // relying on it for injection safety is brittle).
  if (!ALLOWED_ORG_LOCAL_KEYS.has(localKey)) {
    throw new Error(`Local field "${localKey}" is not permitted as a relink unique key`);
  }

  // Paginate over the organization table — PostgREST caps a single .select()
  // at ~1000 rows, so an unpaged query would silently skip large tenants.
  // Use a monotonic id cursor (not OFFSET) so that successive invocations
  // from the admin UI can resume after the last org processed by the
  // previous run instead of re-validating the earlier ones.
  const PAGE = 500;
  // Vercel serverless functions get cut off at 60s; leave 10s headroom so we
  // can return a partial result instead of an HTML gateway error page.
  const startedAt = Date.now();
  const TIME_BUDGET_MS = 50_000;
  let truncated = false;
  let budgetExceeded = false;
  let lastProcessedId = null;
  // eslint-disable-next-line no-constant-condition
  outer: while (true) {
    let pageQuery = supabase
      .from('organization')
      .select(`id, name, zoho_crm_id, zoho_crm_module, ${localKey}`)
      .eq('tenant_id', tenantId)
      .order('id', { ascending: true })
      .limit(PAGE);
    if (cursorId !== null) {
      pageQuery = pageQuery.gt('id', cursorId);
    }
    const { data: orgs, error: orgErr } = await pageQuery;
    if (orgErr) throw orgErr;
    if (!orgs || orgs.length === 0) break;

    for (const org of orgs) {
      if (budgetExceeded) break outer;
      summary.processed += 1;
      const rawValue = org[localKey];
      try {
      // Trim leading/trailing whitespace before searching — the most common
      // real-world cause of a no-match against records that visibly exist in
      // Zoho. Zoho's :equals: search on string fields is already case-
      // insensitive, so case is not normalised here. Empty string after trim
      // is treated as no value.
      const matchValue = (typeof rawValue === 'string') ? rawValue.trim() : rawValue;
      const wasTrimmed = (typeof rawValue === 'string') && rawValue !== matchValue;

      try {
        // 1. Validate existing link if present — must check that Zoho's
        //    unique_key_field value still matches the iConnect value, not just
        //    that the record exists. A "mismatch" means the Zoho record was
        //    re-purposed and we should re-search instead of trusting the id.
        if (org.zoho_crm_id) {
          const existingModule = org.zoho_crm_module || zohoModule;
          if (existingModule === zohoModule) {
            const check = await validateExistingZohoLink(
              tenantId, zohoModule, org.zoho_crm_id, uniqueKey, matchValue
            );
            if (check.status === 'valid') {
              summary.already_linked += 1;
              const msg = `Already linked to valid ${zohoModule}/${org.zoho_crm_id}`;
              await writeLog({
                tenant_id: tenantId, entity_type: 'organization', entity_id: org.id,
                zoho_module: zohoModule, zoho_record_id: org.zoho_crm_id,
                status: 'skipped', direction: 'inbound', source, action: 'relink',
                error_message: msg
              });
              pushSample({
                org_id: org.id, org_name: org.name, local_value: matchValue,
                status: 'already_linked', message: msg, zoho_record_id: org.zoho_crm_id
              });
              continue;
            }
            // 'missing' or 'mismatch' → fall through and re-search
          }
        }

        // 2. (Re)search Zoho by unique key
        if (matchValue === undefined || matchValue === null || matchValue === '') {
          summary.skipped_no_value += 1;
          const msg = `Local field "${localKey}" is empty — cannot search Zoho`;
          await writeLog({
            tenant_id: tenantId, entity_type: 'organization', entity_id: org.id,
            zoho_module: zohoModule, status: 'skipped', direction: 'inbound',
            source, action: 'relink',
            error_message: msg
          });
          pushSample({
            org_id: org.id, org_name: org.name, local_value: rawValue,
            status: 'skipped_no_value', message: msg
          });
          continue;
        }

        const result = await searchZohoByUniqueKey(tenantId, zohoModule, uniqueKey, matchValue);

        if (result.status === 'error') {
          throw new Error(result.error);
        }
        if (result.status === 'none') {
          summary.no_match += 1;
          const trimNote = wasTrimmed ? ' (trimmed)' : '';
          const msg = `No ${zohoModule} found in Zoho where ${uniqueKey}="${matchValue}"${trimNote}`;
          await writeLog({
            tenant_id: tenantId, entity_type: 'organization', entity_id: org.id,
            zoho_module: zohoModule, status: 'skipped', direction: 'inbound',
            source, action: 'relink',
            error_message: msg
          });
          pushSample({
            org_id: org.id, org_name: org.name, local_value: matchValue,
            status: 'no_match', message: msg
          });
          continue;
        }
        if (result.status === 'many') {
          summary.ambiguous += 1;
          const msg = `Ambiguous: ${result.records.length} ${zohoModule} records in Zoho match ${uniqueKey}="${matchValue}"`;
          await writeLog({
            tenant_id: tenantId, entity_type: 'organization', entity_id: org.id,
            zoho_module: zohoModule, status: 'skipped', direction: 'inbound',
            source, action: 'relink',
            error_message: msg,
            response_payload: { matches: result.records.map(r => r.id) }
          });
          pushSample({
            org_id: org.id, org_name: org.name, local_value: matchValue,
            status: 'ambiguous', message: msg
          });
          continue;
        }

        // status === 'one'
        const newZohoId = result.records[0].id;
        const wasStale = !!org.zoho_crm_id && org.zoho_crm_id !== newZohoId;
        await persistZohoIdOnEntity(tenantId, 'organization', org.id, newZohoId, zohoModule);
        summary.relinked += 1;
        const msg = wasStale
          ? `Re-linked: stale id ${org.zoho_crm_id} → ${newZohoId}`
          : `Linked via ${uniqueKey}="${matchValue}" → ${newZohoId}`;
        await writeLog({
          tenant_id: tenantId, entity_type: 'organization', entity_id: org.id,
          zoho_module: zohoModule, zoho_record_id: newZohoId,
          status: 'success', direction: 'inbound', source, action: 'relink',
          error_message: msg,
          response_payload: { previous_zoho_crm_id: org.zoho_crm_id || null, new_zoho_crm_id: newZohoId }
        });
        pushSample({
          org_id: org.id, org_name: org.name, local_value: matchValue,
          status: 'relinked', message: msg, zoho_record_id: newZohoId
        });
      } catch (err) {
        console.error('[ZohoCrmSync] Relink error for org', org.id, err);
        summary.failed += 1;
        const msg = err?.message || String(err);
        await writeLog({
          tenant_id: tenantId, entity_type: 'organization', entity_id: org.id,
          zoho_module: zohoModule, status: 'failed', direction: 'inbound',
          source, action: 'relink',
          error_message: msg
        });
        pushSample({
          org_id: org.id, org_name: org.name, local_value: matchValue,
          status: 'failed', message: msg
        });
      }
      } finally {
        // Record this org as the last one we touched before enforcing
        // the budget, so the caller can resume strictly after it on
        // the next invocation — regardless of which branch handled it.
        lastProcessedId = org.id;
        // Enforce the time budget after every org regardless of which
        // branch (already_linked / no_match / ambiguous / etc.) handled
        // it. The inner try/catch above uses `continue` for those paths,
        // which would skip a check placed at the bottom of the for-body
        // — but a `finally` always runs before `continue` jumps to the
        // next iteration. We set the flag here and bail out at the top
        // of the next iteration via the labelled break above.
        if (Date.now() - startedAt > TIME_BUDGET_MS) {
          truncated = true;
          budgetExceeded = true;
        }
      }
    }

    // Catch the edge case where the budget was exceeded on the last org
    // of the page — the inner-loop's top-of-iteration check would not
    // fire again, so the outer `while` would otherwise fetch another
    // page before noticing.
    if (budgetExceeded) break;
    if (orgs.length < PAGE) break;
    // Advance the cursor to the last id we saw in this page so the next
    // .gt('id', cursorId) query starts strictly after it.
    cursorId = orgs[orgs.length - 1].id;
  }

  const completed = !truncated;
  if (truncated) {
    summary.truncated = true;
    summary.budget_exceeded = budgetExceeded;
    summary.last_processed_id = lastProcessedId;
  } else {
    summary.completed = true;
  }

  return {
    summary,
    truncated,
    completed,
    budget_exceeded: budgetExceeded,
    last_processed_id: lastProcessedId,
    config: {
      zoho_module: zohoModule,
      unique_key_field: uniqueKey,
      local_key: localKey
    },
    samples: [...problemSamples, ...successSamples]
  };
}

// ===========================================================================
// #463 remediation: re-push iConnect picklist values to Zoho for organisations
// where Zoho's stored picklist value differs from the iConnect value by dash
// style only (or where Zoho is empty after a previous failed overwrite). The
// original bulk import compared raw strings, decided iConnect's hyphen and
// Zoho's en-dash were different, and pushed iConnect — which Zoho silently
// dropped because it was not a valid picklist option — leaving Account_Type
// blank on every linked Account.
//
// Dry-run by default. Returns a structured summary with up to N sample
// per-record diffs so an admin can review what would change before flipping
// `dryRun=false`. Honours the same Vercel time budget pattern as
// `relinkOrganizationsToZoho` and supports `startAfterId` for resumption.
//
// Targets: every organisation field_mapping row where the resolved Zoho
// field is `picklist` or `multiselectpicklist` (sourced from in-memory
// metadata via `enrichMappingFlagsFromMetadata`). Other field types are
// untouched.
//
// Per-record decision (per target field):
//   1. Resolve the iConnect source value. Empty → skip (we don't clear
//      Zoho values during a remediation pass).
//   2. Compute the Zoho-canonical form via `applyMappingValueOutbound`
//      (which now applies dash canonicalisation and any value_map).
//   3. Compare the canonical form against Zoho's current value:
//        - Byte-equal      → no fix
//        - Dash-equivalent → fix (this is the bug case)
//        - Zoho empty      → fix (recover from a previous failed overwrite)
//        - Real difference → leave alone (out of scope; admin can use the
//          standard import flow instead)
// ===========================================================================
export async function remediatePicklistDashes(tenantId, options = {}) {
  const dryRun = options.dryRun !== false; // dry-run by default
  const source = options.source || 'admin_remediate_picklist_dash';
  const TIME_BUDGET_MS = options.timeBudgetMs ?? 50_000;
  const PAGE = 200;
  const SAMPLE_CAP = 25;
  // #468: opt-in extension. When true, also re-push records whose Zoho
  // value differs from the canonical desired value AND the desired value
  // resolves to a known-active Zoho picklist option. This recovers
  // historical records where Zoho silently substituted its field
  // default (e.g. `Account_Type → Vendor`) after we previously sent an
  // unknown value. Off by default so the existing dash-only behaviour
  // is unchanged for callers that want it.
  const includeFieldDefaults = options.includeFieldDefaults === true;

  // #465: same dash-style remediation works for either side. Default to
  // 'organization' so existing callers (admin endpoint, scripts) don't
  // change behaviour.
  const entityType = options.entityType || 'organization';
  if (entityType !== 'organization' && entityType !== 'member') {
    throw new Error(`entityType must be 'organization' or 'member' (got ${JSON.stringify(entityType)})`);
  }
  const entityTable = ENTITY_TABLE[entityType];
  if (!entityTable) throw new Error(`No table configured for entityType ${entityType}`);

  let cursorId = null;
  if (options.startAfterId !== undefined && options.startAfterId !== null) {
    if (typeof options.startAfterId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(options.startAfterId)) {
      throw new Error(`startAfterId must be a UUID-shaped id string (got ${JSON.stringify(options.startAfterId)})`);
    }
    cursorId = options.startAfterId;
  }

  const { data: mapping, error: mappingErr } = await supabase
    .from('zoho_crm_sync_mapping')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('entity_type', entityType)
    .maybeSingle();
  if (mappingErr) throw mappingErr;
  if (!mapping) throw new Error(`No ${entityType} mapping configured for this tenant`);

  // Stamp is_picklist / is_multi_pick / _picklistOptions in-memory so
  // `applyMappingValueOutbound` below uses the metadata-aware canonicaliser.
  await enrichMappingFlagsFromMetadata(tenantId, mapping);

  const defaultModule = entityType === 'organization' ? 'Accounts' : 'Contacts';
  const zohoModule = mapping.zoho_module || defaultModule;
  const targetFields = (Array.isArray(mapping.field_mappings) ? mapping.field_mappings : [])
    .filter(m => m && m.iconnect_field && m.zoho_field && (m.is_picklist === true || m.is_multi_pick === true));

  const summary = {
    tenant_id: tenantId,
    entity_type: entityType,
    dry_run: dryRun,
    zoho_module: zohoModule,
    target_fields: targetFields.map(m => ({ zoho_field: m.zoho_field, iconnect_field: m.iconnect_field, is_multi_pick: !!m.is_multi_pick })),
    processed: 0,
    needs_fix: 0,
    fixed: 0,
    no_change: 0,
    skipped_no_iconnect_value: 0,
    real_diff: 0,
    failed: 0
  };
  const samples = [];

  if (targetFields.length === 0) {
    summary.message = 'No picklist or multi-pick field mappings configured';
    return { summary, samples, completed: true };
  }

  const startedAt = Date.now();
  let truncated = false;
  let lastProcessedId = null;
  const fieldList = ['id', ...targetFields.map(m => m.zoho_field)].join(',');

  // eslint-disable-next-line no-constant-condition
  outer: while (true) {
    let q = supabase
      .from(entityTable)
      .select('*')
      .eq('tenant_id', tenantId)
      .not('zoho_crm_id', 'is', null)
      .order('id', { ascending: true })
      .limit(PAGE);
    if (cursorId !== null) q = q.gt('id', cursorId);
    const { data: entities, error: entityErr } = await q;
    if (entityErr) throw entityErr;
    if (!entities || entities.length === 0) break;

    for (const entity of entities) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        truncated = true;
        break outer;
      }
      summary.processed += 1;
      lastProcessedId = entity.id;

      try {
        const customValues = await loadCustomFieldValues(tenantId, entityType, entity.id);

        let zohoRecord;
        try {
          const resp = await zohoCrmApiCall(
            tenantId,
            `/${zohoModule}/${encodeURIComponent(entity.zoho_crm_id)}?fields=${encodeURIComponent(fieldList)}`
          );
          zohoRecord = Array.isArray(resp?.data) ? resp.data[0] : null;
        } catch (err) {
          if (/\b404\b|invalid.?id|INVALID_DATA/i.test(err?.message || '')) {
            // Stale link — out of scope for this remediation; relink covers it.
            summary.no_change += 1;
            continue;
          }
          throw err;
        }
        if (!zohoRecord) {
          summary.no_change += 1;
          continue;
        }

        const fixesForRecord = {};
        const perFieldDetails = [];
        let anyIconnectValuePresent = false;

        for (const m of targetFields) {
          const rawIc = resolveMappedValue(m, entity, customValues);
          if (rawIc === undefined || rawIc === null || rawIc === '') continue;
          anyIconnectValuePresent = true;

          const desired = applyMappingValueOutbound(m, rawIc, []);
          if (desired === undefined) continue;

          const current = zohoRecord[m.zoho_field];
          const isEmptyCurrent =
            current === null || current === undefined || current === '' ||
            (Array.isArray(current) && current.length === 0);

          // Byte-equal check (multi-pick: order-sensitive and per-element
          // string-equal). Skip when already canonical.
          let sameOnTheWire = false;
          if (m.is_multi_pick) {
            const currArr = Array.isArray(current) ? current.map(v => String(v)) : (isEmptyCurrent ? [] : null);
            const desiredArr = Array.isArray(desired) ? desired.map(v => String(v)) : null;
            if (Array.isArray(currArr) && Array.isArray(desiredArr) &&
                currArr.length === desiredArr.length &&
                currArr.every((v, i) => v === desiredArr[i])) {
              sameOnTheWire = true;
            }
          } else {
            sameOnTheWire = (current === desired);
          }
          if (sameOnTheWire) continue;

          const dashOnlyDiff = !isEmptyCurrent && valuesMatchForMerge(m, rawIc, current);
          if (dashOnlyDiff) {
            fixesForRecord[m.zoho_field] = desired;
            perFieldDetails.push({
              zoho_field: m.zoho_field,
              current,
              desired,
              reason: 'dash_style_drift'
            });
          } else if (isEmptyCurrent) {
            fixesForRecord[m.zoho_field] = desired;
            perFieldDetails.push({
              zoho_field: m.zoho_field,
              current,
              desired,
              reason: 'zoho_empty'
            });
          } else {
            // Real semantic difference. By default, leave alone — admin
            // can fix via the normal import flow if intended.
            //
            // #468: when `includeFieldDefaults` is on AND the desired
            // value translates to a known-active Zoho picklist option
            // (i.e. the iConnect→Zoho translation is fully resolved and
            // would NOT be omitted by the outbound guard), re-push it.
            // This recovers historical records where Zoho silently
            // substituted its own field default after we previously
            // forwarded an unknown value. We deliberately do NOT touch
            // records where the desired value can't be resolved against
            // Zoho metadata — that's still an admin-import problem.
            const opts = m._picklistOptions;
            const desiredIsKnownOption = opts && opts.size > 0 && (
              m.is_multi_pick
                ? Array.isArray(desired) && desired.length > 0 &&
                  desired.every(v => typeof v === 'string' && opts.has(v))
                : typeof desired === 'string' && opts.has(desired)
            );
            if (includeFieldDefaults && desiredIsKnownOption) {
              fixesForRecord[m.zoho_field] = desired;
              perFieldDetails.push({
                zoho_field: m.zoho_field,
                current,
                desired,
                reason: 'zoho_field_default_substitution'
              });
            } else {
              summary.real_diff += 1;
            }
          }
        }

        if (!anyIconnectValuePresent) {
          summary.skipped_no_iconnect_value += 1;
          continue;
        }
        if (Object.keys(fixesForRecord).length === 0) {
          summary.no_change += 1;
          continue;
        }

        summary.needs_fix += 1;
        if (samples.length < SAMPLE_CAP) {
          samples.push({
            entity_type: entityType,
            entity_id: entity.id,
            entity_name: describeEntityForRemediationSample(entityType, entity),
            zoho_record_id: entity.zoho_crm_id,
            fixes: perFieldDetails
          });
        }

        if (dryRun) {
          await writeLog({
            tenant_id: tenantId, entity_type: entityType, entity_id: entity.id,
            zoho_module: zohoModule, zoho_record_id: entity.zoho_crm_id,
            status: 'skipped', direction: 'outbound', source, action: 'remediate_picklist_dash_dry_run',
            request_payload: fixesForRecord,
            response_payload: { fixes: perFieldDetails }
          });
          continue;
        }

        const result = await updateZohoCrmRecordById(tenantId, zohoModule, entity.zoho_crm_id, fixesForRecord);
        if (result?.success) {
          summary.fixed += 1;
          await writeLog({
            tenant_id: tenantId, entity_type: entityType, entity_id: entity.id,
            zoho_module: zohoModule, zoho_record_id: entity.zoho_crm_id,
            status: 'success', direction: 'outbound', source, action: 'remediate_picklist_dash',
            request_payload: fixesForRecord,
            response_payload: { fixes: perFieldDetails }
          });
        } else {
          summary.failed += 1;
          await writeLog({
            tenant_id: tenantId, entity_type: entityType, entity_id: entity.id,
            zoho_module: zohoModule, zoho_record_id: entity.zoho_crm_id,
            status: 'failed', direction: 'outbound', source, action: 'remediate_picklist_dash',
            error_message: result?.error || 'Zoho update returned non-success',
            request_payload: fixesForRecord,
            response_payload: { fixes: perFieldDetails, raw: result?.raw || result?.details || null }
          });
        }
      } catch (err) {
        summary.failed += 1;
        await writeLog({
          tenant_id: tenantId, entity_type: entityType, entity_id: entity.id,
          zoho_module: zohoModule, zoho_record_id: entity.zoho_crm_id || null,
          status: 'failed', direction: 'outbound', source, action: 'remediate_picklist_dash',
          error_message: err?.message || String(err)
        });
      }
    }

    if (entities.length < PAGE) break;
    cursorId = entities[entities.length - 1].id;
  }

  if (truncated) {
    summary.truncated = true;
    summary.last_processed_id = lastProcessedId;
  } else {
    summary.completed = true;
  }
  return { summary, samples, completed: !truncated, truncated, last_processed_id: lastProcessedId };
}

// ===========================================================================
// One-time bulk import: Zoho CRM → iConnect.
// Honours the configured field_mappings and is idempotent (safe to re-run).
//
// Merge rules for the UPDATE path are unified across entity types — iConnect
// is treated as the source of truth in the one-time import. For each mapped
// field:
//   - iConnect populated, Zoho empty       → push iConnect value to Zoho
//                                            (#451 backfill behaviour, kept).
//   - iConnect populated, Zoho populated,
//     values differ                        → push iConnect value to Zoho
//                                            (overwrite). iConnect is NOT
//                                            modified — this deliberately
//                                            flips away from the previous
//                                            "non-empty Zoho overrides
//                                            iConnect" rule for members.
//   - iConnect populated, Zoho populated,
//     values match                         → no-op (`match`).
//   - iConnect empty, Zoho populated       → write Zoho value into iConnect
//                                            (existing fill-blank inbound
//                                            behaviour).
//   - Both empty                           → no-op (`zoho_empty`).
//
// CREATE behaviour is the same for both: a brand-new iConnect record is
// populated from every non-empty mapped Zoho value.
// ===========================================================================

const NATURAL_KEY_FIELD = {
  member: 'email',
  organization: 'name'
};

function isEmptyZohoValue(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string' && v.trim() === '') return true;
  return false;
}

// Used by the one-time import to decide whether an iConnect field is
// "empty" and therefore eligible to be filled from a Zoho value.
// Mirrors isEmptyZohoValue so the two sides are judged consistently.
function isEmptyIconnectValue(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string' && v.trim() === '') return true;
  return false;
}

// Compare an iConnect value and a Zoho value using the same canonicalisation
// the hash plumbing uses (sorted multi-pick arrays, etc.). Used by the
// one-time import UPDATE path to decide between `match` (no-op) and
// `iconnect_overwrites_zoho` (push iConnect value to Zoho). The deep-stringify
// fallback handles arrays/objects while keeping primitive comparison cheap.
export function valuesMatchForMerge(mapping, iconnectValue, zohoValue) {
  const a = canonicalizeForHash(mapping, iconnectValue);
  const b = canonicalizeForHash(mapping, zohoValue);
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    // Multi-pick is canonicalised (sorted) above so element i should
    // match element i. Compare with dash-equivalence so a single
    // hyphen-vs-en-dash drift on any picklist value doesn't classify
    // the whole array as a real mismatch (#463).
    for (let i = 0; i < a.length; i++) {
      if (!dashEquivalent(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === 'object' || typeof b === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  // Primitive comparison: string-coerce to handle Zoho-stringified
  // numbers vs iConnect numbers, then dash-normalise so hyphen / en-dash
  // / em-dash drift on picklist text isn't treated as a real diff
  // (#463). Dash-normalisation is a no-op for content with no dash
  // characters.
  return normalizeDashesForCompare(String(a)) === normalizeDashesForCompare(String(b));
}

// Build a flat list of {scope, field, zohoValue, beforeValue, afterValue}
// describing the fields that would actually be written. Used by the dry-run
// preview path so the admin can review the per-field diff before going live.
function buildDiffs({ coreUpdates, customUpdates, coreToWrite, customToWrite, linkPatch, entity, currentCustom, isCreate }) {
  const diffs = [];
  for (const [field, afterValue] of Object.entries(coreToWrite)) {
    diffs.push({
      scope: 'core',
      field,
      zohoValue: coreUpdates[field],
      beforeValue: isCreate ? null : (entity ? entity[field] ?? null : null),
      afterValue
    });
  }
  for (const [field, afterValue] of Object.entries(customToWrite)) {
    diffs.push({
      scope: 'custom',
      field,
      zohoValue: customUpdates[field],
      beforeValue: isCreate ? null : ((currentCustom && currentCustom[field]) ?? null),
      afterValue
    });
  }
  if (linkPatch) {
    diffs.push({
      scope: 'link',
      field: 'zoho_crm_id',
      zohoValue: linkPatch.zoho_crm_id,
      beforeValue: isCreate ? null : (entity ? entity.zoho_crm_id ?? null : null),
      afterValue: linkPatch.zoho_crm_id
    });
    diffs.push({
      scope: 'link',
      field: 'zoho_crm_module',
      zohoValue: linkPatch.zoho_crm_module,
      beforeValue: isCreate ? null : (entity ? entity.zoho_crm_module ?? null : null),
      afterValue: linkPatch.zoho_crm_module
    });
  }
  return diffs;
}

function summariseEntity(entity, entityType) {
  if (!entity) return null;
  const naturalKey = NATURAL_KEY_FIELD[entityType];
  return {
    id: entity.id,
    naturalKey: naturalKey ? { field: naturalKey, value: entity[naturalKey] ?? null } : null,
    zoho_crm_id: entity.zoho_crm_id ?? null,
    zoho_crm_module: entity.zoho_crm_module ?? null
  };
}

/**
 * Push a one-time-import "iConnect → Zoho" payload — combining both the
 * blank-backfill fields (Zoho was empty, iConnect had a value) and the
 * overwrite fields (both sides populated, values disagreed) — to Zoho via
 * the standard `updateZohoCrmRecordById` path. A single PUT covers both
 * groups so picklists / multi-pick / rich-text values are all routed
 * through the same `applyMappingValueOutbound` translation already used by
 * the regular outbound sync.
 *
 * Wrapped in a try/catch so a Zoho-side failure does not roll back the
 * inbound write that has already landed for the same record.
 *
 * On success: records the canonical outbound payload hash via
 * `recordSyncState(..., 'outbound', ...)` so the next inbound poll (and
 * the inbound webhook path, when it next sees this record) recognises the
 * round-trip via the existing echo guard, and writes a
 * `direction: 'outbound'` success log row tagged with the same `action`
 * and `source` as the inbound side.
 *
 * On failure: writes a `direction: 'outbound'` failed log row and
 * returns `{ success: false, error }` so the caller can increment the
 * matching `*_failed` counters on the bulk summary without aborting the
 * whole import run.
 *
 * The outbound hash is computed from a synthetic inbound view of what the
 * next poll *would* observe after this push lands: existing
 * `coreUpdates`/`customUpdates` (everything else Zoho returned this pass)
 * overlaid with the iConnect raw values for every field we just sent —
 * blank-backfilled and overwritten alike. Multi-pick canonicalisation is
 * handled by `canonicalizeInboundForHash` so the hash matches even when
 * Zoho returns array elements in a different order than we sent.
 */
async function pushIconnectChangesToZoho({
  tenantId, entityType, entity, mapping, zohoModule, zohoId,
  pushToZoho, backfilledFields, overwrittenFields, truncatedFields, invalidUrlFields,
  coreUpdates, customUpdates,
  currentCustom, source, action, zohoRecord
}) {
  if (!zohoId) {
    return { success: false, error: 'Cannot push iConnect values to Zoho: missing zoho_crm_id' };
  }
  const responseSummary = {
    backfilled_fields: backfilledFields,
    overwritten_fields: overwrittenFields,
    ...(Array.isArray(truncatedFields) && truncatedFields.length > 0
      ? { truncated_fields: truncatedFields }
      : {}),
    ...(Array.isArray(invalidUrlFields) && invalidUrlFields.length > 0
      ? { invalid_url_fields: invalidUrlFields }
      : {})
  };
  try {
    const result = await updateZohoCrmRecordById(tenantId, zohoModule, zohoId, pushToZoho);
    if (!result.success) {
      const errorMessage = `Push to Zoho failed: ${result.error || 'Unknown error'}`;
      await writeLog({
        tenant_id: tenantId, entity_type: entityType, entity_id: entity.id,
        zoho_module: zohoModule, zoho_record_id: zohoId,
        status: 'failed', direction: 'outbound', source, action,
        error_message: errorMessage,
        request_payload: pushToZoho,
        response_payload: { ...(result.details || result.raw || {}), ...responseSummary }
      });
      return { success: false, error: errorMessage };
    }

    // Build a synthetic inbound view to compute the outbound hash. For
    // every field we just pushed (backfill + overwrite) the next inbound
    // poll will see Zoho returning (the round-trip of) the iConnect raw
    // values; for everything else it will see whatever Zoho currently has
    // (`coreUpdates` / `customUpdates`).
    const syntheticCore = { ...(coreUpdates || {}) };
    const syntheticCustom = { ...(customUpdates || {}) };
    for (const m of mapping.field_mappings || []) {
      if (!m?.zoho_field || !Object.prototype.hasOwnProperty.call(pushToZoho, m.zoho_field)) continue;
      const isCustom = m.iconnect_field?.startsWith('custom:');
      if (isCustom) {
        const customId = m.iconnect_field.slice('custom:'.length);
        syntheticCustom[customId] = currentCustom?.[customId];
      } else if (m.iconnect_field) {
        syntheticCore[m.iconnect_field] = entity[m.iconnect_field];
      }
    }
    const outboundHash = computeHash(canonicalizeInboundForHash(mapping, syntheticCore, syntheticCustom));
    await recordSyncState(tenantId, entityType, entity.id, 'outbound', outboundHash);

    await writeLog({
      tenant_id: tenantId, entity_type: entityType, entity_id: entity.id,
      zoho_module: zohoModule, zoho_record_id: zohoId,
      status: 'success', direction: 'outbound', source, action,
      payload_hash: outboundHash,
      request_payload: pushToZoho,
      response_payload: { ...(result.details || {}), ...responseSummary }
    });
    return { success: true, fields_count: Object.keys(pushToZoho).length };
  } catch (err) {
    const errorMessage = `Push to Zoho threw: ${err?.message || String(err)}`;
    try {
      await writeLog({
        tenant_id: tenantId, entity_type: entityType, entity_id: entity.id,
        zoho_module: zohoModule, zoho_record_id: zohoId,
        status: 'failed', direction: 'outbound', source, action,
        error_message: errorMessage,
        request_payload: pushToZoho,
        response_payload: responseSummary
      });
    } catch (logErr) {
      console.error('[ZohoCrmSync] iConnect→Zoho push failure log write failed:', logErr);
    }
    return { success: false, error: errorMessage };
  }
}

async function importOneRecord(tenantId, entityType, mapping, zohoModule, zohoRecord, source, options = {}) {
  const dryRun = options.dryRun === true;
  const action = options.action || 'one_time_import';
  // Merge rich-text values that Zoho hides from the regular GET payload.
  // No-op for mappings without rich-text fields.
  zohoRecord = await enrichRecordWithRichText(tenantId, mapping, zohoModule, zohoRecord);
  const zohoId = zohoRecord?.id || zohoRecord?.Id || null;

  // 1. Resolve existing iConnect record: zoho id first, then natural key.
  let entity = null;
  let matchedBy = null;
  if (zohoId) {
    entity = await findEntityByZohoId(tenantId, entityType, zohoModule, zohoId);
    if (entity) matchedBy = 'zoho_id';
  }
  if (!entity) {
    const naturalKey = NATURAL_KEY_FIELD[entityType];
    const m = (mapping.field_mappings || []).find(r => r.iconnect_field === naturalKey);
    // Fall back to Zoho's standard field for the natural key if the admin's
    // mapping doesn't include it explicitly (Email for Contacts/Leads,
    // Account_Name for Accounts). Without this we'd silently create
    // duplicates when the natural-key field isn't mapped.
    const DEFAULT_ZOHO_NATURAL_KEY_FIELD = {
      Contacts: 'Email',
      Leads: 'Email',
      Accounts: 'Account_Name'
    };
    const zohoFieldForKey = m?.zoho_field || DEFAULT_ZOHO_NATURAL_KEY_FIELD[zohoModule];
    let matchValue = zohoFieldForKey ? zohoRecord[zohoFieldForKey] : null;
    if (matchValue !== undefined && matchValue !== null && matchValue !== '') {
      if (naturalKey === 'email') matchValue = String(matchValue).toLowerCase();
      const result = await findEntityByUniqueField(tenantId, entityType, naturalKey, matchValue);
      if (result.entity) {
        entity = result.entity;
        matchedBy = 'natural_key';
        if (zohoId && !dryRun) await persistZohoIdOnEntity(tenantId, entityType, entity.id, zohoId, zohoModule);
      } else if (result.reason === 'ambiguous') {
        const errorMessage = `Ambiguous: ${result.count}+ iConnect ${entityType}s match ${naturalKey}="${matchValue}" — resolve manually`;
        let logId = null;
        if (!dryRun) {
          const logRow = await writeLog({
            tenant_id: tenantId, entity_type: entityType, entity_id: null,
            zoho_module: zohoModule, zoho_record_id: zohoId,
            status: 'skipped', direction: 'inbound', source, action,
            error_message: errorMessage,
            request_payload: zohoRecord
          });
          logId = logRow?.id || null;
        }
        return { outcome: 'ambiguous', matched: null, matchedBy: null, message: errorMessage, diffs: [], logId };
      } else if (result.reason === 'error') {
        throw new Error(`Natural-key lookup failed: ${result.error}`);
      }
    }
  }

  const { coreUpdates, customUpdates } = buildReversePayload(mapping, zohoRecord);
  if (entityType === 'member' && typeof coreUpdates.email === 'string') {
    coreUpdates.email = coreUpdates.email.toLowerCase();
  }

  if (!entity) {
    // CREATE: only include fields with a non-empty Zoho value.
    const insertRow = { tenant_id: tenantId };
    if (zohoId) {
      insertRow.zoho_crm_id = zohoId;
      insertRow.zoho_crm_module = zohoModule;
    }
    const coreToWrite = {};
    const customToWrite = {};
    // Per-mapping diagnostic mirroring the UPDATE path. On CREATE the only
    // possible skip reason is `zoho_empty` because the iConnect entity
    // doesn't exist yet, so there's no iconnect-side value to defer to.
    const skippedFields = [];
    let mappedCount = 0;
    for (const m of mapping.field_mappings || []) {
      const iconnectField = m?.iconnect_field;
      const zohoField = m?.zoho_field;
      if (!iconnectField || !zohoField) continue;
      const isCustom = iconnectField.startsWith('custom:');
      const customId = isCustom ? iconnectField.slice('custom:'.length) : null;
      const zohoHas = isCustom
        ? Object.prototype.hasOwnProperty.call(customUpdates, customId)
        : Object.prototype.hasOwnProperty.call(coreUpdates, iconnectField);
      const zohoValue = isCustom ? customUpdates[customId] : coreUpdates[iconnectField];
      if (!zohoHas || isEmptyZohoValue(zohoValue)) {
        skippedFields.push({
          iconnect_field: iconnectField,
          zoho_field: zohoField,
          zoho_value: zohoHas ? (zohoValue ?? null) : null,
          iconnect_value: null,
          reason: 'zoho_empty'
        });
        continue;
      }
      if (isCustom) {
        customToWrite[customId] = zohoValue;
      } else {
        insertRow[iconnectField] = zohoValue;
        coreToWrite[iconnectField] = zohoValue;
      }
      mappedCount += 1;
    }
    if (mappedCount === 0) {
      const errorMessage = 'Skipped create: Zoho record has no non-empty mapped values';
      let logId = null;
      if (!dryRun) {
        const logRow = await writeLog({
          tenant_id: tenantId, entity_type: entityType, entity_id: null,
          zoho_module: zohoModule, zoho_record_id: zohoId,
          status: 'skipped', direction: 'inbound', source, action,
          error_message: errorMessage,
          request_payload: zohoRecord
        });
        logId = logRow?.id || null;
      }
      return { outcome: 'no_mapped_values', matched: null, matchedBy: null, message: errorMessage, diffs: [], skipped_fields: skippedFields, logId };
    }
    const linkPatch = zohoId ? { zoho_crm_id: zohoId, zoho_crm_module: zohoModule } : null;
    const diffs = buildDiffs({
      coreUpdates, customUpdates, coreToWrite, customToWrite, linkPatch,
      entity: null, currentCustom: null, isCreate: true
    });
    if (dryRun) {
      return {
        outcome: 'created',
        matched: null,
        matchedBy: null,
        coreToWrite,
        customToWrite,
        linkPatch,
        diffs,
        skipped_fields: skippedFields
      };
    }
    const table = ENTITY_TABLE[entityType];
    const { data: created, error } = await supabase
      .from(table)
      .insert(insertRow)
      .select()
      .single();
    if (error) throw error;
    markInboundOrigin(tenantId, entityType, created.id);
    if (Object.keys(customToWrite).length > 0) {
      try {
        await applyCustomFieldUpdates(tenantId, entityType, created.id, customToWrite);
      } catch (writeErr) {
        const errorMessage = `Custom field write failed after entity create: ${writeErr?.message || String(writeErr)}`;
        const logRow = await writeLog({
          tenant_id: tenantId, entity_type: entityType, entity_id: created.id,
          zoho_module: zohoModule, zoho_record_id: zohoId,
          status: 'failed', direction: 'inbound', source, action,
          error_message: errorMessage,
          request_payload: zohoRecord,
          response_payload: { created: true, core: insertRow, custom: customToWrite }
        });
        return {
          outcome: 'failed',
          matched: summariseEntity(created, entityType),
          matchedBy: 'created',
          coreToWrite,
          customToWrite,
          linkPatch,
          diffs,
          message: errorMessage,
          logId: logRow?.id || null
        };
      }
    }
    // Canonicalize so multi-pick array order doesn't ping-pong between
    // outbound and inbound hashes (matches `applyInboundFromZoho`).
    const payloadHash = computeHash(canonicalizeInboundForHash(mapping, coreUpdates, customUpdates));
    await recordSyncState(tenantId, entityType, created.id, 'inbound', payloadHash);
    const logRow = await writeLog({
      tenant_id: tenantId, entity_type: entityType, entity_id: created.id,
      zoho_module: zohoModule, zoho_record_id: zohoId,
      status: 'success', direction: 'inbound', source, action,
      payload_hash: payloadHash,
      request_payload: zohoRecord,
      response_payload: { created: true, core: insertRow, custom: customToWrite }
    });
    return {
      outcome: 'created',
      matched: summariseEntity(created, entityType),
      matchedBy: 'created',
      coreToWrite,
      customToWrite,
      linkPatch,
      diffs,
      logId: logRow?.id || null
    };
  }

  // Fast no-op short-circuit for the UPDATE branch. Bulk imports re-fetch
  // every Zoho record on every chunk, and the vast majority of those are
  // already in sync. Without this guard each "no-op" record still pays
  // for a custom-field load, a module-fields metadata fetch, and a
  // sync_log row write — ~400-600ms of Supabase round-trips per record.
  // With a 40s per-invocation time budget the chunk loop bails mid-page
  // before advancing, so the same ~70 records get reprocessed forever.
  //
  // The short-circuit is safe to take only when ALL of:
  //   1. The inbound payload hash matches the last inbound write (Zoho
  //      hasn't changed anything mapped since we last imported), AND
  //   2. The iConnect entity hasn't been locally modified since that
  //      last inbound (so there's nothing to push back to Zoho), AND
  //   3. No custom-field value has been locally modified since that last
  //      inbound either — `applyCustomFieldUpdates` only bumps the
  //      pref-value row's `updated_at`, NOT the parent entity's, so
  //      relying on `entity.updated_at` alone would skip pushing
  //      legitimate iConnect→Zoho custom-field changes, AND
  //   4. The entity's `zoho_crm_id` / `zoho_crm_module` already match
  //      the inbound record so there's no link patch we'd be skipping.
  //
  // If any condition fails we fall through to the full merge below so
  // backfills, overwrites, link patching, and conflict resolution still
  // run.
  const fastNoopHash = computeHash(canonicalizeInboundForHash(mapping, coreUpdates, customUpdates));
  const linkAlreadyMatches =
    !zohoId ||
    (entity.zoho_crm_id === zohoId && entity.zoho_crm_module === zohoModule);
  if (linkAlreadyMatches && entity.updated_at) {
    const fastNoopState = await getSyncState(tenantId, entityType, entity.id, 'inbound');
    if (
      fastNoopState &&
      fastNoopState.payload_hash === fastNoopHash &&
      fastNoopState.last_synced_at &&
      new Date(entity.updated_at).getTime() <= new Date(fastNoopState.last_synced_at).getTime()
    ) {
      const lastInboundMs = new Date(fastNoopState.last_synced_at).getTime();
      // Custom-field freshness: a single MAX(updated_at) read on the
      // pref-value table for this entity. Cheap (single round-trip,
      // indexed on the FK) and avoids the architect-flagged correctness
      // gap where local custom-field edits would be silently skipped.
      const prefTable = PREF_VALUE_TABLE[entityType];
      const prefFk = PREF_VALUE_FK[entityType];
      let customLocalNewer = false;
      let customCheckErrored = false;
      if (prefTable && prefFk) {
        const { data: latestCustom, error: latestCustomError } = await supabase
          .from(prefTable)
          .select('updated_at')
          .eq(prefFk, entity.id)
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (latestCustomError) {
          // Don't risk a false-positive no-op skip on a transient DB
          // read failure — fall through to the full merge instead.
          customCheckErrored = true;
        } else if (latestCustom?.updated_at) {
          customLocalNewer = new Date(latestCustom.updated_at).getTime() > lastInboundMs;
        }
      }
      if (!customLocalNewer && !customCheckErrored) {
        return {
          outcome: 'no_change',
          matched: summariseEntity(entity, entityType),
          matchedBy,
          message: 'No-op: payload identical to last inbound sync and iConnect unchanged (fast path)',
          diffs: [],
          skipped_fields: [],
          backfilled_fields: [],
          overwritten_fields: [],
          truncated_fields: [],
          invalid_url_fields: [],
          logId: null
        };
      }
    }
  }

  // UPDATE: unified merge rule for both `organization` and `member` —
  // iConnect is the source of truth. Per mapped field:
  //   - Zoho empty + iConnect populated → schedule a backfill push to Zoho
  //     (the iConnect value rounds-trips out so Zoho catches up).
  //   - Both populated, values differ   → schedule an overwrite push to
  //     Zoho. iConnect is NOT modified — this deliberately flips away
  //     from the previous "non-empty Zoho overrides iConnect" rule that
  //     used to apply to members.
  //   - Both populated, values match    → no-op (`match`).
  //   - iConnect empty + Zoho populated → write the Zoho value into
  //     iConnect (existing fill-blank inbound behaviour).
  //   - Both empty                       → no-op (`zoho_empty`).
  const currentCustom = await loadCustomFieldValues(tenantId, entityType, entity.id);
  const coreToWrite = {};
  const customToWrite = {};
  // Per-mapping diagnostic for fields that did not make it into
  // coreToWrite/customToWrite. Surfaced on the dry-run preview so admins can
  // see at a glance whether the no-op is because Zoho returned nothing, the
  // values already matched, or a translation gap blocked an iConnect→Zoho
  // push. Iterate `mapping.field_mappings` directly so we have both the
  // iConnect-side and Zoho-side field identifiers for each entry.
  const skippedFields = [];
  // Combined "iConnect → Zoho" payload, keyed by Zoho field name. Holds
  // BOTH blank-backfill entries (Zoho was empty, iConnect had a value)
  // and overwrite entries (both sides populated, values disagreed). Sent
  // to Zoho in one `updateZohoCrmRecordById` call by `pushIconnectChangesToZoho`
  // so picklists / multi-pick arrays / rich-text are shaped the way Zoho
  // expects (same code path as the regular outbound sync).
  const pushToZoho = {};
  const backfilledFields = [];
  const overwrittenFields = [];
  // Field-level length clamps applied to outbound push values. Populated
  // lazily from cached `getZohoCrmModuleFields` metadata — one fetch per
  // module per 5 min cache window, so a 1000-record import incurs a single
  // metadata round-trip per chunk. A failure here (network blip, expired
  // token, etc.) is non-fatal: we leave the map empty and the clamp
  // becomes a no-op, restoring the pre-fix behaviour where the user
  // sees the original Zoho 400 instead of a silent partial push.
  let zohoFieldsByApiName = null;
  try {
    const zohoFields = await getZohoCrmModuleFields(tenantId, zohoModule);
    zohoFieldsByApiName = new Map();
    for (const f of zohoFields || []) {
      if (f?.api_name) zohoFieldsByApiName.set(f.api_name, f);
    }
  } catch (err) {
    console.warn('[ZohoCrmSync] Could not load module field metadata for length clamp on', zohoModule, '-', err?.message || err);
    zohoFieldsByApiName = new Map();
  }
  // Recorded clamp events so the per-record result can surface them in the
  // admin UI (and so admins notice when a long field has been silently
  // shortened). Shape: `{ iconnect_field, zoho_field, max_length,
  // original_length }`. Never includes the raw value to avoid logging
  // potentially long PII into response payloads.
  const truncatedFields = [];
  function clampPushValue(m, translated) {
    const meta = zohoFieldsByApiName.get(m.zoho_field);
    if (!meta) return translated;
    const { value, truncated } = clampValueToZohoLength(meta, translated);
    if (truncated) {
      truncatedFields.push({
        iconnect_field: m.iconnect_field,
        zoho_field: m.zoho_field,
        max_length: truncated.max_length,
        original_length: truncated.original_length
      });
    }
    return value;
  }
  // URL-shape coercion for Zoho `website` / `url` data_types. Returns
  // `{ ok: true, value }` for keep-the-field cases (already valid, or
  // we auto-prefixed `https://`) and `{ ok: false }` for drop-the-field
  // cases (free text, `@handle`, etc.). The caller must drop the field
  // from the outbound payload on `ok: false` so the rest of the
  // record's changes still push successfully. Tracked in
  // `invalidUrlFields` for the per-record result and bulk summary —
  // shape: `{ iconnect_field, zoho_field, reason }`. Never includes the
  // raw value to avoid logging arbitrary user text into response
  // payloads.
  const invalidUrlFields = [];
  function coercePushUrl(m, translated) {
    const meta = zohoFieldsByApiName.get(m.zoho_field);
    // No metadata → can't tell if it's a URL field → leave the value
    // alone (caller may still 400, identical to pre-fix behaviour).
    if (!meta) return { ok: true, value: translated };
    if (!isUrlDataType(meta.data_type)) return { ok: true, value: translated };
    const r = coerceUrlValueForZoho(meta, translated);
    if (r.ok) return { ok: true, value: r.value };
    invalidUrlFields.push({
      iconnect_field: m.iconnect_field,
      zoho_field: m.zoho_field,
      reason: r.reason || 'not_a_url'
    });
    return { ok: false };
  }
  for (const m of mapping.field_mappings || []) {
    const iconnectField = m?.iconnect_field;
    const zohoField = m?.zoho_field;
    if (!iconnectField || !zohoField) continue;
    const isCustom = iconnectField.startsWith('custom:');
    const customId = isCustom ? iconnectField.slice('custom:'.length) : null;
    const zohoHas = isCustom
      ? Object.prototype.hasOwnProperty.call(customUpdates, customId)
      : Object.prototype.hasOwnProperty.call(coreUpdates, iconnectField);
    const zohoValue = isCustom ? customUpdates[customId] : coreUpdates[iconnectField];
    const iconnectValue = isCustom
      ? (currentCustom ? currentCustom[customId] : undefined)
      : entity[iconnectField];
    const zohoEmpty = !zohoHas || isEmptyZohoValue(zohoValue);
    const iconnectEmpty = isEmptyIconnectValue(iconnectValue);

    if (zohoEmpty && iconnectEmpty) {
      skippedFields.push({
        iconnect_field: iconnectField,
        zoho_field: zohoField,
        zoho_value: zohoHas ? (zohoValue ?? null) : null,
        iconnect_value: null,
        reason: 'zoho_empty'
      });
      continue;
    }

    if (zohoEmpty) {
      // iConnect populated, Zoho empty → push iConnect → Zoho (backfill).
      const translatedRaw = applyMappingValueOutbound(m, iconnectValue, []);
      if (translatedRaw !== undefined) {
        const clamped = clampPushValue(m, translatedRaw);
        const urlCoerce = coercePushUrl(m, clamped);
        if (!urlCoerce.ok) {
          // Drop the field from the outbound payload so the rest of
          // the record's changes still push. The skip is recorded in
          // `invalidUrlFields` (PII-safe — api_name + reason only).
          continue;
        }
        const translated = urlCoerce.value;
        pushToZoho[zohoField] = translated;
        backfilledFields.push({
          iconnect_field: iconnectField,
          zoho_field: zohoField,
          zoho_value: null,
          iconnect_value: iconnectValue ?? null,
          translated_zoho_value: translated,
          reason: 'iconnect_to_zoho_backfill'
        });
        continue;
      }
      // Translation produced nothing — fall through to a plain skip so
      // the admin sees why no push was scheduled.
      skippedFields.push({
        iconnect_field: iconnectField,
        zoho_field: zohoField,
        zoho_value: null,
        iconnect_value: iconnectValue ?? null,
        reason: 'zoho_empty'
      });
      continue;
    }

    if (iconnectEmpty) {
      // iConnect empty, Zoho populated → write Zoho into iConnect (the
      // existing fill-blank inbound path). No outbound push for this
      // field.
      if (isCustom) {
        customToWrite[customId] = zohoValue;
      } else {
        coreToWrite[iconnectField] = zohoValue;
      }
      continue;
    }

    // Both sides populated. Compare to decide between match / overwrite.
    if (valuesMatchForMerge(m, iconnectValue, zohoValue)) {
      skippedFields.push({
        iconnect_field: iconnectField,
        zoho_field: zohoField,
        zoho_value: zohoValue,
        iconnect_value: iconnectValue ?? null,
        reason: 'match'
      });
      continue;
    }

    // Differing values — push iConnect → Zoho (overwrite). iConnect is
    // not modified. This is the new behaviour from #456 that flips the
    // member rule too.
    const translatedRaw = applyMappingValueOutbound(m, iconnectValue, []);
    if (translatedRaw !== undefined) {
      const clamped = clampPushValue(m, translatedRaw);
      const urlCoerce = coercePushUrl(m, clamped);
      if (!urlCoerce.ok) {
        // Drop the field from the outbound payload so the rest of the
        // record's changes still push. The skip is recorded in
        // `invalidUrlFields` (PII-safe — api_name + reason only).
        continue;
      }
      const translated = urlCoerce.value;
      pushToZoho[zohoField] = translated;
      overwrittenFields.push({
        iconnect_field: iconnectField,
        zoho_field: zohoField,
        zoho_value: zohoValue,
        iconnect_value: iconnectValue ?? null,
        translated_zoho_value: translated,
        reason: 'iconnect_overwrites_zoho'
      });
      continue;
    }

    // Translation gap — surface the skip so the admin can spot the
    // mapping issue rather than the disagreement silently persisting.
    skippedFields.push({
      iconnect_field: iconnectField,
      zoho_field: zohoField,
      zoho_value: zohoValue,
      iconnect_value: iconnectValue ?? null,
      reason: 'iconnect_populated'
    });
  }

  // Always backfill the zoho link if we found this row by natural key earlier
  // (persistZohoIdOnEntity already handled that), but if the entity has no
  // zoho_crm_id at all and we have one, set it on this update too.
  let linkPatch = null;
  if (zohoId && (!entity.zoho_crm_id || entity.zoho_crm_module !== zohoModule)) {
    linkPatch = { zoho_crm_id: zohoId, zoho_crm_module: zohoModule };
  }

  const matched = summariseEntity(entity, entityType);

  const hasPushToZoho = Object.keys(pushToZoho).length > 0;
  const hasBackfill = backfilledFields.length > 0;
  const hasOverwrite = overwrittenFields.length > 0;

  if (Object.keys(coreToWrite).length === 0 && Object.keys(customToWrite).length === 0 && !linkPatch) {
    let errorMessage;
    if (hasOverwrite && hasBackfill) {
      errorMessage = 'No-op on iConnect: overwriting differing Zoho values and backfilling Zoho-empty fields with iConnect data';
    } else if (hasOverwrite) {
      errorMessage = 'No-op on iConnect: overwriting differing Zoho values with iConnect data';
    } else if (hasBackfill) {
      errorMessage = 'No-op on iConnect: backfilling Zoho-empty fields with iConnect data';
    } else if (skippedFields.some(s => s.reason === 'match')) {
      errorMessage = 'No-op: every populated Zoho value already matches iConnect';
    } else {
      errorMessage = 'No-op: Zoho returned no non-empty values for any mapped field and iConnect has nothing to push back';
    }
    let logId = null;
    if (!dryRun) {
      const logRow = await writeLog({
        tenant_id: tenantId, entity_type: entityType, entity_id: entity.id,
        zoho_module: zohoModule, zoho_record_id: zohoId,
        status: 'skipped', direction: 'inbound', source, action,
        error_message: errorMessage,
        request_payload: zohoRecord
      });
      logId = logRow?.id || null;
    }
    // Even when there are no inbound changes, we may still need to push
    // iConnect values back to Zoho — both blank-backfills (Zoho was
    // empty) and overwrites of differing Zoho values.
    let pushResult = null;
    if (hasPushToZoho && !dryRun) {
      pushResult = await pushIconnectChangesToZoho({
        tenantId, entityType, entity, mapping, zohoModule, zohoId,
        pushToZoho, backfilledFields, overwrittenFields, truncatedFields, invalidUrlFields,
        coreUpdates, customUpdates,
        currentCustom, source, action, zohoRecord
      });
    }
    const pushFailed = pushResult && !pushResult.success;
    return {
      outcome: 'no_change',
      matched,
      matchedBy,
      message: errorMessage,
      diffs: [],
      skipped_fields: skippedFields,
      backfilled_fields: backfilledFields,
      overwritten_fields: overwrittenFields,
      truncated_fields: truncatedFields,
      invalid_url_fields: invalidUrlFields,
      backfill_failed: pushFailed && hasBackfill
        ? { fields: backfilledFields.map(f => f.zoho_field), error: pushResult.error }
        : null,
      overwrite_failed: pushFailed && hasOverwrite
        ? { fields: overwrittenFields.map(f => f.zoho_field), error: pushResult.error }
        : null,
      logId
    };
  }

  const diffs = buildDiffs({
    coreUpdates, customUpdates, coreToWrite, customToWrite, linkPatch,
    entity, currentCustom, isCreate: false
  });

  if (dryRun) {
    return {
      outcome: 'updated',
      matched,
      matchedBy,
      coreToWrite,
      customToWrite,
      linkPatch,
      diffs,
      skipped_fields: skippedFields,
      backfilled_fields: backfilledFields,
      overwritten_fields: overwrittenFields,
      truncated_fields: truncatedFields,
      invalid_url_fields: invalidUrlFields
    };
  }

  markInboundOrigin(tenantId, entityType, entity.id);
  const table = ENTITY_TABLE[entityType];
  const updatePayload = { ...coreToWrite, ...(linkPatch || {}) };
  if (Object.keys(updatePayload).length > 0) {
    const { error } = await supabase
      .from(table)
      .update({ ...updatePayload, updated_at: new Date().toISOString() })
      .eq('id', entity.id)
      .eq('tenant_id', tenantId);
    if (error) throw error;
  }
  if (Object.keys(customToWrite).length > 0) {
    try {
      await applyCustomFieldUpdates(tenantId, entityType, entity.id, customToWrite);
    } catch (writeErr) {
      const errorMessage = `Custom field write failed after entity update: ${writeErr?.message || String(writeErr)}`;
      const logRow = await writeLog({
        tenant_id: tenantId, entity_type: entityType, entity_id: entity.id,
        zoho_module: zohoModule, zoho_record_id: zohoId,
        status: 'failed', direction: 'inbound', source, action,
        error_message: errorMessage,
        request_payload: zohoRecord,
        response_payload: { core: coreToWrite, custom: customToWrite, link: linkPatch }
      });
      return {
        outcome: 'failed',
        matched,
        matchedBy,
        coreToWrite,
        customToWrite,
        linkPatch,
        diffs,
        message: errorMessage,
        logId: logRow?.id || null
      };
    }
  }
  // Canonicalize so multi-pick array order doesn't ping-pong between
  // outbound and inbound hashes (matches `applyInboundFromZoho`). The
  // `linkPatch` is folded in afterwards — it's never multi-pick (just
  // Zoho_CRM_link_id housekeeping) so no canonicalisation is needed.
  const payloadHash = computeHash({
    ...canonicalizeInboundForHash(mapping, coreToWrite, customToWrite),
    ...(linkPatch || {})
  });
  await recordSyncState(tenantId, entityType, entity.id, 'inbound', payloadHash);
  const logRow = await writeLog({
    tenant_id: tenantId, entity_type: entityType, entity_id: entity.id,
    zoho_module: zohoModule, zoho_record_id: zohoId,
    status: 'success', direction: 'inbound', source, action,
    payload_hash: payloadHash,
    request_payload: zohoRecord,
    response_payload: { core: coreToWrite, custom: customToWrite, link: linkPatch }
  });

  // Push iConnect values back to Zoho — both blank-backfill fields (Zoho
  // was empty) and overwrite fields (both populated, values disagreed).
  // Runs after the inbound write has landed (so `zoho_crm_id` is
  // guaranteed persisted from `linkPatch` when applicable) and is wrapped
  // in its own try/catch inside the helper — a Zoho-side failure is
  // logged but does not roll back the inbound update we already
  // committed.
  let pushResult = null;
  if (hasPushToZoho) {
    pushResult = await pushIconnectChangesToZoho({
      tenantId, entityType, entity, mapping, zohoModule, zohoId,
      pushToZoho, backfilledFields, overwrittenFields, truncatedFields, invalidUrlFields,
      coreUpdates, customUpdates,
      currentCustom, source, action, zohoRecord
    });
  }
  const pushFailed = pushResult && !pushResult.success;

  return {
    outcome: 'updated',
    matched,
    matchedBy,
    coreToWrite,
    customToWrite,
    linkPatch,
    diffs,
    backfilled_fields: backfilledFields,
    overwritten_fields: overwrittenFields,
    truncated_fields: truncatedFields,
    invalid_url_fields: invalidUrlFields,
    backfill_failed: pushFailed && hasBackfill
      ? { fields: backfilledFields.map(f => f.zoho_field), error: pushResult.error }
      : null,
    overwrite_failed: pushFailed && hasOverwrite
      ? { fields: overwrittenFields.map(f => f.zoho_field), error: pushResult.error }
      : null,
    logId: logRow?.id || null
  };
}

/**
 * One-time bulk import from Zoho CRM into iConnect for a single entity type
 * ('member' or 'organization'). Paginates through every record in the
 * configured Zoho module for this tenant. Idempotent and safe to re-run.
 *
 * Honours the existing field_mappings (including custom: preference fields).
 * Update-merge rule is unified across entity types — iConnect is the source
 * of truth:
 *   - Zoho empty + iConnect populated → push iConnect → Zoho (backfill).
 *   - Both populated, values differ   → push iConnect → Zoho (overwrite).
 *     iConnect is NOT modified.
 *   - Both populated, values match    → no-op.
 *   - iConnect empty + Zoho populated → write Zoho into iConnect (existing
 *     fill-blank inbound behaviour).
 *
 * New iConnect records are inserted from every non-empty mapped Zoho value
 * when no match is found by zoho_crm_id or natural key (email for members,
 * name for organisations). The zoho_crm_id / zoho_crm_module link is
 * always backfilled on previously unlinked iConnect records, even when no
 * other field needs to be written.
 *
 * Inbound origin is marked on every write so triggered outbound syncs are
 * suppressed during the import. Each record produces one zoho_crm_sync_log
 * row tagged with action='one_time_import'.
 *
 * Chunked execution (Vercel 60s budget):
 *   The function paginates Zoho 100 records at a time. Each call processes
 *   pages until either Zoho reports no more records OR the time budget
 *   (`timeBudgetMs`, default 40s) is exceeded. The budget is checked at
 *   two points:
 *     - Page boundary (the common path with the smaller perPage): when
 *       exceeded with more records remaining, `next_page = page + 1`.
 *     - Mid-page (safety net): when exceeded between records inside the
 *       current page, `next_page = page` so the next chunk resumes the
 *       *same* page. This guards against pathological per-record
 *       slowness that would otherwise let Vercel kill the function
 *       mid-record before any boundary check fires.
 *   When truncated, the summary returns `truncated: true` and a
 *   `next_page` cursor; the caller re-invokes with
 *   `options.startPage = next_page`. Resuming is always safe because
 *   `importOneRecord` is idempotent: re-processing a record that's
 *   already been imported produces a `no_change` outcome (matching
 *   values are not re-written and no spurious Zoho PUT is issued). Note
 *   that `summary.processed` counts records *visited*, so same-page
 *   resumes inflate that counter slightly while leaving created /
 *   updated counts accurate.
 */
export async function importEntityFromZoho(tenantId, entityType, options = {}) {
  if (!ENTITY_TABLE[entityType]) {
    throw new Error(`Unsupported entity type: ${entityType}`);
  }
  const source = options.source || 'one_time_import';
  const summary = {
    tenant_id: tenantId,
    entity_type: entityType,
    zoho_module: null,
    processed: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    backfilled: 0,
    backfill_failed: 0,
    zoho_overwritten: 0,
    zoho_overwrite_failed: 0,
    // Records with at least one push field that had to be shortened
    // to fit Zoho's `maximum_length`. Surfaced separately from
    // `backfill_failed` because clamping is a *successful* push — the
    // value lands in Zoho but in a shortened form, and admins still
    // want to know which fields were affected so they can either
    // raise the Zoho field cap or shorten their iConnect data.
    truncated_records: 0,
    // Records with at least one push field that was *dropped* from the
    // outbound payload because its value didn't look like a valid URL
    // (Zoho `website` / `url` data_types reject the whole record on
    // bad URL shapes — same blast radius as the length issue). Other
    // field changes on the same record still get pushed.
    invalid_url_records: 0,
    pages: 0,
    truncated: false,
    next_page: null,
    start_page: 1,
    last_page: 0,
    errors: []
  };

  const { data: mapping, error: mapErr } = await supabase
    .from('zoho_crm_sync_mapping')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('entity_type', entityType)
    .maybeSingle();
  if (mapErr) throw mapErr;
  if (!mapping) {
    throw new Error(`No Zoho CRM sync mapping is configured for ${entityType} on this tenant`);
  }
  if (!mapping.zoho_module) {
    throw new Error('Mapping has no Zoho module configured');
  }
  if (!Array.isArray(mapping.field_mappings) || mapping.field_mappings.length === 0) {
    throw new Error('Mapping has no field mappings configured — nothing to import');
  }

  // Self-heal `is_multi_pick` / `is_rich_text` flags on legacy mapping
  // rows that pre-date #424 — see helper for context.
  await enrichMappingFlagsFromMetadata(tenantId, mapping);

  const zohoModule = mapping.zoho_module;
  summary.zoho_module = zohoModule;

  const fields = new Set(['id', 'Modified_Time']);
  for (const m of mapping.field_mappings) {
    if (m?.zoho_field) fields.add(m.zoho_field);
  }
  if (mapping.unique_key_field) fields.add(mapping.unique_key_field);
  const fieldsParam = encodeURIComponent([...fields].join(','));

  // Smaller page size (was 200) so page boundaries occur twice as often
  // and the time-budget check between pages is the common path. The
  // mid-page check (below) is a safety net for pathological per-record
  // slowness rather than the normal early-exit path. Overridable for
  // ops/testing; clamped to Zoho's 1..200 range.
  const perPageRaw = Number(options.perPage);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw >= 1
    ? Math.min(200, Math.max(1, Math.floor(perPageRaw)))
    : 100;
  // Per-invocation page cap. This is a *per-call* safety cap, not an
  // absolute Zoho page ceiling: a chunk that resumes at page 600 and
  // processes pages 600..610 is fine even if maxPagesPerCall is 500.
  // Falls back to legacy `maxPages` for backward compatibility.
  const maxPagesPerCall =
    Number(options.maxPagesPerCall) || Number(options.maxPages) || 500;
  // Chunked-execution controls. The admin endpoint loops by passing
  // `startPage` so each Vercel invocation processes a slice within
  // `timeBudgetMs`. Default 40s leaves ~20s of headroom under Vercel's
  // 60s function ceiling so a slow record near the budget still has
  // time to finish before the function is killed.
  const startPage = Math.max(1, Math.floor(Number(options.startPage) || 1));
  // Clamp the override to <= 50_000 to defend the architectural
  // invariant: never sit closer than ~10s to Vercel's 60s ceiling, no
  // matter what an ops/test caller passes in.
  const timeBudgetMs = Number.isFinite(Number(options.timeBudgetMs))
    ? Math.min(50_000, Math.max(1_000, Number(options.timeBudgetMs)))
    : 40_000;
  const startedAt = Date.now();
  summary.start_page = startPage;
  let page = startPage;
  let pagesThisCall = 0;
  // Set when the mid-page time check fires so the outer loop knows to
  // stop without advancing to the next page (and so the page-boundary
  // logic doesn't double-set `truncated`).
  let timeBudgetExceededMidPage = false;

  while (pagesThisCall < maxPagesPerCall) {
    const endpoint = `/${zohoModule}?fields=${fieldsParam}&per_page=${perPage}&page=${page}`;
    let resp;
    try {
      resp = await zohoCrmApiCall(tenantId, endpoint);
    } catch (err) {
      // 204 no content => no records
      if (/\b204\b/.test(err.message || '')) break;
      throw new Error(`Failed to fetch ${zohoModule} page ${page}: ${err.message}`);
    }
    const records = Array.isArray(resp?.data) ? resp.data : [];
    if (records.length === 0) break;
    summary.pages += 1;

    for (let recIdx = 0; recIdx < records.length; recIdx++) {
      const rec = records[recIdx];
      // Mid-page time-budget check (safety net). If the elapsed time
      // crosses the budget while there's still meaningful work to do
      // — i.e. records *after* the current one on this page, or more
      // pages on Zoho's side — bail out and resume at the *same* page
      // on the next chunk. We deliberately don't count just the in-
      // flight record as "remaining": if only this record is left and
      // there are no more pages, it's cheaper to finish it than to
      // truncate and reprocess the whole page on the next chunk.
      //
      // Same-page resume is safe because `importOneRecord` is
      // idempotent: records we've already imported get reprocessed
      // but produce a `no_change` outcome (and no spurious Zoho PUT).
      // Without this check, a single page that takes longer than ~60s
      // would be killed by Vercel mid-record, the function would
      // never return, the UI would see a gateway-timeout HTML
      // response, and the cursor would never advance past the current
      // page. The trade-off is that records 0..recIdx-1 on this page
      // get visited again on the next chunk; they show up in
      // `processed` / `no_change` totals but cause no writes.
      if (recIdx > 0 && Date.now() - startedAt > timeBudgetMs) {
        const moreAfterCurrentOnThisPage = recIdx + 1 < records.length;
        const moreOnNextPage = !!resp?.info?.more_records;
        if (moreAfterCurrentOnThisPage || moreOnNextPage) {
          summary.truncated = true;
          summary.next_page = page;
          summary.last_page = page;
          timeBudgetExceededMidPage = true;
          break;
        }
      }
      summary.processed += 1;
      try {
        const result = await importOneRecord(tenantId, entityType, mapping, zohoModule, rec, source);
        if (result.outcome === 'created') summary.created += 1;
        else if (result.outcome === 'updated') summary.updated += 1;
        else if (result.outcome === 'failed') {
          summary.failed += 1;
          if (summary.errors.length < 50) {
            summary.errors.push({ id: rec.id || rec.Id || null, error: result.message || 'failed' });
          }
        } else summary.skipped += 1;
        // Aggregate iConnect→Zoho push counters: a record can show up
        // here in any outcome bucket (most commonly `updated` or
        // `no_change`) and still have triggered a backfill push (Zoho
        // was empty) and/or an overwrite push (Zoho disagreed). Both
        // groups are bundled into a single Zoho update call so the same
        // `result.*_failed.error` is surfaced when the call failed.
        if (Array.isArray(result.backfilled_fields) && result.backfilled_fields.length > 0) {
          if (result.backfill_failed) {
            summary.backfill_failed += 1;
            if (summary.errors.length < 50) {
              summary.errors.push({
                id: rec.id || rec.Id || null,
                error: `Backfill push failed: ${result.backfill_failed.error}`
              });
            }
          } else {
            summary.backfilled += 1;
          }
        }
        if (Array.isArray(result.overwritten_fields) && result.overwritten_fields.length > 0) {
          if (result.overwrite_failed) {
            summary.zoho_overwrite_failed += 1;
            if (summary.errors.length < 50) {
              summary.errors.push({
                id: rec.id || rec.Id || null,
                error: `Zoho overwrite push failed: ${result.overwrite_failed.error}`
              });
            }
          } else {
            summary.zoho_overwritten += 1;
          }
        }
        if (Array.isArray(result.truncated_fields) && result.truncated_fields.length > 0) {
          summary.truncated_records += 1;
        }
        if (Array.isArray(result.invalid_url_fields) && result.invalid_url_fields.length > 0) {
          summary.invalid_url_records += 1;
        }
      } catch (err) {
        summary.failed += 1;
        if (summary.errors.length < 50) {
          summary.errors.push({ id: rec.id || rec.Id || null, error: err?.message || String(err) });
        }
        try {
          await writeLog({
            tenant_id: tenantId, entity_type: entityType, entity_id: null,
            zoho_module: zohoModule, zoho_record_id: rec.id || rec.Id || null,
            status: 'failed', direction: 'inbound', source, action: 'one_time_import',
            error_message: err?.message || String(err),
            request_payload: rec
          });
        } catch (logErr) {
          console.error('[ZohoCrmSync] one_time_import log write failed:', logErr);
        }
      }
    }

    // If the inner loop bailed mid-page on the time budget, the
    // truncation cursor and last_page are already set. Stop here so we
    // don't advance past the current page or double-set fields.
    if (timeBudgetExceededMidPage) break;

    summary.last_page = page;
    pagesThisCall += 1;
    if (!resp?.info?.more_records) break;
    // Page-boundary time-budget check (the common path with the smaller
    // `perPage`). When the budget is exceeded and Zoho still has more
    // records, hand control back to the caller with `next_page` set to
    // the *next* page so the admin UI can re-invoke us and resume
    // without re-processing this page.
    if (Date.now() - startedAt > timeBudgetMs) {
      summary.truncated = true;
      summary.next_page = page + 1;
      break;
    }
    page += 1;
    // Per-call page cap also yields a resumable truncation rather than
    // silently stopping, so the admin UI can pick up the next chunk.
    if (pagesThisCall >= maxPagesPerCall) {
      summary.truncated = true;
      summary.next_page = page;
      break;
    }
  }

  return summary;
}

/**
 * Run a single Zoho record through the same one-time import pipeline used by
 * `importEntityFromZoho`. Used by the admin "Sync a single record" UI so a
 * specific record can be previewed (dry-run) or synced live before kicking
 * off a full bulk import.
 *
 * Returns the structured result from `importOneRecord` plus the resolved
 * `zoho_module`. Throws on configuration errors (no mapping configured,
 * mapping missing fields), or on a "record not found" / Zoho API failure.
 */
export async function importSingleZohoRecord(tenantId, entityType, zohoRecordId, options = {}) {
  if (!ENTITY_TABLE[entityType]) {
    throw new Error(`Unsupported entity type: ${entityType}`);
  }
  if (!zohoRecordId || typeof zohoRecordId !== 'string') {
    throw new Error('zohoRecordId is required');
  }
  const dryRun = options.dryRun === true;
  const source = dryRun ? 'one_time_import_single_preview' : 'one_time_import_single';
  const action = 'one_time_import_single';

  const { data: mapping, error: mapErr } = await supabase
    .from('zoho_crm_sync_mapping')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('entity_type', entityType)
    .maybeSingle();
  if (mapErr) throw mapErr;
  if (!mapping) {
    throw new Error(`No Zoho CRM sync mapping is configured for ${entityType} on this tenant`);
  }
  if (!mapping.zoho_module) {
    throw new Error('Mapping has no Zoho module configured');
  }
  if (!Array.isArray(mapping.field_mappings) || mapping.field_mappings.length === 0) {
    throw new Error('Mapping has no field mappings configured — nothing to import');
  }

  // Self-heal `is_multi_pick` / `is_rich_text` flags on legacy mapping
  // rows that pre-date #424 — see helper for context.
  await enrichMappingFlagsFromMetadata(tenantId, mapping);

  const zohoModule = mapping.zoho_module;
  const fields = new Set(['id', 'Modified_Time']);
  for (const m of mapping.field_mappings) {
    if (m?.zoho_field) fields.add(m.zoho_field);
  }
  if (mapping.unique_key_field) fields.add(mapping.unique_key_field);
  const fieldsParam = encodeURIComponent([...fields].join(','));

  const endpoint = `/${zohoModule}/${encodeURIComponent(zohoRecordId)}?fields=${fieldsParam}`;
  let resp;
  try {
    resp = await zohoCrmApiCall(tenantId, endpoint);
  } catch (err) {
    const msg = err?.message || String(err);
    if (/\b204\b/.test(msg) || /\b404\b/.test(msg)) {
      throw new Error(`Record ${zohoRecordId} not found in Zoho CRM module ${zohoModule}`);
    }
    throw new Error(`Failed to fetch Zoho record ${zohoRecordId}: ${msg}`);
  }
  const records = Array.isArray(resp?.data) ? resp.data : [];
  if (records.length === 0) {
    throw new Error(`Record ${zohoRecordId} not found in Zoho CRM module ${zohoModule}`);
  }
  const zohoRecord = records[0];

  const result = await importOneRecord(
    tenantId, entityType, mapping, zohoModule, zohoRecord, source,
    { dryRun, action }
  );
  return { ...result, zoho_module: zohoModule, dryRun };
}

// ===========================================================================
// Outbound reconcile (#442) — see docs/zoho-sync-reconcile-design.md.
//
// `pollLocalOutboundDrift` is the cron-side counterpart to the existing
// `pollZohoCrmReconciliation` inbound poller. For each enabled outbound (or
// bidirectional) mapping it scans the parent entity table for rows whose
// `updated_at` is newer than the most recent successful outbound sync, and
// re-runs them through `syncEntityToZohoCrm` with `action: 'reconcile'`.
//
// The engine's existing payload-hash + ECHO_DEBOUNCE guards make a no-op
// pass effectively free — if nothing changed since the last sync, the
// engine short-circuits without an HTTP call to Zoho. After the entity
// pass, pending tombstones for the same tenant are drained: each one is
// pushed to Zoho's DELETE endpoint and either marked processed or
// retried on the next tick.
// ===========================================================================

const OUTBOUND_DRIFT_BATCH_LIMIT = 200;
const OUTBOUND_TOMBSTONE_BATCH_LIMIT = 100;
// Bail out of a tenant's loop if Zoho fails this many times in a row —
// protects the API budget during a Zoho outage and avoids burning the
// whole batch retrying every drifted row.
const OUTBOUND_CONSECUTIVE_FAILURE_LIMIT = 5;

function jitterDelayMs() {
  // Small 50–150 ms jitter between Zoho calls so a backlog drain does
  // not burst the API. Sequential within a tenant to match the existing
  // inbound poller's behaviour.
  return 50 + Math.floor(Math.random() * 100);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isSkippedLog(log) {
  return !!(log && log.status === 'skipped');
}

function isSuccessLog(log) {
  return !!(log && log.status === 'success');
}

/**
 * Delete a single Zoho CRM record by its stored `zoho_crm_id` and
 * `zoho_crm_module`. Logs the outcome to `zoho_crm_sync_log` so
 * deletes appear in the same audit stream as updates. A 404 from
 * Zoho (or `RECORD_NOT_FOUND` / `INVALID_DATA` codes) is treated as
 * success because the goal — the record no longer exists in Zoho —
 * has been met.
 */
export async function deleteEntityFromZohoCrm(tenantId, entityType, entityId, zohoCrmId, zohoCrmModule, options = {}) {
  if (!tenantId || !entityType || !zohoCrmId || !zohoCrmModule) {
    return { success: false, error: 'Missing tenantId, entityType, zohoCrmId or zohoCrmModule' };
  }
  const source = options.source || 'reconcile-outbound';
  const action = options.action || 'delete';

  const result = await deleteZohoCrmRecord(tenantId, zohoCrmModule, zohoCrmId);
  if (result.success) {
    await writeLog({
      tenant_id: tenantId,
      entity_type: entityType,
      entity_id: entityId || null,
      zoho_module: zohoCrmModule,
      zoho_record_id: zohoCrmId,
      status: 'success',
      action,
      source,
      error_message: result.alreadyGone ? 'Zoho record already gone (treated as success)' : null
    });
  } else {
    await writeLog({
      tenant_id: tenantId,
      entity_type: entityType,
      entity_id: entityId || null,
      zoho_module: zohoCrmModule,
      zoho_record_id: zohoCrmId,
      status: 'failed',
      action,
      source,
      error_message: result.error || 'Unknown delete failure'
    });
  }
  return result;
}

/**
 * Scan local entity tables for rows whose `updated_at` watermark is
 * newer than the last successful outbound sync, and replay them
 * through `syncEntityToZohoCrm`. Then drain pending tombstones for
 * the same tenant.
 *
 * Sequential per-entity, sequential per-row, with a small jitter
 * between Zoho calls. Bails out of the current tenant's loop after
 * `OUTBOUND_CONSECUTIVE_FAILURE_LIMIT` consecutive failures so a Zoho
 * outage does not burn through the API budget. Returns a per-entity
 * summary suitable for inclusion in the cron's aggregate response.
 */
export async function pollLocalOutboundDrift(tenantId, options = {}) {
  const source = options.source || 'reconcile-outbound';
  const batchLimit = Math.max(1, Math.min(options.batchLimit || OUTBOUND_DRIFT_BATCH_LIMIT, OUTBOUND_DRIFT_BATCH_LIMIT));
  const tombstoneLimit = Math.max(1, Math.min(options.tombstoneLimit || OUTBOUND_TOMBSTONE_BATCH_LIMIT, OUTBOUND_TOMBSTONE_BATCH_LIMIT));
  const summary = { tenant_id: tenantId, entities: [], tombstones: null };

  const { data: mappings, error: mapErr } = await supabase
    .from('zoho_crm_sync_mapping')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('is_enabled', true)
    .in('sync_direction', ['outbound', 'bidirectional']);
  if (mapErr) throw mapErr;

  if (!mappings || mappings.length === 0) {
    summary.skipped = 'no_outbound_mappings';
    return summary;
  }

  let bailReason = null;

  for (const mapping of mappings) {
    if (bailReason) break;
    const entityType = mapping.entity_type;
    const table = ENTITY_TABLE[entityType];
    if (!table) continue;

    const entityStart = Date.now();
    const counters = {
      tenant_id: tenantId,
      entity_type: entityType,
      candidates: 0,
      synced: 0,
      noop: 0,
      failed: 0,
      duration_ms: 0
    };

    try {
      // Pull the drift set via the SECURITY-INVOKER RPC defined in
      // 20260425_zoho_outbound_drift_rpc.sql — a LEFT JOIN against
      // zoho_crm_sync_state is needed to handle never-synced rows
      // (no state row at all) without overfetching client-side.
      // Ordered oldest-first so a long Zoho outage cannot starve old
      // rows.
      const { data: drifted, error: candErr } = await supabase.rpc(
        'zoho_crm_outbound_drift_candidates',
        { p_tenant_id: tenantId, p_entity_type: entityType, p_limit: batchLimit }
      );
      if (candErr) throw candErr;

      counters.candidates = (drifted || []).length;

      let consecutiveFailures = 0;
      for (const row of drifted || []) {
        try {
          const log = await syncEntityToZohoCrm(tenantId, entityType, row.id, {
            action: 'reconcile',
            source
          });
          if (isSuccessLog(log)) {
            counters.synced += 1;
            consecutiveFailures = 0;
          } else if (isSkippedLog(log)) {
            counters.noop += 1;
            consecutiveFailures = 0;
          } else if (log && log.status === 'failed') {
            counters.failed += 1;
            consecutiveFailures += 1;
          } else {
            // null log => engine short-circuited (e.g. mapping vanished
            // mid-loop, or origin-loop guard). Treat as no-op.
            counters.noop += 1;
            consecutiveFailures = 0;
          }
        } catch (err) {
          counters.failed += 1;
          consecutiveFailures += 1;
          console.error('[cron/zoho-crm-reconcile-outbound] Sync threw:', tenantId, entityType, row.id, err?.message || err);
        }

        if (consecutiveFailures >= OUTBOUND_CONSECUTIVE_FAILURE_LIMIT) {
          bailReason = `consecutive_failures:${consecutiveFailures}`;
          break;
        }
        await sleep(jitterDelayMs());
      }
    } catch (err) {
      console.error('[cron/zoho-crm-reconcile-outbound] Entity pass error:', tenantId, entityType, err);
      counters.error = err?.message || String(err);
    }

    counters.duration_ms = Date.now() - entityStart;
    summary.entities.push(counters);
    console.log(
      `[cron/zoho-crm-reconcile-outbound] tenant=${tenantId} entity=${entityType} ` +
      `candidates=${counters.candidates} synced=${counters.synced} ` +
      `noop=${counters.noop} failed=${counters.failed} ` +
      `duration_ms=${counters.duration_ms}` +
      (counters.error ? ` error=${counters.error}` : '')
    );
  }

  // Tombstone drain — only if we did not bail out of the entity passes.
  if (!bailReason) {
    const tStart = Date.now();
    const tCounters = {
      tenant_id: tenantId,
      candidates: 0,
      processed: 0,
      already_gone: 0,
      no_zoho_id: 0,
      failed: 0,
      duration_ms: 0
    };
    try {
      const { data: tombstones, error: tErr } = await supabase
        .from('zoho_crm_sync_tombstone')
        .select('*')
        .eq('tenant_id', tenantId)
        .is('processed_at', null)
        .order('deleted_at', { ascending: true })
        .limit(tombstoneLimit);
      if (tErr) throw tErr;

      tCounters.candidates = (tombstones || []).length;
      let consecutiveFailures = 0;

      for (const ts of tombstones || []) {
        // Nothing to delete in Zoho for rows that were never synced.
        if (!ts.zoho_crm_id || !ts.zoho_crm_module) {
          const { error: updErr } = await supabase
            .from('zoho_crm_sync_tombstone')
            .update({ processed_at: new Date().toISOString() })
            .eq('id', ts.id);
          if (updErr) {
            // Treat as a failure — don't claim "processed" if the row
            // is still pending in the DB, otherwise the next tick will
            // re-delete and we'll over-count.
            console.error('[cron/zoho-crm-reconcile-outbound] Tombstone mark-processed failed:', tenantId, ts.id, updErr);
            tCounters.failed += 1;
            consecutiveFailures += 1;
          } else {
            tCounters.no_zoho_id += 1;
            tCounters.processed += 1;
            consecutiveFailures = 0;
          }
          if (consecutiveFailures >= OUTBOUND_CONSECUTIVE_FAILURE_LIMIT) {
            bailReason = `tombstone_consecutive_failures:${consecutiveFailures}`;
            break;
          }
          continue;
        }

        const result = await deleteEntityFromZohoCrm(
          tenantId, ts.entity_type, ts.entity_id, ts.zoho_crm_id, ts.zoho_crm_module,
          { source }
        );
        if (result.success) {
          const { error: updErr } = await supabase
            .from('zoho_crm_sync_tombstone')
            .update({
              processed_at: new Date().toISOString(),
              attempts: (ts.attempts || 0) + 1,
              last_error: null
            })
            .eq('id', ts.id);
          if (updErr) {
            // Zoho delete succeeded but we couldn't persist the
            // processed flag — surface as a failure so retry semantics
            // stay accurate. The next tick will hit Zoho's "already
            // gone" path and converge.
            console.error('[cron/zoho-crm-reconcile-outbound] Tombstone mark-processed failed after Zoho delete:', tenantId, ts.id, updErr);
            tCounters.failed += 1;
            consecutiveFailures += 1;
          } else {
            tCounters.processed += 1;
            if (result.alreadyGone) tCounters.already_gone += 1;
            consecutiveFailures = 0;
          }
        } else {
          const { error: updErr } = await supabase
            .from('zoho_crm_sync_tombstone')
            .update({
              attempts: (ts.attempts || 0) + 1,
              last_error: (result.error || 'Unknown error').slice(0, 1000)
            })
            .eq('id', ts.id);
          if (updErr) {
            // Best-effort — log but don't double-count the failure.
            console.error('[cron/zoho-crm-reconcile-outbound] Tombstone increment-attempts failed:', tenantId, ts.id, updErr);
          }
          tCounters.failed += 1;
          consecutiveFailures += 1;
        }

        if (consecutiveFailures >= OUTBOUND_CONSECUTIVE_FAILURE_LIMIT) {
          bailReason = `tombstone_consecutive_failures:${consecutiveFailures}`;
          break;
        }
        await sleep(jitterDelayMs());
      }
    } catch (err) {
      console.error('[cron/zoho-crm-reconcile-outbound] Tombstone drain error:', tenantId, err);
      tCounters.error = err?.message || String(err);
    }
    tCounters.duration_ms = Date.now() - tStart;
    summary.tombstones = tCounters;
    console.log(
      `[cron/zoho-crm-reconcile-outbound] tenant=${tenantId} entity=tombstone ` +
      `candidates=${tCounters.candidates} processed=${tCounters.processed} ` +
      `already_gone=${tCounters.already_gone} no_zoho_id=${tCounters.no_zoho_id} ` +
      `failed=${tCounters.failed} duration_ms=${tCounters.duration_ms}` +
      (tCounters.error ? ` error=${tCounters.error}` : '')
    );
  }

  if (bailReason) summary.bailed_out = bailReason;
  return summary;
}
