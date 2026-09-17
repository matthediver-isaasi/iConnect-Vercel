/** Local report files only. No database calls. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import XLSX from 'xlsx';
import { PROJECT, SURVEY, ROW } from './workforce-readonly-state.mjs';
import { resolveOption } from './workforce-csv-audit.mjs';

const escape = s => String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const code = s => `<code>${escape(s)}</code>`;
const table = (headers, rows) => `<div class="scroll"><table><thead><tr>${headers.map(h => `<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row =>
  `<tr>${row.map(cell => `<td>${cell ?? ''}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const money = n => Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pick = (obj, keys) => Object.fromEntries(keys.map(k => [k, obj[k] ?? null]));
const csvCell = x => `"${String(x ?? '').replaceAll('"', '""')}"`;
const writeCsv = (file, headers, rows) => fs.writeFileSync(file,
  '\ufeff' + [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n');

export function verifyPriorSample(state, audit) {
  const bytes = fs.readFileSync(new URL('../attached_assets/Sample_Workforce_data_1788536544654.xlsx', import.meta.url));
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  if (fingerprint !== 'f85374976acdb625f36dc58465eae9160f3853e4ade2d6abea07d719f68739ad') {
    return { verified: false, message: 'Prior sample fingerprint changed.' };
  }
  const workbook = XLSX.read(bytes, { type: 'buffer', raw: true });
  const grid = XLSX.utils.sheet_to_json(workbook.Sheets.Sheet1, { header: 1, raw: true, defval: null });
  if (grid.length !== 9) return { verified: false, message: 'Prior sample row count changed.' };
  const mapping = new Map(audit.mapping.map(m => [m.name, m]));
  const key = d => JSON.stringify([d.row_name, d.staff_group, d.grade, d.occupied_wte, d.vacant_wte ?? null, d.legacy_vacancy_reported]);
  const matches = grid.slice(1).map((r, i) => {
    const data = { row_name: r[1], staff_group: r[2], grade: r[3], occupied_wte: r[4],
      ...(r[5] === null ? {} : { vacant_wte: r[5] }), legacy_vacancy_reported: r[6] };
    for (const name of ['staff_group', 'grade', 'legacy_vacancy_reported']) {
      data[name] = resolveOption(mapping.get(name), data[name]).value;
    }
    const outside = audit.outsideSurveys.filter(s => s.reportingYear === data.row_name && s.departmentIds.includes(r[0]));
    const candidates = state.records.filter(record => outside.some(s => s.rowIds.includes(record.id)) && key(record.data) === key(data));
    return { sourceRow: i + 2, departmentId: r[0], matchedIds: candidates.map(x => x.id) };
  });
  return { fingerprint, verified: matches.every(m => m.matchedIds.length === 1)
    && new Set(matches.flatMap(m => m.matchedIds)).size === 8,
  rows: 8, departments: new Set(matches.map(m => m.departmentId)).size,
  departmentOverlapWithCsv: matches.filter(m => audit.groups.some(g => g.departmentId === m.departmentId)).length,
  matches };
}

export function writeReport({ source, summary, state, audit, observation, outDir }) {
  fs.mkdirSync(outDir, { recursive: true });
  const sourceFile = 'attached_assets/Workforce_data_to_import_05.09.26_1789641429024.csv';
  const priorSample = verifyPriorSample(state, audit);
  if (!priorSample.verified) audit.blockers.push({ code: 'PRIOR_SAMPLE', message: 'Prior sample cannot be verified; do not claim all prior rows reconciled.' });
  audit.readiness = audit.blockers.length ? 'BLOCKED' : 'AWAITING_SEPARATE_APPROVAL';
  const mappedObjects = state.objects.filter(o => [SURVEY, ROW, audit.departmentObject?.id].includes(o.id));
  const evidence = {
    observation, project: PROJECT, tenant: state.tenant,
    objects: mappedObjects.map(o => pick(o, ['id', 'tenant_id', 'object_key', 'singular_label', 'plural_label', 'status', 'primary_display_field_id'])),
    fields: state.fields.map(f => pick(f, ['id', 'tenant_id', 'custom_object_id', 'entity_scope', 'name', 'label', 'field_type',
      'is_active', 'is_required', 'archived_at', 'options', 'min_length', 'max_length', 'min_selections', 'max_selections'])),
    relationships: state.definitions.filter(d => [d.source_custom_object_id, d.target_custom_object_id].some(id => [SURVEY, ROW].includes(id)))
      .map(d => pick(d, ['id', 'tenant_id', 'relationship_key', 'status', 'source_kind', 'source_custom_object_id', 'target_kind', 'target_custom_object_id',
        'cardinality', 'is_required', 'show_on_source', 'edit_from_source', 'show_on_target', 'edit_from_target', 'configuration'])),
    existingWorkforceRecords: state.records.filter(r => [SURVEY, ROW].includes(r.custom_object_id)),
    existingWorkforceEdges: state.edges.filter(e => state.records.some(r => [SURVEY, ROW].includes(r.custom_object_id)
      && [e.source_record_id, e.target_record_id].includes(r.id)))
      .map(e => pick(e, ['id', 'tenant_id', 'relationship_definition_id', 'source_record_id', 'target_record_id', 'archived_at', 'field_values'])),
    pagination: state.ledger, priorSample,
  };
  const report = {
    title: 'BNMS Workforce CSV — read-only validation', status: `${audit.readiness} — NO IMPORT AUTHORIZED`,
    sourceFile, sourceSha256: source.fingerprint, observation, source: summary,
    approvedTransformation: { originalBlankCount: 53, destinationValue: 'No',
      lines: source.rows.filter(r => r.originalLegacy === '').map(r => r.sourceRow),
      originalCsvUnchanged: true, suppliedYesNoUnchanged: true },
    safety: { databaseWrites: 0, applyExecuted: false, rpcCalls: 0, migrationsApplied: 0,
      workflowsTriggered: 0, transport: 'Allowlisted destination table GET only; redirects rejected',
      localOutputsOnly: true },
    identityProposal: {
      survey: 'Tenant + survey object + Department UUID + reporting year; exact active survey match only.',
      occurrence: 'SHA-256 of JSON [tenant UUID, row object UUID, exact CSV SHA-256, physical source line]. Not a staff/grade/value key.',
      rerun: 'Future approved implementation must atomically persist and uniquely enforce identity-to-record binding, verify data and both edges, and reject identity drift. This validation creates no binding or database schema.',
      existingOverlap: 'No arbitrary value-based reuse of repeated occurrences. Ambiguous existing matches block. Reordered/changed files need cross-file reconciliation and fresh approval.',
    },
    ...audit, priorSample,
  };
  fs.writeFileSync(path.join(outDir, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'live-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  writeCsv(path.join(outDir, 'departments.csv'),
    ['Department UUID', 'Department name', 'Year', 'Source rows', 'Occupied WTE', 'Department status', 'Prospective survey', 'Prospective rows create',
      'Rows reuse', 'Rows conflict', 'Rows with mapping blockers', 'Prospective Department edge', 'Source lines'],
    audit.groups.map(g => [g.departmentId, g.departmentName, g.reportingYear, g.sourceRows, g.occupiedWte.toFixed(2), g.departmentStatus,
      g.surveyAction, g.rowsCreate, g.rowsReuse, g.rowsConflict, g.rowsMappingBlocked, g.surveyDepartmentEdgeAction, g.sourceLines.join(';')]));
  writeCsv(path.join(outDir, 'occurrences.csv'),
    ['Source line', 'Department UUID', 'Survey reporting year', 'Row name', 'Proposed staff group (see blockers)', 'Proposed grade (see blockers)', 'Occupied WTE',
      'Vacant WTE status', 'Original legacy answer', 'Canonical legacy answer', 'Prospective row action', 'Prospective Survey edge', 'Mapping issues', 'Provisional identity'],
    audit.rowPlan.map(r => [r.sourceRow, r.departmentId, source.reportingYear, r.data.row_name, r.data.staff_group, r.data.grade,
      r.data.occupied_wte.toFixed(2), 'UNSET (not zero)', r.originalLegacy, r.data.legacy_vacancy_reported, r.action,
      r.surveyEdgeAction, r.mappingIssues.join('; '), r.provisionalIdentity]));
  writeCsv(path.join(outDir, 'duplicates.csv'), ['Comparison', 'Department UUID', 'Staff group', 'Grade', 'Rows in group', 'Source lines', 'Occupied WTE across occurrences'],
    Object.entries(summary.duplicateGroups).flatMap(([mode, groups]) => groups.map(g => [
      mode, g.rows[0].departmentId, g.rows[0].data.staff_group, g.rows[0].data.grade, g.rows.length,
      g.sourceRows.join(';'), (g.rows.reduce((sum, r) => sum + r.occupiedHundredths, 0) / 100).toFixed(2),
    ])));
  const countRows = ['surveys', 'rows', 'surveyDepartmentEdges', 'rowSurveyEdges'].map(k => [
    k, audit.counts[k].create, audit.counts[k].reuse, audit.counts[k].conflict,
  ]);
  const missingOptions = audit.blockers.filter(b => b.code === 'OPTION');
  const whitespace = audit.blockers.filter(b => b.code === 'OPTION_WRITE_COMPATIBILITY');
  const normalizedDup = summary.exactDuplicates.normalized;
  const liveCount = label => state.ledger.find(l => l.label === label)?.count;
  const edgePages = state.ledger.find(l => l.label === 'custom_object_relationship')?.requests;
  const noOverlap = audit.groups.every(g => g.surveyAction === 'create') && audit.counts.rows.conflict === 0;
  const outsideEdges = evidence.existingWorkforceEdges.filter(e => !e.archived_at && audit.outsideSurveys.some(s =>
    s.id === e.source_record_id || s.rowIds.includes(e.source_record_id))).length;
  const details = `
<h1>BNMS Workforce CSV</h1><p class="subtitle">Read-only destination audit and provisional dry run • ${escape(observation.finishedAt)}</p>
<div class="notice"><strong>${escape(audit.readiness)} — no import approved or executed.</strong><br>
Zero database writes, RPC calls, metadata changes, migrations, or workflows. All CSV occurrences are retained. “Create” below is a comparison result, not an executable or approved plan.</div>
<h2>1. Verified destination and coverage</h2>
<p>British Nuclear Medicine Society: live tenant display name ${code(state.tenant.name)}, slug ${code(state.tenant.slug)}, ID ${code(state.tenant.id)}.
Destination ${code(PROJECT)} was checked through its authenticated, pinned REST endpoint. No legacy source or Replit-managed database was used.</p>
<p>The full relevant read was repeated; both snapshots had the same content fingerprint ${code(observation.fingerprint)}.
This is an observed stable comparison, not an atomic SQL snapshot. Revalidate immediately before any separately approved import.</p>
${observation.earlierMetadataChanges?.length ? `<p><strong>Change observed during the audit:</strong> ${observation.earlierMetadataChanges.map(escape).join(' ')} The final stable evidence below is authoritative for this report. This validation made no database writes.</p>` : ''}
${table(['Object', 'Key', 'Live UUID', 'Status'], evidence.objects.map(o => [escape(o.singular_label), code(o.object_key), code(o.id), escape(o.status)]))}
<p><strong>${audit.counts.departments.active}/${summary.totalDepartments}</strong> supplied Department UUIDs resolve to active BNMS Department records.
Missing: ${audit.counts.departments.missing}; archived: ${audit.counts.departments.archived}; cross-tenant: ${audit.counts.departments['cross-tenant']}; wrong-object: ${audit.counts.departments['wrong-object']}.</p>
<h2>2. Source totals and approved transformation</h2>
<p>Original file: ${code(sourceFile)}<br>SHA-256: ${code(source.fingerprint)}. The original CSV is unchanged.
Windows-1252 byte 0x96 was decoded as the Unicode en dash (–); no label punctuation was replaced with a hyphen or replacement character.</p>
${table(['Measure', 'Value'], [
  ['Reporting year', code(source.reportingYear)], ['Retained occurrences', summary.totalRows], ['Department/year groups', summary.totalDepartments],
  ['Occupied WTE', money(summary.totalWte)], ['Zero occupied WTE rows', summary.zeroOccupiedRows],
  ['Original vacancy', '1,088 No · 101 Yes · 53 blank'], ['Approved normalized vacancy', '<strong>1,141 No · 101 Yes · 0 blank</strong>'],
  ['Vacant WTE', '<strong>Unset for every row — never inferred as zero</strong>'],
])}
<p>Only the 53 originally blank legacy answers become the live canonical ${code('No')}. All supplied Yes/No answers retain their meaning and canonical value.
The transformation applies to proposed new source occurrences only; no existing live record is changed.</p>
<details><summary>All 53 converted source lines</summary><p>${report.approvedTransformation.lines.join(', ')}</p></details>
<h2>3. Verified mapping</h2>
${table(['CSV column / derivation', 'Destination', 'Live field / relationship UUID', 'Type / cardinality', 'Required'], [
  ['Department_UUID', 'Survey → existing Department (match-only)', code(audit.relationships[0].id), 'many_to_one', 'Yes (Survey source side)'],
  ...audit.mapping.map(m => [escape(m.source), code(`${m.objectId === SURVEY ? 'Survey' : 'Row'}.${m.name}`), code(m.id), escape(m.type), String(m.required)]),
])}
<p>${code('2025/26')} supplies both survey ${code('survey_name')} (Reporting year) and required row ${code('row_name')} (Row name), matching the prior sample convention.
No extra required fields or required relationships are currently missing: ${audit.requiredGaps.length} required/value gaps.
Department is inherited through the Survey: <strong>no direct Row → Department edges</strong> are proposed.</p>
${table(['Relationship', 'Live UUID', 'Direction', 'Cardinality', 'Required source'], audit.relationships.map(d => [
  code(d.relationship_key), code(d.id), d.source_custom_object_id === ROW ? 'Row → Survey' : 'Survey → Department', escape(d.cardinality), String(d.is_required),
]))}
<h2>4. Mapping blockers</h2>
<p>Unsupported supplied dropdown labels in the final stable snapshot: <strong>${missingOptions.length}</strong>.
${missingOptions.length ? 'See unresolved labels below.' : 'Every supplied dropdown label now resolves uniquely to a live canonical value; write-path compatibility remains separate.'}</p>
${table(['Issue', 'Source occurrences', 'Explanation / next decision'], [
  ...missingOptions.map(b => [code(`${b.field}: ${b.supplied}`), b.count, 'Not present in live options. Decide whether to authorize adding this exact option or supply a confirmed correction. No option was added.']),
  ...whitespace.map(b => [code(`${b.field}: ${JSON.stringify(b.value)}`), b.count,
    'The live canonical value ends in a space. Unique trimmed-label/value matching resolves it, but the normal record validator trims input and rejects it. Agree a validated exact-canonical import path or separately authorize a metadata/data repair. Neither is done here.']),
  ...audit.blockers.filter(b => !['OPTION', 'OPTION_WRITE_COMPATIBILITY'].includes(b.code)).map(b => [code(b.code), '', escape(b.message)]),
])}
<p><strong>${audit.counts.mappingBlockedRows} distinct source rows</strong> have at least one mapping or write-path blocker (counts above may overlap).
Staff and Grade canonical whitespace is preserved explicitly in the occurrence file, not silently removed.
The existing eight-row XLSX importer and SQL RPC must not be used for this CSV: they hard-code 8 rows / 3 Departments and reject repeated natural keys.</p>
<details><summary>All supplied option mappings and canonical values</summary>
${table(['Field', 'Source label', 'Canonical stored value (JSON shows spaces)', 'Occurrences', 'Result'], audit.optionResolution.map(o => [
  code(o.field), escape(o.supplied), o.error ? 'UNRESOLVED' : code(JSON.stringify(o.value)), o.count, escape(o.error || o.match),
]))}</details>
<details><summary>All live dropdown options, including unused options</summary>
${audit.mapping.filter(m => m.options).map(m => `<h3>${escape(m.name)} — ${escape(m.id)}</h3>${table(['Label', 'Stored value'], m.options.map(o =>
  [code(JSON.stringify(o.label)), code(JSON.stringify(o.value))]))}`).join('')}</details>
<h2>5. Live reconciliation (prospective only)</h2>
${table(['Entity / edge', 'Would create', 'Would reuse', 'Conflicting'], countRows)}
<p>${noOverlap ? 'No active or archived source-Department/year surveys or associated row overlaps were found.' : 'Existing overlaps or unavailable source targets require review; see the counts and blockers above.'}
There are ${audit.counts.existingActiveSurveys} existing active workforce surveys and ${audit.counts.existingActiveRows} active rows across other Departments,
with ${audit.counts.existingArchivedSurveys} archived surveys and ${audit.counts.existingArchivedRows} archived rows.
All ${audit.counts.outsideSurveysPreserved} outside surveys, ${audit.counts.outsideRowsPreserved} rows, and their ${outsideEdges} active edges remain untouched.
The pinned prior sample XLSX was independently compared locally with the live records: ${priorSample.verified ? '<strong>all 8 rows across 3 Departments matched uniquely</strong>' : '<strong>BLOCKED: prior sample not verified</strong>'}.
No survey merge, overwrite, deletion, archive, or restoration is proposed.</p>
${table(['Existing survey outside CSV', 'Department', 'Rows preserved'], audit.outsideSurveys.map(s => [code(s.id),
  s.departmentIds.map(id => `${escape(state.records.find(r => r.id === id)?.data?.name)}<br>${code(id)}`).join('<br>'), s.rowIds.length]))}
<h2>6. Duplicates — retain every occurrence pending approval</h2>
${table(['Comparison', 'Duplicate groups', 'Rows in those groups', 'Occurrences beyond first'], [
  ['Original exact values', 82, 210, 128], ['After approved blank → No', normalizedDup.groups, normalizedDup.rows, normalizedDup.beyondFirst],
  ['Department/year/staff/grade (ignores WTE and vacancy)', 155, 425, 270],
])}
<p>The wider staff/grade groups contain potentially distinct measurements; they are not a deduplication key.
The provisional plan retains <strong>1,242 rows and 1,708.14 occupied WTE</strong>. No aggregation or deduplication has occurred.</p>
${table(['Illustrative alternative — NOT applied', 'Rows', 'Occupied WTE', 'WTE removed vs preserve-all'], [
  ['Keep first of original exact duplicates', summary.alternativeExactDedupTotals.original.rows, money(summary.alternativeExactDedupTotals.original.occupiedWte), money(summary.totalWte - summary.alternativeExactDedupTotals.original.occupiedWte)],
  ['Keep first of normalized exact duplicates', summary.alternativeExactDedupTotals.normalized.rows, money(summary.alternativeExactDedupTotals.normalized.occupiedWte), money(summary.totalWte - summary.alternativeExactDedupTotals.normalized.occupiedWte)],
])}
<h3>Source-line examples</h3>
${table(['Physical CSV lines', 'Example', 'Effect'], [
  ['27, 28', 'Same Department; Clinical Practitioner – Technologist / Band 6 / 0.80 / No', 'Two occurrences retained; deduplication would remove 0.80 WTE.'],
  ['78, 82 (79 remains Yes)', 'Radiographer / Band 6 / 0.60; No and blank become two identical No occurrences', 'Normalization creates an exact match; the Yes row remains distinct.'],
  ['101, 102', 'Same Department; Radiographer / Band 6 / 1.00; No and blank', 'The approved conversion creates another exact match. Both occurrences remain.'],
])}
<p>Full original/normalized and staff/grade duplicate groups, with every source line, are in duplicates.csv and validation.json.</p>
<h2>7. Rerun identity and approval checkpoint</h2>
<p>Use Department/year as survey identity. Each row occurrence needs a separate durable identity based on
${code('[tenant, row object, source SHA-256, physical source line]')}; the proposed hashes are listed per occurrence.
A future implementation must atomically bind each identity to exactly one row and verify its values and parent edges on rerun.
Value-only matching is insufficient: it would collapse identical source occurrences. Existing overlaps without provenance remain blockers.
A changed/reordered CSV must undergo cross-file reconciliation rather than receive fresh identities blindly.</p>
<ol>${missingOptions.length ? '<li>Resolve the unsupported labels listed above without guessing alternatives.</li>' : ''}
<li>Agree how a separately implemented importer will validate and preserve canonical option values containing trailing spaces.</li>
<li>Explicitly confirm whether to retain all 1,242 occurrences, including 132 repeated occurrences after normalization. Retain-all is the provisional plan only.</li>
<li>Approve the final mapping and per-Department plan in a separate import task, then repeat live read-only validation before any write.</li></ol>
<p><strong>This task grants validation permission only. It does not authorize a subsequent import or metadata repair.</strong></p>
<h2>8. Complete read evidence and limitations</h2>
${table(['Collection / scope', 'Exact count', 'Rows read', 'Pages', 'Complete'], state.ledger.map(l =>
  [escape(l.label), l.count, l.rowsRead, l.requests, String(l.complete)]))}
<p>In each pass, all ${liveCount('custom_object_relationship')} BNMS relationship edges were read across ${edgePages} ordered pages (including archived edges);
all ${liveCount('custom_object_record')} relevant object records (Departments plus workforce), all ${liveCount('preference_field')} relevant fields, all ${liveCount('custom_object_definition')} tenant objects and all ${liveCount('custom_object_relationship_definition')} tenant relationship definitions were read.
All 136 source UUIDs were also checked without a tenant filter using ID-only metadata to detect foreign/missing IDs.
The ${evidence.existingWorkforceRecords.length} existing workforce records had incident-edge reads without a tenant filter to detect foreign edges.
Unrelated tenant data is excluded from the report. Department relationships to core Organisations/Groups are outside this workforce-link audit; no writes to those records are proposed.
No write/RPC permissions, execution behavior, or future uniqueness enforcement has been tested through live writes.</p>
<h2>9. Per-Department plan</h2><p>Every survey and row action is conditional on resolving blockers and separate approval. “Mapping blocked” includes canonical whitespace compatibility.</p>
${table(['Department / UUID', 'Occurrences', 'Occupied WTE', 'Survey create/reuse/conflict', 'Rows create / reuse / conflict', 'Mapping blocked'], audit.groups.map(g =>
  [`${escape(g.departmentName)}<br>${code(g.departmentId)}`, g.sourceRows, money(g.occupiedWte), escape(g.surveyAction),
    `${g.rowsCreate} / ${g.rowsReuse} / ${g.rowsConflict}`, g.rowsMappingBlocked]))}
<p class="footer">End of read-only report. Zero database writes occurred. No apply was executed.</p>`;
  fs.writeFileSync(path.join(outDir, 'report.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>BNMS Workforce — read-only validation</title><style>
body{font:15px/1.55 system-ui,sans-serif;color:#182333;background:#f5f7fa;margin:0}main{max-width:1160px;margin:32px auto;padding:40px;background:white}h1{font-size:34px;margin:0}h2{border-top:1px solid #d8e0ea;padding-top:24px;margin-top:36px}h3{margin-top:24px}.subtitle{color:#526276}.notice{border-left:5px solid #a34419;background:#fff3e8;padding:18px;margin:24px 0}table{border-collapse:collapse;width:100%;font-size:13px}td,th{padding:10px;border:1px solid #d8e0ea;text-align:left;vertical-align:top}th{background:#edf2f7}tr:nth-child(even){background:#fafbfd}code{font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere}details{margin:18px 0;padding:12px;border:1px solid #d8e0ea}summary{cursor:pointer;font-weight:600}.scroll{overflow-x:auto}.footer{border-top:2px solid #182333;padding-top:20px;font-weight:bold}@media(max-width:700px){main{margin:0;padding:20px}}@media print{main{margin:0;padding:0}body{background:white}h2{break-after:avoid}tr{break-inside:avoid}}
</style></head><body><main>${details}</main></body></html>`);
  return report;
}