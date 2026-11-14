import { useQuery } from '@tanstack/react-query';
import { adminFetch } from '@/lib/adminFetch';

export const communicationKey = (tenant, awardId) => ['award-communications', tenant.scopeKey, awardId];
export const communicationUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const automaticMessageCategories = ['application_confirmation', 'application_deadline', 'judge_invitation_reminder', 'judging_deadline', 'incomplete_assessment', 'moderation_invitation'];
export const immediateAutomaticCategories = ['application_confirmation', 'moderation_invitation'];
const configurationIso = value => typeof value === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
export const validCommunicationConfiguration = row => communicationUuid(row?.id) && typeof row.category === 'string' && typeof row.enabled === 'boolean'
  && Number.isSafeInteger(row.version) && row.version >= 1 && (row.email_template_id === null || communicationUuid(row.email_template_id))
  && typeof row.automatic === 'boolean' && Number.isSafeInteger(row.offset_minutes) && row.offset_minutes >= 0 && row.offset_minutes <= 525600
  && (row.automatic_since === null || configurationIso(row.automatic_since))
  && (!row.automatic || (automaticMessageCategories.includes(row.category) && configurationIso(row.automatic_since)));
// Keep the cache in the GET DTO shape. Worker-only fields such as last_scan_at
// are not configuration versions and must not reinitialise editor drafts.
export const communicationConfigurationDto = row => Object.fromEntries(['id', 'category', 'email_template_id', 'enabled', 'version', 'automatic', 'offset_minutes', 'automatic_since'].map(key => [key, row[key]]));
export const messageLabel = category => ({
  application_confirmation: 'Application received', application_deadline: 'Application deadline',
  judge_invitation: 'Judge invitation', judge_invitation_reminder: 'Judge invitation reminder',
  judging_deadline: 'Judging deadline', incomplete_assessment: 'Incomplete assessment',
  moderation_invitation: 'Moderation invitation', shortlist: 'Authorised shortlist update',
  winner: 'Winner category — neutral authorised outcome notice',
  unsuccessful: 'Unsuccessful category — neutral authorised outcome notice', certificate: 'Award certificate',
}[category] || category.replaceAll('_', ' '));
export function appointmentMessageLabel(item) {
  return `${item.round?.name || 'Round'} · ${item.role} · ${item.state} · appointment ${item.id}`;
}
export function messageTime(value, timezone = 'UTC') {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Not recorded';
  try { return `${new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(new Date(value))} (${timezone})`; }
  catch { return new Date(value).toISOString(); }
}
export async function communicationRequest(tenant, url, { body, signal } = {}) {
  tenant.assertCurrent();
  const response = await adminFetch(url, { signal, cache: 'no-store',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Awards-Request': '1' }, body: JSON.stringify(body) }),
  }, tenant.tenantId);
  tenant.assertCurrent();
  const result = await response.json();
  tenant.assertCurrent();
  if (!response.ok) throw Object.assign(new Error(result.error || 'The communication request could not be completed.'), { status: response.status });
  return result;
}
function checkPage(result, page) {
  if (result.page !== page || !Number.isSafeInteger(result.pageSize) || result.pageSize < 1) throw new Error('Communication pagination is incomplete. Reload; no partial choices are used.');
}
async function allChoices(tenant, awardId, signal) {
  const kinds = [['templates', 'templateTotal'], ['applications', 'applicationTotal'], ['appointments', 'appointmentTotal'], ['certificates', 'certificateTotal']];
  const rows = Object.fromEntries(kinds.map(([name]) => [name, []])), totals = {}, seen = Object.fromEntries(kinds.map(([name]) => [name, new Set()]));
  let metadata;
  for (let page = 1; page <= 10000; page += 1) {
    const result = await communicationRequest(tenant, `/api/awards/communications?awardId=${encodeURIComponent(awardId)}&page=${page}`, { signal });
    checkPage(result, page);
    if (!Array.isArray(result.configurations) || !Array.isArray(result.categories) || !Array.isArray(result.placeholderKeys)
      || result.categories.some(value => typeof value !== 'string') || result.placeholderKeys.some(value => typeof value !== 'string')
      || result.configurations.some(row => !validCommunicationConfiguration(row))
      || new Set(result.configurations.map(row => row.category)).size !== result.configurations.length
      || new Set(result.configurations.map(row => row.id)).size !== result.configurations.length) throw new Error('Message settings, automatic policy or supported categories are unavailable or unreadable.');
    const snapshot = JSON.stringify([result.configurations.slice().sort((a, b) => a.category.localeCompare(b.category)), result.categories, result.placeholderKeys]);
    if (metadata && metadata.snapshot !== snapshot) throw new Error('Message configuration changed during loading. Reload the complete choices.');
    metadata = { snapshot, configurations: result.configurations, categories: result.categories, placeholderKeys: result.placeholderKeys };
    for (const [name, totalKey] of kinds) {
      if (!Array.isArray(result[name]) || !Number.isSafeInteger(result[totalKey]) || result[totalKey] < 0
        || (totals[name] !== undefined && totals[name] !== result[totalKey])) throw new Error(`The ${name} choices changed or were incomplete. Reload; no partial choices are used.`);
      totals[name] = result[totalKey];
      for (const row of result[name]) {
        if (!communicationUuid(row.id) || seen[name].has(row.id)) throw new Error(`The ${name} list changed while loading. Reload the complete choices.`);
        seen[name].add(row.id); rows[name].push(row);
      }
      if (rows[name].length > totals[name] || (rows[name].length < totals[name] && result[name].length < result.pageSize)) throw new Error(`The ${name} choices could not be loaded completely.`);
    }
    if (kinds.every(([name]) => rows[name].length === totals[name])) return { ...rows, configurations: metadata.configurations, categories: metadata.categories, placeholderKeys: metadata.placeholderKeys };
  }
  throw new Error('Communication choices exceed the page limit. No partial choices are used.');
}
export function useCommunicationChoices(tenant, awardId) {
  return useQuery({ queryKey: [...communicationKey(tenant, awardId), 'choices'],
    queryFn: ({ signal }) => allChoices(tenant, awardId, signal), retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false });
}
export function useCommunicationHistory(tenant, awardId, page) {
  return useQuery({ queryKey: [...communicationKey(tenant, awardId), 'history', page], queryFn: async ({ signal }) => {
    const result = await communicationRequest(tenant, `/api/awards/communications?awardId=${encodeURIComponent(awardId)}&page=${page}`, { signal });
    checkPage(result, page);
    if (!Array.isArray(result.deliveries) || !Number.isSafeInteger(result.deliveryTotal) || result.deliveryTotal < 0
      || new Set(result.deliveries.map(row => row.id)).size !== result.deliveries.length) throw new Error('Delivery history is incomplete. Retry this page.');
    return { deliveries: result.deliveries, total: result.deliveryTotal, page: result.page, pageSize: result.pageSize };
  }, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false });
}
export function useCommunicationShortlists(tenant, awardId) {
  return useQuery({ queryKey: [...communicationKey(tenant, awardId), 'shortlists'], queryFn: async ({ signal }) => {
    const shortlists = [], seen = new Set(); let total;
    for (let page = 1; page <= 10000; page += 1) {
      const result = await communicationRequest(tenant, `/api/awards/shortlist-publications?awardId=${encodeURIComponent(awardId)}&page=${page}`, { signal });
      checkPage(result, page);
      if (!Array.isArray(result.shortlists) || !Number.isSafeInteger(result.total) || result.total < 0 || (total !== undefined && result.total !== total)) throw new Error('Confirmed shortlist choices changed or are incomplete. Reload before scheduling.');
      total = result.total;
      for (const row of result.shortlists) {
        if (!row.id || seen.has(row.id)) throw new Error('Shortlist choices changed while loading.');
        seen.add(row.id); shortlists.push(row);
      }
      if (shortlists.length === total) return shortlists;
      if (shortlists.length > total || result.shortlists.length < result.pageSize) throw new Error('The full confirmed shortlist could not be loaded.');
    }
    throw new Error('The shortlist catalog exceeds the page limit. No partial choices are used.');
  }, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false });
}
