const escape = value => String(value).replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

export function renderReview(manifest, review) {
  const table = (headers, rows) => `<div class="scroll"><table><thead><tr>${headers.map(h => `<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(v => `<td>${escape(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  const mapping = [
    ['Department_UUID', 'Existing Department; Survey → Department only'],
    ['Reporting_Year', 'Survey.survey_name and Row.row_name = 2025/26'],
    ['Staff_Group / Grade', 'Uniquely resolve against approved metadata; store exact canonical value'],
    ['Occupied_Nuclear_Medicine_WTE', 'Row.occupied_wte; preserve all occurrences and zero values'],
    ['Legacy_Vacancy_Reported', 'Only the original 53 blanks → No; No 1,141 / Yes 101'],
    ['No source column', 'vacant_wte omitted, not zero or null'],
  ];
  const whitespace = [
    ['staff_group', '"Clinical Practitioner – Technologist "', 303],
    ['staff_group', '"Clinical Practitioner – Radiographer "', 289],
    ['staff_group', '"Assistant Practitioner "', 24],
    ['grade', '"Fellow "', 4],
  ];
  const departments = manifest.surveys.map(s => {
    const rows = manifest.rows.filter(r => r.departmentId === s.departmentId);
    const hundredths = rows.reduce((n, r) => n + Math.round(r.data.occupied_wte * 100), 0);
    return [s.departmentId, '1 new survey', rows.length, (hundredths / 100).toFixed(2), rows.length + 1];
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BNMS workforce import — preparation review</title>
<style>body{margin:0;background:#f3f5f8;color:#172738;font:15px/1.6 system-ui,sans-serif}main{max-width:1100px;margin:30px auto;background:white;padding:40px}h1{font-size:32px;line-height:1.2}h2{font-size:22px;border-top:1px solid #dce3eb;padding-top:24px;margin-top:34px}.notice{padding:20px;background:#fff3dd;border-left:5px solid #a66d00}.muted{color:#526273}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:24px 0}.stat{background:#edf3f8;padding:18px}.stat strong{display:block;font-size:27px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #dce3eb;text-align:left;padding:10px;vertical-align:top}th{background:#edf3f8}code{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}.scroll{overflow:auto}li{margin:8px 0}@media(max-width:700px){main{padding:20px;margin:0}.stats{grid-template-columns:1fr 1fr}}@media print{main{padding:0;margin:0}tr{break-inside:avoid}}</style></head>
<body><main><p class="muted">BNMS · Reporting year 2025/26 · Preparation review</p><h1>Workforce import prepared.<br>Live import not authorized.</h1>
<div class="notice"><strong>Your mapping and duplicate choices are approved.</strong> The separate importer is staged for review. No SQL was executed, no migration installed, and no records or metadata changed. A separately explicit final approval is required before installation, import, or database test writes.</div>
<div class="stats"><div class="stat"><strong>136</strong>new surveys</div><div class="stat"><strong>1,242</strong>retained occurrences</div><div class="stat"><strong>1,708.14</strong>occupied WTE</div><div class="stat"><strong>1,378</strong>new relationship edges</div></div>
<h2>1. Refreshed destination audit</h2><p>Destination <code>lvmzliemqnieeoruhkik</code> was checked with authorized GET requests only. Two complete reads matched at <strong>${escape(review.observation.observedAt)}</strong>. All 136 Departments are active and tenant-valid. No source overlap was found.</p>
<p>The original 3 surveys, 8 rows, and 11 edges remain unchanged. Fingerprint: <code>${escape(review.observation.fingerprint)}</code>.</p>
<h2>2. Approved mapping and duplicate treatment</h2>${table(['Source', 'Approved destination treatment'], mapping)}
<p>Keep all 1,242 source occurrences, including the 132 occurrences beyond the first in 84 normalized duplicate groups (216 rows in those groups). No deduplication or aggregation. Band 8d is included in the approved live metadata.</p>
<h2>3. Exact canonical dropdown handling</h2><p>The SQL importer validates each value against the approved live dropdown options using exact equality, then inserts the canonical string unchanged. It does not call or alter the standard trimming validator. All normal database record and relationship triggers remain enabled.</p>
${table(['Field', 'Canonical value (quotes expose trailing space)', 'Occurrences'], whitespace)}
<p>These values affect 620 occurrences. No metadata repair, option renaming, or historical data rewrite is proposed.</p>
<h2>4. Atomic import and safe reruns</h2><ul>
<li>Three dedicated import ledger tables record the approved manifest, survey identities, and row occurrences. They are not ordinary user-visible field values.</li>
<li>Each row binds tenant + row object + exact source SHA-256 + physical CSV line to one record and one parent edge. Identical values on different source lines stay separate.</li>
<li>All records, edges, and ledger entries commit in one transaction or roll back together. Existing records are never merged, repaired, overwritten, archived, or deleted.</li>
<li>A rerun verifies every stored value, record identity, parent survey, Department link, and edge. Missing, archived, changed, extra, or ambiguous data stops the entire operation.</li>
<li>A changed or reordered file cannot be treated as a fresh import. It requires a separate cross-file reconciliation and reviewed implementation.</li>
<li>The prior sample is checked before and after insertion. The expected workforce totals become 139 surveys and 1,250 rows, with 1,389 workforce edges including the sample.</li></ul>
<h2>5. Operational impact and approval boundary</h2><p><strong>The proposed transaction takes table-level write locks</strong> on Custom Object records, relationships, definitions, and preference fields. Other tenants' writes to those tables may wait; ordinary reads can continue. Use a quiet maintenance window. The scripts set a 10-second lock timeout and a 120-second statement timeout; actual database performance has not been measured.</p>
<p>Both installation and invocation require an explicit approval session setting. That setting is a safety interlock—not evidence of human approval. Do not set it or execute either script until final approval is recorded. The offline preparation command has no apply mode and refuses existing output directories.</p>
<h2>6. Review package and test limits</h2><p>The package contains <code>manifest.json</code>, <code>review.json</code>, <code>install.review-only.sql</code>, and <code>invoke.review-only.sql</code>. SQL is intentionally outside automatic migration folders.</p>
<p>Offline tests cover source totals, canonical values, duplicate identities, overlap rejection, and simulated rerun failures. SQL safeguards are checked by source inspection. <strong>SQL syntax, real trigger behavior, permissions, locking, and transactional rollback have not been tested in a database</strong>, because database execution is not authorized.</p>
${table(['Reviewed artifact', 'SHA-256'], [['Original CSV', manifest.sourceSha256], ['Manifest', review.manifestSha256], ['Installation SQL', review.installSqlSha256], ['Invocation SQL', review.invokeSqlSha256]])}
<p>Before execution: review this package and code; obtain explicit final approval covering installation and import; independently verify the destination; repeat the GET audit; verify package hashes; install and invoke only under the approved scope. Then verify committed counts and exact values, and prove an unchanged-file rerun creates nothing. Any metadata, source, or baseline drift stops execution and requires review.</p>
<h2>7. Per-Department plan</h2><p>Department UUIDs are match-only. Each occurrence belongs to its Department through its new survey.</p>
${table(['Existing Department UUID', 'Survey', 'Rows', 'Occupied WTE', 'Edges'], departments)}
</main></body></html>`;
}