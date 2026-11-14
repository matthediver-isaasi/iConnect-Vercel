import { useQuery } from '@tanstack/react-query';
import * as pdfjs from 'pdfjs-dist';
import { adminFetch } from '@/lib/adminFetch';
import { decisionRequest, latestOutcomes } from './useAwardDecisions';
import { validatedPdf } from '@/lib/awardCertificatePdf';
export { downloadCertificate } from '@/lib/awardCertificatePdf';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
export const CERTIFICATE_LIMIT = 10 * 1024 * 1024;
export const certificateKeys = ['recipient.name', 'award.name', 'award.cycle', 'programme.name', 'category.name', 'application.reference', 'issued.date'];
export const certificateQueryKey = (tenant, awardId) => ['award-certificates', tenant.scopeKey, awardId];

export async function certificateRequest(tenant, url, { body, signal, pdf = false } = {}) {
  tenant.assertCurrent();
  const response = await adminFetch(url, { signal, cache: 'no-store', redirect: 'error',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Awards-Request': '1' }, body: JSON.stringify(body) }),
  }, tenant.tenantId);
  tenant.assertCurrent();
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    tenant.assertCurrent();
    throw Object.assign(new Error(result.error || `Certificate request failed (${response.status}).`), { status: response.status });
  }
  const result = pdf ? await validatedPdf(response) : await response.json();
  tenant.assertCurrent();
  return result;
}
export async function inspectCertificatePdf(blob) {
  if (!blob.size || blob.size > CERTIFICATE_LIMIT) throw new Error('Choose a non-empty PDF no larger than 10 MB.');
  const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false });
  try {
    const document = await task.promise, pages = [];
    for (let index = 1; index <= document.numPages; index += 1) {
      const page = await document.getPage(index), viewport = page.getViewport({ scale: 1 });
      pages.push({ width: viewport.width, height: viewport.height });
    }
    if (!pages.length) throw new Error('The source PDF has no pages.');
    return pages;
  } finally { await task.destroy(); }
}
async function completeCertificateLibrary(tenant, awardId, signal) {
  const templates = [], issues = [], seenTemplates = new Set(), seenIssues = new Set();
  let templateTotal, issueTotal, placeholderKeys;
  for (let page = 1; page <= 10000; page += 1) {
    const result = await certificateRequest(tenant, `/api/awards/certificates?awardId=${encodeURIComponent(awardId)}&page=${page}`, { signal });
    if (result.page !== page || !Number.isSafeInteger(result.pageSize) || result.pageSize < 1
      || !Array.isArray(result.templates) || !Array.isArray(result.issues) || !Array.isArray(result.placeholderKeys)
      || !Number.isSafeInteger(result.templateTotal) || result.templateTotal < 0 || !Number.isSafeInteger(result.issueTotal) || result.issueTotal < 0
      || (templateTotal !== undefined && (templateTotal !== result.templateTotal || issueTotal !== result.issueTotal))) throw new Error('Certificate records changed or were incomplete. Reload; no partial list is used.');
    templateTotal = result.templateTotal; issueTotal = result.issueTotal; placeholderKeys = result.placeholderKeys;
    for (const [rows, target, seen] of [[result.templates, templates, seenTemplates], [result.issues, issues, seenIssues]]) {
      for (const row of rows) {
        if (!row.id || seen.has(row.id)) throw new Error('Certificate pagination changed. Reload the complete library.');
        seen.add(row.id); target.push(row);
      }
    }
    if (templates.length === templateTotal && issues.length === issueTotal) return { templates, issues, placeholderKeys };
    if (templates.length > templateTotal || issues.length > issueTotal
      || (templates.length < templateTotal && result.templates.length < result.pageSize)
      || (issues.length < issueTotal && result.issues.length < result.pageSize)) throw new Error('The certificate library is incomplete. No partial list is used.');
  }
  throw new Error('Certificate library exceeds the page limit. No partial list is used.');
}
async function approvedCertificateOutcomes(tenant, awardId, signal) {
  const rows = [], seen = new Set();
  for (let page = 1; page <= 10000; page += 1) {
    const result = await decisionRequest(tenant, `/api/awards/outcomes?awardId=${encodeURIComponent(awardId)}&page=${page}`, undefined, signal);
    if (result.page !== page || !Array.isArray(result.outcomes) || !Number.isSafeInteger(result.pageSize) || result.pageSize < 1) throw new Error('Approved outcomes could not be loaded completely.');
    for (const row of result.outcomes) {
      if (!row.id || seen.has(row.id)) throw new Error('Outcome history changed while loading. Reload before generation.');
      seen.add(row.id); rows.push(row);
    }
    if (result.outcomes.length < result.pageSize) return [...latestOutcomes(rows).values()].filter(row => row.state === 'approved' && row.category_snapshot?.certificate_enabled === true);
  }
  throw new Error('Outcome history exceeds the page limit. No partial list is used.');
}
export function useAwardCertificateLibrary(tenant, awardId) {
  return useQuery({ queryKey: certificateQueryKey(tenant, awardId), queryFn: ({ signal }) => completeCertificateLibrary(tenant, awardId, signal),
    retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false });
}
export function useCertificateOutcomes(tenant, awardId) {
  return useQuery({ queryKey: ['award-certificate-outcomes', tenant.scopeKey, awardId], queryFn: ({ signal }) => approvedCertificateOutcomes(tenant, awardId, signal),
    retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false });
}
