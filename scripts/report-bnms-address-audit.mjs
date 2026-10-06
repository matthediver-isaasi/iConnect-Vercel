import fs from 'node:fs';
import crypto from 'node:crypto';
import { keys, mapAddress } from './bnms-address-mapping.mjs';
const dir = 'private/bnms-address-audit';
const raw = fs.readFileSync(`${dir}/snapshot.json`);
const s = JSON.parse(raw);
const fields = keys.map(name => ({ name, matches: s.fields.filter(f => f.name === name) }));
const unresolved = fields.filter(f => f.matches.length !== 1 || !f.matches[0].is_active || f.matches[0].field_type !== (f.name === 'org_country' ? 'country' : 'text'));
const rows = s.organizations.map(o => {
  const existingRows = Object.fromEntries(fields.map(f => [f.name, s.values.filter(v => v.organization_id === o.id && f.matches.some(m => m.id === v.field_id))]));
  const existing = Object.fromEntries(keys.map(k => [k, existingRows[k][0]?.value ?? null]));
  const mapping = mapAddress(o.invoicing_address, existing, fields.find(f => f.name === 'org_country').matches[0]);
  const duplicates = keys.filter(k => existingRows[k].length > 1);
  if (duplicates.length) { mapping.reasons.push(`Duplicate destination value rows: ${duplicates.join(', ')}`); mapping.ambiguous = true; }
  const status = mapping.missing ? 'missing source' : unresolved.length ? 'unresolved definitions' : mapping.conflicts.length ? 'existing-value conflict' : mapping.ambiguous ? 'ambiguous address' : 'clear mapping';
  return { id: o.id, name: o.name, source: o.invoicing_address, existingRows, existing, ...mapping, status,
    candidateFills: status === 'clear mapping' ? keys.filter(k => mapping.proposed[k] !== null && !String(existing[k] ?? '').trim()) : [] };
});
const summary = {
  capturedAt: s.metadata.captured_at, snapshotSha256: crypto.createHash('sha256').update(raw).digest('hex'),
  organizations: rows.length, withSource: rows.filter(r => !r.missing).length, withoutSource: rows.filter(r => r.missing).length,
  categories: Object.fromEntries(['clear mapping', 'ambiguous address', 'existing-value conflict', 'missing source', 'unresolved definitions'].map(k => [k, rows.filter(r => r.status === k).length])),
  overlappingAmbiguous: rows.filter(r => r.ambiguous).length, overlappingConflicts: rows.filter(r => r.conflicts.length).length,
  unresolvedDefinitions: unresolved.length, candidateOrganizations: rows.filter(r => r.candidateFills.length).length,
  candidateFieldFills: rows.reduce((n,r) => n + r.candidateFills.length, 0),
  fields: fields.map(f => ({ ...f, existingNonempty: rows.filter(r => String(r.existing[f.name] ?? '').trim()).length })),
  duplicateValuePairs: rows.reduce((n,r) => n + keys.filter(k => r.existingRows[k].length > 1).length, 0),
  coverage: 'Every nonempty delimited source component is assigned exactly once or explicitly retained as unassigned. Original strings retained verbatim.',
  database: 'Pinned current DEST only; REPEATABLE READ READ ONLY snapshot rolled back; no data or schema writes.',
  migrations: 'None needed: all seven exact custom definitions exist; values use existing text storage. None applied.',
};
const report = { summary, columns: s.columns.filter(c => (c.table_name === 'organization' && c.column_name === 'invoicing_address') || (c.table_name === 'organization_preference_value' && c.column_name === 'value')), rows };
fs.writeFileSync(`${dir}/review.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Private BNMS address mapping review</title><style>body{font:15px system-ui;margin:32px;color:#182330}table{border-collapse:collapse;width:100%;margin:16px 0}td,th{border:1px solid #ccd3dc;padding:8px;text-align:left;vertical-align:top}pre{white-space:pre-wrap}summary{cursor:pointer;padding:12px;background:#edf1f5}details{margin:12px 0}small{color:#526070}</style><h1>Private BNMS address mapping review</h1><p>Read-only proposal — approval required. No confidence score is used. Clear means supported component placement, not verified postal accuracy or proof that the invoicing address is the organisation’s physical address. Existing values are never overwritten. Null proposals mean no source-backed value, not deletion.</p><p>Country names follow the organisation editor and shared country list. Countries are only proposed when explicitly present. Existing country may select a postal pattern but is never copied into a missing source component. Commas, semicolons and line breaks are delimiters; compound locality names, uncertain boundaries and overflow require review. Whitespace trimming and country canonicalisation are disclosed in the component ledger. County labels are source classifications, not enrichment.</p><pre>${esc(JSON.stringify(summary, null, 2))}</pre><h2>All organisations (${rows.length})</h2>${rows.map(r => `<details><summary>${esc(r.status)} — ${esc(r.name)} <small>${esc(r.id)}</small></summary><h3>Original invoicing address</h3><pre>${esc(r.source ?? '(null)')}</pre><table><tr><th>Destination</th><th>Existing value</th><th>Proposed value</th><th>Review</th></tr>${keys.map(k => `<tr><td>${k}</td><td><pre>${esc(r.existing[k] ?? '(not stored)')}</pre></td><td><pre>${esc(r.proposed[k] ?? '(no proposal)')}</pre></td><td>${r.conflicts.includes(k) ? 'CONFLICT — retain existing' : r.candidateFills.includes(k) ? 'Candidate blank-only fill after approval' : 'No automatic change'}</td></tr>`).join('')}</table><p>${esc(r.reasons.join(' ') || 'All source components accounted for; no destination conflicts.')}</p><p>Unassigned: ${esc(JSON.stringify(r.unassigned))}</p><h3>Component evidence (preserves source order by original address)</h3><pre>${esc(JSON.stringify(r.ledger, null, 2))}</pre><h3>Stored value row evidence</h3><pre>${esc(JSON.stringify(r.existingRows, null, 2))}</pre></details>`).join('')}</html>`;
fs.writeFileSync(`${dir}/review.html`, html, { mode: 0o600 });
console.log(JSON.stringify({ ...summary, fields: summary.fields.map(f => ({ name: f.name, existingNonempty: f.existingNonempty })) }, null, 2));
