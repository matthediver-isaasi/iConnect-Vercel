import { resolveCountryToIso2 } from '../../../shared/countries.js';

// Cap on how many example records we attach per unresolved value. The
// full record count is always reported; the examples just give the admin
// somewhere to start fixing.
export const MAX_EXAMPLE_RECORDS = 25;

function toList(value) {
  if (value === null || value === undefined || value === '') return [];
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      if (item === null || item === undefined || item === '') continue;
      const v = (typeof item === 'object' && 'value' in item) ? item.value : item;
      if (v === null || v === undefined || v === '') continue;
      out.push(v);
    }
    return out;
  }
  if (typeof value === 'object' && 'value' in value) {
    const v = value.value;
    return v === null || v === undefined || v === '' ? [] : [v];
  }
  return [value];
}

/**
 * Pure collector for unresolved country values.
 *
 * `entries` is an iterable of { source, fieldKey, fieldLabel, record, value }
 * where `value` may be a scalar or an array (multi-pick `countries` fields
 * store arrays). Every element that fails resolveCountryToIso2 is grouped
 * by (source, field, normalised value) so the admin sees one row per
 * distinct bad string with the records it appears on.
 *
 * Values that resolve — via ISO-2 code, canonical name, or the alias map —
 * never appear. Empty/blank values are skipped too: "no country" is a
 * completeness issue, not a resolution failure, and both widgets already
 * treat it consistently.
 */
export function collectUnresolvedCountryValues(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const { source, fieldKey, fieldLabel, record } = entry;
    for (const raw of toList(entry.value)) {
      const str = typeof raw === 'string' ? raw : String(raw);
      const trimmed = str.trim();
      if (!trimmed) continue;
      if (resolveCountryToIso2(trimmed) !== null) continue;
      const key = `${source}\u0000${fieldKey}\u0000${trimmed.toUpperCase()}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          source,
          fieldKey,
          fieldLabel,
          value: trimmed,
          recordCount: 0,
          records: [],
          recordIds: new Set(),
        };
        groups.set(key, group);
      }
      // De-duplicate per record: the same bad value listed twice on one
      // record is one problem, not two.
      if (record && group.recordIds.has(record.id)) continue;
      if (record) group.recordIds.add(record.id);
      group.recordCount += 1;
      if (record && group.records.length < MAX_EXAMPLE_RECORDS) {
        group.records.push({ id: record.id, label: record.label || record.id });
      }
    }
  }
  return Array.from(groups.values())
    .map(({ recordIds, ...g }) => g)
    .sort((a, b) =>
      b.recordCount - a.recordCount
      || a.value.localeCompare(b.value)
      || a.fieldLabel.localeCompare(b.fieldLabel));
}
