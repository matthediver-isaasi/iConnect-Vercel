// Deliberately scoped to the observed no-candidate snapshot. Changed evidence
// fails closed and requires fresh analysis, not a guessed policy duration.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const dir = 'generated-artifacts/bnms-cpd-guest-grace';
const raw = fs.readFileSync(`${dir}/evidence.json`);
const e = JSON.parse(raw);
assert.equal(e.read_only, 'on');
assert.equal(e.writes, 0);
assert.equal(e.count, e.members.length);
assert.equal(new Set(e.members.map(m => m.id)).size, e.count);
const former = e.roles.find(r => r.name === 'Former');
const guest = e.roles.find(r => r.name === 'CPD Guest');
assert.ok(former && guest);
const histories = e.tables.member_membership_history;
assert.equal(histories.length, 1, 'Changed history evidence requires fresh review');
const h = histories[0];
assert.equal(h.billing_period, 'monthly_card');
assert.ok(h.term_start_date <= e.today && h.term_end_date > e.today);
assert.equal(e.tables.membership_expiry_policy_assignment.length, 0);
assert.equal(e.tables.organisation_membership_history.length, 0);
for (const [table, rows] of Object.entries(e.tables)) {
  assert.ok(rows.every(r => r.tenant_id === e.tenant.id));
  if (table.includes('amendment')) assert.equal(rows.length, 0);
}
const expiryValues = e.preferences.filter(p => p.name === 'ym_date_membership_expires' && p.value);
assert.equal(expiryValues.length, 1);
assert.equal(expiryValues[0].value, '04/12/2026');
const rows = e.members.map(m => {
  assert.equal(m.tenant_id, e.tenant.id);
  assert.equal(m.role_id, guest.id);
  const prefs = e.preferences.filter(p => p.member_id === m.id);
  const legacy = prefs.find(p => p.name === 'ym_date_membership_expires')?.value || '';
  const recurring = m.id === h.member_id;
  const reason = recurring
    ? 'Future-dated monthly-card term; active history, partial payment, cancelled billing agreement. Not an expired annual-renewal grace case. Current entitlement is not asserted.'
    : legacy
      ? 'Legacy expiry only: 04/12/2026 (4 December under DD/MM/YYYY display). No membership history or applied renewal policy. Source-format authority must be confirmed before relying on the date.'
      : 'No membership history, recorded legacy expiry, or assigned renewal-grace policy. CPD Guest alone is not evidence of a former paid membership.';
  return {
    member_id: m.id, name: `${m.first_name || ''} ${m.last_name || ''}`.trim() || 'Unnamed member',
    current_role: guest.name, current_role_id: guest.id,
    category: recurring ? 'Excluded: future-dated recurring term' : 'Review: unknown expiry or policy',
    membership_expiry: recurring ? h.term_end_date : legacy ? 'Unverified legacy value: ' + legacy : 'Unknown',
    grace_end: recurring ? 'Not applicable to annual-renewal audit' : 'Unknown',
    policy_evidence: reason, history_id: recurring ? h.id : '',
    legacy_member_class: prefs.find(p => p.name === 'member_class')?.value || '',
    legacy_membership_status: prefs.find(p => p.name === 'membership_status')?.value || '',
    proposed_role: 'No change', target_if_separately_approved: `${former.name} (${former.id})`,
  };
}).sort((a,b) => a.name.localeCompare(b.name) || a.member_id.localeCompare(b.member_id));
const counts = { cohort: rows.length, candidates: 0, exceptions: rows.filter(r => r.category.startsWith('Review')).length,
  excludedFutureRecurring: rows.filter(r => r.category.startsWith('Excluded')).length,
  noHistoryOrExpiry: rows.filter(r => r.membership_expiry === 'Unknown').length, legacyExpiryOnly: expiryValues.length };
