import { useQuery } from '@tanstack/react-query';
import { getTenantSlugFromLocation } from '@/api/publicClient';
import { readAwardAttachment, validateEvidenceReview } from '@/lib/awardEvidenceReader';

export const applicantUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const applicantApplicationsKey = (session, tenantSlug) =>
  ['member-award-applications', session.scopeKey, tenantSlug || ''];

// Normal member cookies own access. Never use adminFetch, an administrative
// capability, a supplied member ID, or a restricted judging/continuation token.
export async function applicantRequest(session, tenantSlug, { page = 1, applicationId, edit = false, review = false, payload, signal } = {}) {
  if (review && (edit || payload || !applicantUuid.test(applicationId || ''))) throw new Error('The saved evidence request is invalid.');
  const assertCurrent = () => {
    session.assertCurrent();
    if (getTenantSlugFromLocation() !== tenantSlug) throw new Error('Your organisation context changed. Reload this page before continuing.');
  };
  assertCurrent();
  const params = new URLSearchParams();
  if (tenantSlug) params.set('tenant', tenantSlug);
  if (!payload) {
    params.set('page', String(page));
    if (applicationId) params.set('applicationId', applicationId);
    if (edit) params.set('edit', '1');
    if (review) params.set('review', '1');
  }
  const response = await fetch(`/api/awards/my-applications${params.size ? `?${params}` : ''}`, {
    credentials: 'include', cache: 'no-store', signal,
    ...(payload ? {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Awards-Request': '1' },
      body: JSON.stringify(payload),
    } : {}),
  });
  assertCurrent();
  let result;
  try { result = await response.json(); }
  catch {
    throw Object.assign(new Error(payload
      ? 'The application change response could not be read. Its outcome is not confirmed. Do not assume the request failed.'
      : 'Your application response could not be read. Please retry.'), { status: response.status });
  }
  assertCurrent();
  if (!response.ok) throw Object.assign(new Error(typeof result?.error === 'string' ? result.error
    : 'Your application could not be loaded or changed.'), { status: response.status });
  return review ? validateEvidenceReview(result) : validateApplicantResponse(result, { payload, edit, applicationId, page });
}

export function applicantAttachmentRequest(session, tenantSlug, applicationId, attachmentId, { signal } = {}) {
  if (![applicationId, attachmentId].every(id => applicantUuid.test(id || ''))) throw new Error('The saved attachment reference is invalid.');
  const assertCurrent = () => {
    session.assertCurrent();
    if (getTenantSlugFromLocation() !== tenantSlug) throw new Error('Your organisation context changed. Reopen current evidence.');
  };
  return readAwardAttachment({ signal, assertCurrent, requestChunk: async (offset, chunkSignal, consume) => {
    assertCurrent();
    const params = new URLSearchParams({ applicationId, review: '1', attachmentId, offset: String(offset) });
    if (tenantSlug) params.set('tenant', tenantSlug);
    const response = await fetch(`/api/awards/my-applications?${params}`, {
      credentials: 'include', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      signal: chunkSignal, headers: { Accept: 'application/octet-stream' },
    });
    return consume(response);
  } });
}

function recordedDisplaySnapshot(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Immutable display labels could not be verified.');
  for (const label of Object.values(value)) {
    if (typeof label === 'string') continue;
    if (!label || typeof label !== 'object' || Array.isArray(label)) throw new Error('Immutable display labels could not be verified.');
    for (const [key, text] of Object.entries(label)) {
      let pair;
      try { pair = JSON.parse(key); } catch { throw new Error('Immutable row display label identity is invalid.'); }
      if (!Array.isArray(pair) || pair.length !== 2 || pair.some(id => typeof id !== 'string' || !id)
        || JSON.stringify(pair) !== key || typeof text !== 'string') throw new Error('Immutable row display label identity is invalid.');
    }
  }
  return value;
}

