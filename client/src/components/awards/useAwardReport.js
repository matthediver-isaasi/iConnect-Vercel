import { useQuery } from '@tanstack/react-query';
import { adminFetch } from '@/lib/adminFetch';

export const REPORT_COLUMNS = {
  summaries: ['Application', 'Eligibility', 'Complete', 'Score', 'Exact numerator', 'Exact denominator', 'Completed assessments', 'Discrepancy', 'Moderation', 'Shortlist'],
  matrix: ['Application', 'Judge', 'Revision', 'Included', 'Score', 'Exact numerator', 'Exact denominator'],
  criteria: ['Application', 'Judge', 'Revision', 'Included', 'Criterion', 'Criteria version', 'Answer', 'Comment'],
  workload: ['Application', 'Judge', 'State', 'Included', 'Ranking score available'],
};
export const REPORT_LABELS = { summaries: 'Application summaries', matrix: 'Submitted judge matrix', criteria: 'Criterion responses', workload: 'Assignment workload status' };
const MIME = {
  csv: 'text/csv', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf',
};
const mediaType = value => String(value || '').split(';')[0].trim().toLowerCase();

function reportUrl(roundId, format, section) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(roundId) || !['json', 'csv', 'xlsx', 'pdf'].includes(format) || (section !== undefined && !Object.hasOwn(REPORT_COLUMNS, section))) throw new Error('Choose a valid report round, section and format.');
  const params = new URLSearchParams({ roundId, format });
  if (section !== undefined && format !== 'xlsx') params.set('section', section);
  // Only the canonical round UUID and format/section enums enter the URL.
  // Application references, aliases, answers and local filters never do.
  return `/api/awards/report?${params.toString()}`;
}

async function reportError(response, tenant) {
  let message = `The complete report could not be generated (${response.status}).`;
  try {
    const body = await response.json();
    if (typeof body?.error === 'string') message = body.error;
  } catch { /* Never display a login document or download it as a report. */ }
  tenant.assertCurrent();
  return new Error(message);
}

function verifyReport(result, roundId) {
  if (result?.round?.id !== roundId || typeof result.round.name !== 'string') throw new Error('The report round could not be verified. No partial report has been used.');
  for (const [section, columns] of Object.entries(REPORT_COLUMNS)) {
    if (!Array.isArray(result[section]) || result[section].some(row => !row || typeof row !== 'object' || columns.some(column => !Object.hasOwn(row, column) || (row[column] !== null && !['string', 'number', 'boolean'].includes(typeof row[column])) || (typeof row[column] === 'number' && !Number.isFinite(row[column]))))) throw new Error('The complete report response is invalid. No partial report has been used.');
    if (result[section].some(row => typeof row.Application !== 'string' || (section !== 'summaries' && (typeof row.Judge !== 'string' || !/^Judge [A-F0-9]{8}$/.test(row.Judge) || !['Yes', 'No'].includes(row.Included))))) throw new Error('Application references or round-local server judge aliases could not be verified. Reload the complete report.');
  }
  if (result.workload.some(row => typeof row.State !== 'string' || !row.State || !['Yes', 'No'].includes(row['Ranking score available']))) throw new Error('Workload status and ranking-availability flags could not be verified. No partial report is displayed.');
  if (result.summaries.some(row => !['Yes', 'No'].includes(row.Complete) || !['Yes', 'No'].includes(row.Discrepancy))) throw new Error('Report completion and discrepancy flags could not be verified.');
  if (!Array.isArray(result.applications) || result.applications.length !== result.summaries.length) throw new Error('The complete report application-discovery metadata is missing or incomplete. Reload the report; application IDs are never inferred from references.');
  const ids = new Set(), references = new Map();
  for (const row of result.summaries) references.set(row.Application, (references.get(row.Application) || 0) + 1);
  for (const application of result.applications) {
    if (!application || typeof application.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(application.id)
      || ids.has(application.id.toLowerCase()) || typeof application.reference !== 'string' || !application.reference.trim()
      || !(references.get(application.reference) > 0)) throw new Error('Report application IDs/references are invalid, duplicated or inconsistent with this snapshot. No partial discovery list is used.');
    ids.add(application.id.toLowerCase());
    references.set(application.reference, references.get(application.reference) - 1);
  }
  const knownReferences = new Set(result.applications.map(application => application.reference));
  if (['matrix', 'criteria', 'workload'].some(section => result[section].some(row => !knownReferences.has(row.Application)))) throw new Error('Report rows do not match the discovered application snapshot. Reload the complete report before viewing history or exporting.');
  return result;
}

