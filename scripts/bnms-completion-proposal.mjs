import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { buildReport, checksum, TENANT_ID } from './bnms-final-resources-proposal.mjs';
import { resourceIdentity } from './audit-bnms-resource-imports-lib.mjs';
import { aliases as presentationAliases } from './bnms-presentations-proposal.mjs';

export const INPUT = 'attached_assets/bnms-missing-resources-completion_(2)_1793688904161.xlsx';
export const SOURCE_SHA = '85d3de9760320071186f7d9dacbb4b069a1f95389c98a99210b9939e0dae5dfb';
export const HEADERS = ['Reference', 'Source reference', 'What needs completing', 'Ready to upload', 'Team notes',
  'Title', 'Resource URL', 'Brief Description', 'Date', 'Member Only', 'Collection', 'Resource Type',
  'Artificial Intelligence', 'Audit', 'Bone', 'Cardiovascular', 'Careers', 'Case Studies', 'Coding & HRGs',
  'Diagnostics', 'Educational', 'Endocrinology', 'Equipment', 'Gastro', 'Haematology', 'Highlights',
  'Infection', 'Lung', 'Management', 'Management and Workforce', 'Metabolic Studies', 'Molecular Radiotherapy',
  'Neurology', 'Non Medical Reporting', 'Oncology', 'PET and PET-CT', 'Paediatrics', 'Physics – dosimetry',
  'Physics – imaging science', 'Physics – radiation protection', 'Radiopharmaceutical Development',
  'Radiopharmacy', 'Renal', 'Sentinel Node Imaging', 'Therapeutic', 'Thyroid', 'Training', 'Working in NM'];
const text = v => String(v ?? '').trim();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const topics = Object.fromEntries(HEADERS.slice(12).map(h => [h, presentationAliases[h] || h]));

export function readCompletion(bytes) {
  const book = XLSX.read(bytes, { type: 'buffer', cellFormula: true, cellNF: true });
  assert(!book.Workbook?.WBProps?.date1904, 'Unsupported 1904 dates');
  const ws = book.Sheets['Missing resources'];
  assert(ws, 'Missing resources worksheet required');
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  assert.deepEqual(matrix[0], HEADERS, 'Unexpected completion headers');
  const rows = matrix.slice(1).map((cells, i) => {
    const source = Object.fromEntries(HEADERS.map((h, c) => [h, cells[c] ?? '']));
    const hyperlinks = [], formulas = [], cellEvidence = [];
    HEADERS.forEach((header, c) => {
      const address = XLSX.utils.encode_cell({ r: i + 1, c });
      const cell = ws[address];
      if (!cell) return;
      cellEvidence.push({ address, header, type: cell.t, value: cell.v, display: cell.w, format: cell.z });
      if (cell.l) hyperlinks.push({ address, header, literal: cell.v, target: cell.l.Target });
      if (cell.f) formulas.push({ address, header, formula: cell.f });
    });
    return { row: i + 2, source, hyperlinks, formulas, cellEvidence };
  }).filter(r => Object.values(r.source).some(v => text(v)));
  assert.equal(new Set(rows.map(r => r.source.Reference)).size, rows.length, 'Duplicate reference');
  assert(rows.every(r => text(r.source.Reference) && text(r.source['Source reference'])), 'Missing reference');
  return { checksum: checksum(bytes), headers: HEADERS, rows,
    sheets: book.SheetNames.map(name => ({ name, range: book.Sheets[name]['!ref'], handling: name === 'Missing resources' ? 'candidates only' : 'reference only' })) };
}