export function validateApplicantResponse(result, { payload, edit = false, applicationId, page = 1 } = {}) {
  if (payload) {
    if (payload.command === 'amend') {
      if (result?.effects !== 'review_evidence_only' || result.judgeAdoption !== 'unchanged'
        || !applicantUuid.test(result.applicationVersionId || '') || !applicantUuid.test(result.id || '')) {
        throw new Error('The server did not confirm an evidence-only amendment with unchanged judging. Retain the exact request for explicit retry or reconciliation.');
      }
      return result;
    }
    if (result?.id !== payload.applicationId || result.status !== 'Withdrawn'
      || !Number.isSafeInteger(result.version) || result.version <= payload.version) {
      throw new Error('The server did not return a confirmed withdrawal. Reload the current application status before trying again.');
    }
    return result;
  }
  if (edit) {
    const form = result?.form;
    if (result?.applicationId !== applicationId || !applicantUuid.test(result.awardId || '')
      || !applicantUuid.test(result.tenantId || '')
      || !applicantUuid.test(result.formId || '') || typeof result.formSlug !== 'string' || !result.formSlug
      || typeof result.reference !== 'string' || !Number.isSafeInteger(result.version) || result.version < 1
      || (result.existingChoiceAccess !== undefined && typeof result.existingChoiceAccess !== 'boolean')
      || !result.answers || typeof result.answers !== 'object' || Array.isArray(result.answers)
      || typeof result.deadline !== 'string' || !Number.isFinite(Date.parse(result.deadline))
      || !form || typeof form !== 'object' || Array.isArray(form)
      || form.id !== result.formId || form.tenant_id !== result.tenantId || form.slug !== result.formSlug
      || !Array.isArray(form.fields)
      || form.fields.some(field => !field || typeof field.id !== 'string' || !field.id || typeof field.type !== 'string' || !field.type)
      || new Set(form.fields.map(field => field.id)).size !== form.fields.length
      || (form.pages !== null && !Array.isArray(form.pages))) {
      throw new Error('The owner-authorised application/form projection is incomplete or does not match its form/tenant. No public-form, member-cookie or ordinary submission fallback will be used.');
    }
    // Keep the editor's explicit projection; never reintroduce original
    // business-action metadata through a public/member form fetch.
    return { ...result, displaySnapshot: recordedDisplaySnapshot(result.displaySnapshot), existingChoiceAccess: result.existingChoiceAccess === true, form: Object.fromEntries(['id', 'tenant_id', 'slug', 'name', 'title', 'description', 'fields', 'pages', 'visibility_rules', 'form_type', 'survey_settings'].map(key => [key, form[key]])) };
  }
  if (!Array.isArray(result?.applications) || !Number.isSafeInteger(result.total) || result.total < 0
    || result.page !== page || !Number.isSafeInteger(result.pageSize) || result.pageSize < 1
    || result.applications.length > result.pageSize || result.total < result.applications.length
    || new Set(result.applications.map(row => row?.id)).size !== result.applications.length
    || result.applications.some(row => !applicantUuid.test(row?.id || '') || !applicantUuid.test(row?.awardId || '')
      || typeof row.reference !== 'string' || typeof row.awardName !== 'string'
      || !Number.isSafeInteger(row.version) || row.version < 1 || typeof row.status !== 'string'
      || typeof row.canWithdraw !== 'boolean' || typeof row.submittedAt !== 'string'
      || (row.canAmend !== undefined && typeof row.canAmend !== 'boolean')
      || !Number.isFinite(Date.parse(row.submittedAt))
      || (row.outcome !== null && typeof row.outcome !== 'string')
      || (applicationId && row.id !== applicationId))) {
    throw new Error('The application list was incomplete or unreadable. No partial list has been shown. Please retry.');
  }
  return result;
}

export function useAwardApplications(session, tenantSlug, page, applicationId) {
  return useQuery({
    queryKey: [...applicantApplicationsKey(session, tenantSlug), applicationId || '', page],
    queryFn: ({ signal }) => applicantRequest(session, tenantSlug, { page, applicationId, signal }),
    retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
}
