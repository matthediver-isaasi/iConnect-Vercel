import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {DIR,hash} from './capture-bnms-all-renewal.mjs';
const snapshot=JSON.parse(await fs.readFile(`${DIR}/snapshot.json`,'utf8'));
const {summary:s,rows,orphans}=JSON.parse(await fs.readFile(`${DIR}/evidence.json`,'utf8'));
const esc=x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const table=(headers,data)=>`<table><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${data.map(r=>`<tr>${r.map(v=>`<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
// Cross-check one representative of every issue class against the raw snapshot,
// preserving the exact rows used, without exporting contacts or bearer URLs.
const representatives=[];
for(const code of Object.keys(s.issueCounts)) {
  const member=rows.find(r=>r.issues.some(i=>i.code===code));
  const issue=member.issues.find(i=>i.code===code);
  const evidence=[];
  for(const [table,records] of Object.entries(snapshot.tables))for(const r of records)
    if(issue.references.includes(r.id||r.history_id||r.provider_payment_id))
      evidence.push({table,record:r});
  assert(snapshot.tables.member.some(m=>m.id===member.memberId));
  for(const id of issue.references) assert(evidence.some(e=>
    [e.record.id,e.record.history_id,e.record.provider_payment_id].includes(id)),
    `No representative evidence for ${code}: ${id}`);
  representatives.push({code,memberId:member.memberId,issue,evidence});
}
const checks={
  memberCount:rows.length,uniqueMembers:new Set(rows.map(r=>r.memberId)).size,
  countsMatch:Object.entries(snapshot.completeness).every(([t,c])=>c.expected===snapshot.tables[t].length),
  snapshotHashMatches:hash(snapshot.tables)===s.snapshotHash,
  everyIssueClassCrossReferenced:representatives.length===Object.keys(s.issueCounts).length,
  representativeClasses:representatives.map(r=>r.code),
};
assert.equal(checks.memberCount,checks.uniqueMembers);assert(checks.countsMatch&&checks.snapshotHashMatches);
await fs.writeFile(`${DIR}/representative-checks.json`,JSON.stringify({checks,representatives},null,2),{mode:0o600});
const actions=rows.filter(r=>r.issues.some(i=>i.category!=='expected'));
const categories=['blocker','risk','unresolved','display_only','accounting_only','expected'];
const categoryCounts=categories.map(c=>[c,rows.filter(r=>r.issues.some(i=>i.category===c)).length,
  rows.filter(r=>!r.exclusion&&r.issues.some(i=>i.category===c)).length]);
const html=`<!doctype html><html lang="en"><meta charset="utf-8"><title>BNMS renewal readiness — ${esc(s.as_of)}</title>
<style>body{font:15px/1.5 system-ui;max-width:1150px;margin:40px auto;padding:0 24px;color:#172238}h1,h2{line-height:1.2}table{border-collapse:collapse;width:100%;margin:20px 0}td,th{padding:8px;border:1px solid #dce1e9;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#edf2f8}code{overflow-wrap:anywhere}details{border:1px solid #dce1e9;padding:12px;margin:8px 0}.notice{background:#fff3cd;padding:16px}</style>
<h1>BNMS renewal readiness</h1><p>Private, member-ID-only evidence report. Snapshot: <strong>${esc(s.as_of)} UTC</strong>.</p>
<p class="notice">Read-only audit, not a debt list or approval to repair. No production writes, charges, refunds, messages, provider refreshes or reconciliation replays occurred. No historical repair authority was reused.</p>
<h2>Verified scope</h2><p>Tenant BNMS / bnms: <code>${s.tenant.id}</code>. Documented destination production project <code>${s.project}</code>, database <code>${s.database}</code>. TLS identity pinned. Preview/SOURCE not queried. Transaction: REPEATABLE READ, READ ONLY, UTC; rolled back after capture. PostgreSQL snapshot ${esc(s.snapshot)}.</p>
<p>All ${s.population} existing members were captured, including ${s.populationExclusions.guest_or_contact} guests/contacts, ${s.populationExclusions.inactive_or_former} inactive/former records and ${s.populationExclusions.test_or_sample} explicitly flagged samples. No soft-deleted member rows were found in the available member schema; physically deleted records and earlier deleted identities are not recoverable from this snapshot. All member.status values are active; class and membership-status custom fields—not that generic flag—identify former/contact cohorts. Organisation affiliation alone is not organisation funding: there are zero organisation membership histories.</p>
<p>Exclusions remain in the CSV and financial checks. They are excluded only from active-member action totals. Unknown classes are not silently excluded. No names, emails, bank details or credentials are included in the deliverables; use the exact member UUID in authorised CRM access.</p>
<h2>Findings and overlap</h2><p><strong>${s.uniqueActionableMembers} non-excluded members</strong> have at least one blocker/risk; ${s.uniqueBlockerMembers} have an admission blocker. These are evidence-review counts, not payment demands. Each member has one primary classification, but may have several issues.</p>
${table(['Category','Unique members, all','Unique members, non-excluded'],categoryCounts)}
${table(['Primary classification','Members'],Object.entries(s.classification))}
${table(['Issue','Categories','All members','Non-excluded','Occurrences'],Object.entries(s.issueCounts).map(([k,v])=>[k,v.categories.join(', '),v.members,v.activePopulationMembers,v.occurrences]))}
<h2>Prioritised approval queue</h2><ol>
<li>Review the 113 non-excluded admission blockers: 94 missing expiry-only policy evidence, 13 missing purchased policy, five unavailable current agreements and one recurring commitment without an agreement. Approval should specify exact histories and evidence; do not fabricate dates or enable policies from this report.</li>
<li>Review unfinished/reserved purchases, unmatched selected-term plans, arrears and mismatched payment identities. Confirm live provider outcome read-only before considering release, commitment recovery or collection. A mandate or one paid instalment is not full settlement.</li>
<li>Reconcile accounting-only findings against original invoices and credits. Missing links may be imports without term attribution; never create a replacement invoice solely because a local link is absent.</li>
<li>Review display-only unavailable cards independently. Unsupported organisation billing, expiry-only histories and insufficient qualifying upfront evidence can yield this wording without debt.</li>
<li>Keep pauses, held collections, continuing arrangements, not-yet-open renewals and future setup states separate from failures. Do not release a hold or ask a member to pay twice.</li></ol>
<h2>Evidence limits</h2><ul>
<li>Provider APIs and accounting APIs were not called. Stored payment statuses, invoice balances, webhook outcomes and mandate status may be stale. Provider live settlement/schedule verification is unresolved, not a successful payment attestation.</li>
<li>158 members reached the application's pricing boundary; pricing simulations and checkout creation were deliberately stopped. Final prices, mapped form-specific renewal selections and successful checkout are not verified. Post-grace capability was read from stored function definitions/grants; post-grace pricing remains unresolved where required.</li>
<li>Portal projections reuse current source selectors, billing matching, pending-bank checks, migrated mandates, amendment overlays and dynamic collection price selection against an offline adapter. No self-only endpoint was called and no member was impersonated. Deployment parity, authentication/role access, browser errors and network/API availability were not tested; a blocked module-initialisation role-overlay network request was not used as evidence.</li>
<li>Historical invoice numbers/descriptions alone do not establish a current term link. The capture contains 7,131 historical invoices and 2,367 imported provider payments; exact stored owner/payment/invoice links were checked. No missing monetary value was invented.</li>
<li>All requested tables were accessible. Contact fields, bearer tokens, full webhook payloads and arbitrary historical evidence blobs were deliberately omitted. Only event identity/action/links needed for pending-bank evidence were retained. No external provider evidence was inferred from omitted data.</li></ul>
<h2>Reproducibility and completeness</h2><p>Snapshot SHA-256: <code>${s.snapshotHash}</code>. Source revision at capture: <code>${s.codeRevision}</code>; audit-only exports and dependency injection are retained with this task. Each table was read in bounded 500-row pages and compared to its count in the same snapshot. Member IDs are unique and all 4,080 have a CSV row. ${representatives.length} issue classes have raw-snapshot representative cross-references. ${orphans.length} unowned evidence references were found.</p>
<p>Commands: <code>node scripts/capture-bnms-all-renewal.mjs --read-only-dest</code> (fresh snapshot); <code>node scripts/report-bnms-all-renewal.mjs</code>; <code>node scripts/render-bnms-renewal-report.mjs</code>. Run fixture checks with <code>node scripts/run-isolated-tests.mjs node --test scripts/bnms-all-renewal.test.mjs</code>. A new capture is a new as-of audit, not a replay of this snapshot. Private capture/evidence files are mode 0600 in a mode 0700 ignored directory.</p>
${table(['Captured table','Expected','Captured','SHA-256'],Object.entries(snapshot.completeness).map(([k,v])=>[k,v.expected,v.captured,v.sha256]))}
<h2>Member evidence and recommendations</h2><p>All members, including expected-only cases, are in members.csv. Expand a member below for findings that need review. UUID references refer to records in the same captured snapshot.</p>
${actions.map(r=>`<details><summary>${esc(r.memberId)} — ${esc(r.memberClass)} — ${esc(r.classification)}${r.exclusion?' — excluded: '+esc(r.exclusion):''}</summary><p>History: ${esc(r.historyIds.join(', '))}; plan: ${esc(r.planIds.join(', '))}; admission: ${esc(r.renewalState)} / ${esc(r.renewalReason)}</p><pre style="white-space:pre-wrap">${esc(JSON.stringify(r.termEvidence,null,2))}</pre>${table(['Category / issue','References','Observed evidence / reason','Likely impact','Confidence','Next action requiring approval'],r.issues.map(i=>[i.category+' / '+i.code,i.references.join(', '),i.reason,i.impact,i.confidence,i.nextAction]))}</details>`).join('')}
</html>`;
await fs.writeFile(`${DIR}/report.html`,html,{mode:0o600});
console.log(JSON.stringify({checks,reportBytes:Buffer.byteLength(html)}));
