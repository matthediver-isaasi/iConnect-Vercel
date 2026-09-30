import XLSX from 'xlsx';

const scalar = (value) => value != null && typeof value === 'object' ? JSON.stringify(value) : value ?? '';
const safe = (value) => typeof value === 'string' && /^[=+\-@]/.test(value) ? `'${value}` : value;

export function writeAuditWorkbook(path, audit) {
  const workbook = XLSX.utils.book_new();
  const add = (name, rows) => {
    const values = (rows.length ? rows : [{ value: '' }]).map((row) => Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, safe(scalar(value))]),
    ));
    const sheet = XLSX.utils.json_to_sheet(values);
    sheet['!autofilter'] = { ref: sheet['!ref'] };
    sheet['!freeze'] = { xSplit: 0, ySplit: 1 };
    XLSX.utils.book_append_sheet(workbook, sheet, name);
  };
  add('Summary', Object.entries(audit.summary).map(([metric, value]) => ({ metric, value })));
  add('Source rows', audit.rows.map((row) => ({
    sourceFile: row.sourceFile, sheet: row.sheet, sourceRow: row.row,
    classification: row.classification, title: row.title, sourceUrl: row.sourceUrl,
    identity: row.identity, intent: row.intent, memberOnly: row.memberOnly,
    collection: row.collection, resourceType: row.resourceType, candidateIds: row.candidateIds,
    titleCandidateIds: row.titleCandidateIds, issues: row.issues,
    historicalEvidence: row.historicalEvidence,
    hyperlinks: row.hyperlinks, originalSourceValues: row.source,
    absentFromDestination: row.absentFromDestination,
    humanReason: row.humanReason,
    recommendedNextAction: row.recommendedNextAction,
    historicalOutcome: row.historicalOutcome,
    historicalTimeline: row.historicalTimeline,
    currentOutcome: row.currentOutcome,
    mismatchFields: row.mismatchFields,
    desiredValues: row.desiredValues,
    matchedValues: row.matchedValues,
    contextualAccessEvidence: row.contextualAccessEvidence,
    matchMethod: row.matchMethod,
    urlIdentityCandidateIds: row.urlIdentityCandidateIds,
  })));
  add('Distinct identities', audit.distinctIdentities);
  add('Missing candidate review', [
    ...audit.missingCandidateReview.confirmedAbsent,
    ...audit.missingCandidateReview.unresolvedWithoutExecutionEvidence,
  ]);
  add('Inventory', audit.inventory.map((item) => ({
    ...item, sheets: item.sheets,
  })));
  add('Per-file totals', audit.fileSummaries);
  add('Taxonomy access', audit.taxonomy);
  add('Historical evidence', audit.historicalEvidence);
  add('Scope history', audit.supplementalScopeEvidence.executionJournals);
  add('Scope caveats', audit.supplementalScopeEvidence.caveats.map((caveat) => ({ caveat })));
  add('Snapshot provenance', [audit.snapshotProvenance]);
  XLSX.writeFile(workbook, path, { compression: true });
}