export function useAwardReport(roundId, tenant) {
  return useQuery({
    queryKey: ['award-report', tenant.scopeKey, roundId],
    enabled: Boolean(roundId),
    queryFn: async ({ signal }) => {
      tenant.assertCurrent();
      const response = await adminFetch(reportUrl(roundId, 'json'), { cache: 'no-store', signal, headers: { Accept: 'application/json' } }, tenant.tenantId);
      tenant.assertCurrent();
      if (!response.ok) throw await reportError(response, tenant);
      if (response.redirected || mediaType(response.headers.get('content-type')) !== 'application/json') throw new Error('The server did not return a complete JSON report. Verify your session and retry.');
      const result = await response.json();
      tenant.assertCurrent();
      return verifyReport(result, roundId);
    },
    retry: false, gcTime: 0, staleTime: 0, refetchOnMount: 'always', refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
}

export async function fetchAwardReportExport({ roundId, format, section, tenant, signal }) {
  if (!Object.hasOwn(MIME, format)) throw new Error('Choose CSV, Excel or PDF.');
  tenant.assertCurrent();
  const response = await adminFetch(reportUrl(roundId, format, section), { signal, cache: 'no-store', headers: { Accept: MIME[format] } }, tenant.tenantId);
  tenant.assertCurrent();
  if (!response.ok) throw await reportError(response, tenant);
  if (response.redirected || mediaType(response.headers.get('content-type')) !== MIME[format]) throw new Error('The export response was not the requested report file. Nothing was downloaded; verify your session and retry.');
  const blob = await response.blob();
  tenant.assertCurrent();
  if (!blob || !Number.isFinite(blob.size) || blob.size < 1 || (blob.type && mediaType(blob.type) !== MIME[format])) throw new Error('The report file is empty or has an unexpected type. No partial export was downloaded.');
  const head = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
  if (format === 'xlsx' && !(head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04)) throw new Error('The Excel workbook could not be verified. No fallback or partial file was downloaded.');
  if (format === 'pdf' && (!(head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2d) || !(await blob.slice(-1024).text()).includes('%%EOF'))) throw new Error('The PDF file could not be verified. No partial export was downloaded.');
  if (format === 'csv') {
    const columns = (await blob.slice(0, 2048).text()).replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0].split(',').map(value => value.replace(/^"|"$/g, ''));
    const expected = REPORT_COLUMNS[section || 'summaries'];
    // The existing endpoint emits an Application-only header for an empty
    // section. Accept that only when the entire file is demonstrably empty
    // of data rows; never accept a mismatched nonempty section as a fallback.
    const emptySection = blob.size < 64 && /^(?:"Application"|Application)(?:\r?\n)*$/.test((await blob.text()).replace(/^\uFEFF/, ''));
    if (!emptySection && (columns.length !== expected.length || columns.some((value, index) => value !== expected[index]))) throw new Error('The CSV section schema could not be verified. No fallback file was downloaded.');
  }
  tenant.assertCurrent();
  if (signal?.aborted) throw new DOMException('Report download cancelled.', 'AbortError');
  return { blob, filename: `awards-${roundId}-${format === 'xlsx' ? 'all-sections' : section}.${format}` };
}