assert.equal(counts.cohort, counts.candidates + counts.exceptions + counts.excludedFutureRecurring);
const summary = {
  auditTimestamp: e.timestamp, boundary: e.today, counts, tenant: e.tenant,
  project: e.project, roles: { guest: { id: guest.id, name: guest.name }, former: { id: former.id, name: former.name } },
  evidenceSha256: crypto.createHash('sha256').update(raw).digest('hex'), writes: 0,
};
fs.writeFileSync(`${dir}/summary.json`, JSON.stringify(summary, null, 2), { mode: 0o600 });
const csv = v => `"${String(v ?? '').replaceAll('"', '""')}"`;
const columns = Object.keys(rows[0]);
fs.writeFileSync(`${dir}/member-review.csv`, [columns.map(csv).join(','), ...rows.map(r => columns.map(k => csv(r[k])).join(','))].join('\r\n'), { mode: 0o600 });
const esc = v => String(v ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const text = `Audit at ${e.timestamp}. UTC date boundary ${e.today}. Grace is inclusive: a candidate must have a verified grace-end date strictly before ${e.today}; grace ending today is not expired. Fixed annual and reviewed historical terms use expiry plus assigned grace days; rolling upfront terms use the next-start anchor. No present-day matching tier, payment-arrears grace or arbitrary duration was substituted.`;
const table = list => `<table><thead><tr>${['Name / member ID','Current role','Membership expiry','Grace end','Policy evidence / reason','Proposed action'].map(x=>`<th>${x}</th>`).join('')}</tr></thead><tbody>${list.map(r=>`<tr><td>${esc(r.name)}<small>${r.member_id}</small></td><td>CPD Guest</td><td>${esc(r.membership_expiry)}</td><td>${esc(r.grace_end)}</td><td>${esc(r.policy_evidence)}${r.history_id ? `<small>History: ${r.history_id}</small>` : ''}${r.legacy_member_class === 'Former' ? '<small>Legacy member class says Former; this is not RBAC or expiry-policy authority.</small>' : ''}</td><td>No change</td></tr>`).join('')}</tbody></table>`;
fs.writeFileSync(`${dir}/report.html`, `<!doctype html><html lang="en"><meta charset="utf-8"><title>BNMS CPD Guest grace audit</title><style>body{font:15px system-ui;margin:32px;color:#172334}h1,h2{color:#133d64}p{max-width:1100px;line-height:1.6}table{border-collapse:collapse;width:100%;font-size:13px}td,th{padding:12px;text-align:left;border:1px solid #ccd5df;vertical-align:top}th{background:#eaf0f5}small{display:block;margin-top:6px;overflow-wrap:anywhere;color:#56616d}.notice{padding:20px;background:#edf6ef}input{padding:10px;width:450px;max-width:90%}</style><h1>BNMS CPD Guest → Former: read-only audit</h1><p class="notice"><b>0 supported role-change candidates. No roles or other records changed.</b><br>${counts.cohort} members examined; ${counts.exceptions} evidence exceptions; ${counts.excludedFutureRecurring} future-dated recurring term excluded. Any later correction needs separate explicit owner approval and fresh evidence.</p><p>${esc(text)}</p><h2>Verified destination and roles</h2><p>Production DEST: ${e.project}. Tenant: BNMS / bnms (${e.tenant.id}).<br>CPD Guest: ${guest.id}<br>Former: ${former.id}</p><h2>Completeness and interpretation</h2><p>Single PostgreSQL REPEATABLE READ, READ ONLY snapshot, followed by ROLLBACK. No pagination or LIMIT; independent cohort count equals unique returned members. All ${e.count} members have direct BNMS tenancy and the exact role ID; inherited-tenant lookup added none. Complete scoped histories, organisation histories, billing agreements, policy assignments and amendment tables were read. Relevant tenant preference definitions were discovered and their values read only for this cohort. One personal history, one cancelled billing agreement, zero organisation histories, zero expiry-only assignments and zero amendments were found. ${counts.noHistoryOrExpiry} members have neither a recorded membership history nor a legacy expiry. One additional member has only a legacy expiry. Legacy member class/status do not establish paid entitlement or grace. Snapshot fingerprint: ${summary.evidenceSha256}.</p><p>Sources reviewed: membershipPaymentReportGrace.js, annualRenewalPolicy.js, reviewedHistoricalRenewal.js, expiryOnlyRenewalPolicy.js, canvasRenewalEligibility.js and membershipPaymentReport.js. No eligible historical policy exists in this cohort to evaluate. The future monthly-card term is excluded conservatively; its partial payment and cancelled agreement do not prove current access.</p><h2>Proposed CPD Guest → Former changes (0)</h2><p>No supported candidates. The exact Former role above is the requested target, not an authorized update.</p><h2>Excluded future-dated recurring membership (1)</h2>${table(rows.filter(r=>r.category.startsWith('Excluded')))}<h2>Unknown or conflicting evidence (${counts.exceptions})</h2><p>Every exception stays unchanged. Search by name or member ID:</p><input id="search" aria-label="Search review list" placeholder="Name or member ID"><section id="review">${table(rows.filter(r=>r.category.startsWith('Review')))}</section><script>document.getElementById('search').addEventListener('input',e=>{const q=e.target.value.toLowerCase();document.querySelectorAll('#review tbody tr').forEach(r=>r.hidden=!r.textContent.toLowerCase().includes(q))})</script></html>`, { mode: 0o600 });
console.log(JSON.stringify(summary, null, 2));