// No implicit day/month, two-digit year, year-only, or numeric-text conversion.
export function strictDate(raw) {
  if (!text(raw)) return { value: null, kind: 'blank' };
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 2100 && raw < 100000) {
    return { value: new Date((raw - 25569) * 86400000).toISOString().slice(0, 10), kind: 'excel_serial' };
  }
  const value = text(raw);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T00:00:00Z`);
    if (Number.isFinite(+date) && date.toISOString().slice(0, 10) === value) return { value, kind: 'calendar_date' };
  }
  return { value: null, kind: 'invalid' };
}

export function completionReport(workbook, resources, categories, historicalRows = []) {
  const report = buildReport(workbook, resources, categories, { topicMapping: topics, dateValue: strictDate, link: resourceIdentity });
  const history = new Map(historicalRows.map(r => [`${r.sourceFile.split('/').at(-1)}#${r.sheet}!${r.row}`, r]));
  for (const row of report.rows) {
    row.reference = row.source.Reference;
    row.sourceReference = row.source['Source reference'];
    row.review = Object.fromEntries(HEADERS.slice(0, 5).map(h => [h, row.source[h]]));
    row.history = text(row.sourceReference).split(/\r?\n/).map(ref => {
      const old = history.get(ref);
      return { reference: ref, found: Boolean(old), issues: old?.issues ?? [],
        historicalEvidence: old?.historicalEvidence ?? null, outcome: old?.historicalOutcome ?? 'No archived evidence',
        previouslyMissingTaxonomy: old?.historicalEvidence?.issues?.filter(i => i.startsWith('missing_taxonomy:')) ?? [] };
    });
    row.historicalCategoryResolution = row.history.flatMap(h => h.previouslyMissingTaxonomy.map(issue => {
      const [, parent, value] = issue.split(':');
      const found = categories.filter(c => c.name === parent);
      return { sourceReference: h.reference, issue, availableNow: found.length === 1 && found[0].is_active !== false
        && found[0].subcategories?.includes(value) === true };
    }));
    row.historicalHoldReview = row.history.some(h => h.historicalEvidence?.held && !h.historicalEvidence?.executedId)
      ? 'Prior hold retained as evidence. Approval must confirm returned consolidated values supersede the prior conflict; category additions alone are not approval.' : null;
    if (row.history.some(h => h.historicalEvidence?.issues?.some(i => /hyperlink_conflict|formula_requires_review|approved_access_change_held/.test(i)))) {
      row.issues.push('historical_hold_requires_explicit_resolution');
    }
    // A restrictive or unknown stored access state is never relaxed or replaced
    // by a blank source marker, including on blocked proposals.
    row.requestedAccess = ['yes', 'no'].includes(text(row.source['Member Only']).toLowerCase())
      ? text(row.source['Member Only']).toLowerCase() === 'no' : null;
    row.accessDecision = row.before && row.requestedAccess !== null && row.requestedAccess !== row.before.is_public
      ? { before: row.before.is_public, requested: row.requestedAccess, proposed: row.before.is_public, held: true } : null;
    if (row.before) row.proposed.is_public = row.before.is_public;
    if (row.accessDecision) row.issues.push('access_change_requires_separate_approval');
    for (const [parent, values] of Object.entries(row.selected)) {
      const defs = categories.filter(c => c.name === parent);
      if (values.length && (defs.length !== 1 || defs[0].is_active === false
        || (Array.isArray(defs[0].applies_to_content_types) && defs[0].applies_to_content_types.length
          && !defs[0].applies_to_content_types.includes('Resources')))) {
        row.issues.push(`inactive_or_inapplicable_parent:${parent}`);
      }
    }
    row.taxonomyAccess = categories.filter(c => Object.keys(row.selected).includes(c.name)).map(c => ({
      parent: c.name, excluded_role_ids: c.excluded_role_ids, subcategory_excluded_role_ids: c.subcategory_excluded_role_ids,
    }));
    row.patch = Object.fromEntries(Object.entries(row.proposed).filter(([k, v]) => !same(v, row.before?.[k])));
    row.accessChange = false;
    row.status = row.issues.length ? 'blocked' : row.before ? Object.keys(row.patch).length ? 'update' : 'unchanged' : 'insert';
    row.approvalRequired = true;
    row.corrections = row.issues.map(issue => correction(issue));
    row.corrections.push('Ready to upload is blank/unapproved: obtain explicit approval of this exact reference and proposal before any application.');
  }
  // Source duplicates must ignore review references and cover conservative URL identities.
  const groups = new Map();
  for (const row of report.rows) {
    row.issues = row.issues.filter(i => !['conflicting_source_duplicate', 'identical_source_duplicate_review'].includes(i));
    const key = resourceIdentity(row.url).identity || (row.url ? `unresolved-url:${row.url}` : `unresolved-row:${row.row}`);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  report.duplicateGroups = [];
  for (const [key, rows] of groups) {
    if (rows.length > 1) {
      const differingFields = HEADERS.slice(5).filter(h => new Set(rows.map(r => JSON.stringify(r.source[h]))).size > 1);
      const issue = differingFields.length ? 'conflicting_source_duplicate' : 'identical_source_duplicate_review';
      report.duplicateGroups.push({ key, rows: rows.map(r => r.row), references: rows.map(r => r.reference), differingFields });
      rows.forEach(r => r.issues.push(issue));
    }
    for (const r of rows) {
      r.status = r.issues.length ? 'blocked' : r.before ? Object.keys(r.patch).length ? 'update' : 'unchanged' : 'insert';
      r.corrections = [...r.issues.map(correction), 'Explicit approval required; blank readiness is not approval.'];
    }
  }
  report.uniqueResources = [...groups].map(([identity, rows]) => ({
    identity, references: rows.map(r => r.reference), rows: rows.map(r => r.row),
    status: rows.some(r => r.status === 'blocked') ? 'blocked' : rows[0].status,
    identityVerified: !identity.startsWith('unresolved-'),
  }));
  report.topicMapping = topics;
  report.summary = {
    sourceRows: report.rows.length,
    ...Object.fromEntries(['insert', 'update', 'unchanged', 'blocked'].map(s => [s, report.rows.filter(r => r.status === s).length])),
    uniqueResourceGroups: groups.size,
    verifiedIdentities: report.uniqueResources.filter(g => g.identityVerified).length,
    unresolvedIdentityRows: report.rows.filter(r => !resourceIdentity(r.url).valid).length,
    unresolvedLiteralGroups: report.uniqueResources.filter(g => !g.identityVerified).length,
    uniqueStatuses: Object.fromEntries(['insert', 'update', 'unchanged', 'blocked'].map(s => [s, report.uniqueResources.filter(g => g.status === s).length])),
    blankReadiness: report.rows.filter(r => !text(r.review['Ready to upload'])).length,
    historicallyMissingCategoryNowAvailableRows: report.rows.filter(r => r.historicalCategoryResolution.some(h => h.availableNow)).length,
    heldAccessDecisions: report.rows.filter(r => r.accessDecision).length,
    databaseWrites: 0,
  };
  assert.equal(report.summary.sourceRows, ['insert', 'update', 'unchanged', 'blocked'].reduce((n, s) => n + report.summary[s], 0));
  report.safeSubset = report.rows.filter(r => ['insert', 'update'].includes(r.status)).map(r => ({
    reference: r.reference, row: r.row, sourceReference: r.sourceReference, status: r.status,
    before: r.before, patch: r.patch, proposed: r.proposed, approvalRequired: true,
    historicalHoldReview: r.historicalHoldReview, history: r.history,
  }));
  report.safeSubsetChecksum = checksum(JSON.stringify(report.safeSubset));
  report.tenantId = TENANT_ID;
  return report;
}

export function correction(issue) {
  if (issue === 'invalid_date') return 'Confirm a complete YYYY-MM-DD date; month/year-only and numeric text are not silently converted. Blank dates preserve stored values.';
  if (issue === 'invalid_url') return 'Supply and verify a full HTTP(S) resource URL; no scheme is automatically added.';
  if (issue.includes('access')) return 'Confirm Member Only Yes/No and review access separately; existing restrictions remain unchanged.';
  if (issue.startsWith('missing_classification:')) return `Fill ${issue.split(':')[1]} using a current value under that parent.`;
  if (issue.includes('taxonomy') || issue.includes('parent')) return `Resolve against the active resource taxonomy without creating categories: ${issue}`;
  if (issue.includes('duplicate') || issue.includes('matches') || issue.includes('candidate')) return `Identify the single intended resource and reconcile conflicting source rows; never select by title alone: ${issue}`;
  if (issue.includes('hyperlink') || issue.includes('formula')) return `Confirm the literal URL and embedded target/formula agree: ${issue}`;
  if (issue.includes('marker')) return `Use Yes, No or blank for the topic flag: ${issue}`;
  return `Resolve the held input: ${issue}`;
}
