import { createAlphabetFilterRecorder } from './crmAlphabetQuery.js';
import { prefEntryNeedsAntiJoin } from './prefValueOptionFilter.js';

export function organizationAlphabetRecorder(entries) {
  return createAlphabetFilterRecorder(Object.fromEntries(entries.map(([, entry], i) => [
    `cf${i}`, { kind: 'preference', negative: prefEntryNeedsAntiJoin(entry), filters: [] },
  ])));
}

export function memberAlphabetRecorder(ctx) {
  const joins = {};
  ctx.customFilterEntries.forEach(([, entry], i) => {
    joins[`cf${i}`] = { kind: 'preference', negative: prefEntryNeedsAntiJoin(entry), filters: [] };
  });
  ctx.organizationFilterEntries.forEach(([, entry], i) => {
    const negative = prefEntryNeedsAntiJoin(entry);
    joins[`orgf${i}`] = { kind: 'organization', filters: [], negative: false, optional: negative };
    joins[`orgf${i}.opv${i}`] = { kind: 'organization_preference', parent: `orgf${i}`, negative, filters: [] };
  });
  return createAlphabetFilterRecorder(joins);
}

export async function sendAlphabet(res, db, { tenantId, entity, sortField, recorder, departments = null }) {
  const { data, error } = await db.rpc('crm_alphabet_metadata', {
    p_tenant: tenantId,
    p_entity: entity,
    p_sort: sortField,
    p_filters: recorder.result(),
    p_departments: departments,
  });
  if (error || !data || !Array.isArray(data.buckets)) {
    throw Object.assign(new Error('Alphabet navigation is temporarily unavailable'), { status: 503 });
  }
  return res.json(data);
}
