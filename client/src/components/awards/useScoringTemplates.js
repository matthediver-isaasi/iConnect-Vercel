import { useQuery } from '@tanstack/react-query';
import { validateCriteria } from '../../../../api/_lib/assessment/scoring.js';
import { roundAdminRequest } from './useRoundAdministration';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const scoringTemplatesKey = tenant => ['award-scoring-templates', tenant.scopeKey];
function normalise(value) {
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => [key, normalise(value[key])]));
  return value;
}
// JSON object order is not meaningful (Postgres JSONB may reorder keys).
// Array order, scalar types, values and every serialized field remain exact.
export const sameTemplateDefinition = (left, right) => JSON.stringify(normalise(left)) === JSON.stringify(normalise(right));
export const copyTemplateDefinition = definition => JSON.parse(JSON.stringify(definition));

function validateTemplate(template) {
  if (!template || !uuid.test(template.id || '') || !uuid.test(template.series_id || '')
    || !Number.isSafeInteger(template.revision) || template.revision < 1
    || typeof template.name !== 'string' || !template.name.trim()
    || typeof template.created_at !== 'string' || !Number.isFinite(Date.parse(template.created_at))) {
    throw new Error('The template version could not be verified. Reload the complete library.');
  }
  validateCriteria(template.definition);
  return template;
}

async function listCompleteTemplates(tenant, signal) {
  const templates = [], ids = new Set(), series = new Set();
  let total, pageSize;
  for (let page = 1; page <= 10000; page += 1) {
    const result = await roundAdminRequest(tenant, `/api/awards/templates?page=${page}`, { signal });
    if (!Array.isArray(result?.templates) || result.page !== page
      || !Number.isSafeInteger(result.total) || result.total < 0
      || !Number.isSafeInteger(result.pageSize) || result.pageSize < 1
      || result.templates.length > result.pageSize
      || (total !== undefined && (result.total !== total || result.pageSize !== pageSize))) {
      throw new Error('The template library changed or was incomplete. Reload all pages; no partial library is being used.');
    }
    total = result.total; pageSize = result.pageSize;
    for (const value of result.templates) {
      const template = validateTemplate(value);
      if (ids.has(template.id) || series.has(template.series_id)) throw new Error('The template library changed while loading. Reload all pages before choosing a version.');
      ids.add(template.id); series.add(template.series_id); templates.push(template);
    }
    if (templates.length === total) return templates;
    if (templates.length > total || result.templates.length < pageSize) {
      throw new Error('The complete template library could not be loaded. No partial selection list is being used.');
    }
  }
  throw new Error('The template library exceeds the supported server page range. No partial library is being used.');
}

export function useScoringTemplates(tenant) {
  return useQuery({
    queryKey: scoringTemplatesKey(tenant), queryFn: ({ signal }) => listCompleteTemplates(tenant, signal),
    retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
}

export async function saveScoringTemplate(tenant, payload) {
  validateCriteria(payload.definition);
  const result = await roundAdminRequest(tenant, '/api/awards/templates', { body: payload });
  const template = validateTemplate(result?.template);
  if (template.revision !== payload.revision + 1 || (payload.seriesId && template.series_id !== payload.seriesId)
    || template.name !== payload.name || !sameTemplateDefinition(template.definition, payload.definition)) {
    throw new Error('The server did not confirm the requested template version. Keep your draft and reload the library before another attempt.');
  }
  return template;
}
