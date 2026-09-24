// Local evidence analysis only. No network, financial mutation or guessed contact binding.
import {readFile,writeFile} from 'node:fs/promises';
import {hash} from './bnms-dd-beta-invoices.mjs';
import {matchingStructures} from './bnms-dd-beta-review.mjs';
const dir='exports/private-bnms-manual-phase2';
const load=async path=>JSON.parse(await readFile(path,'utf8'));
const {snapshot:s}=await load(`${dir}/destination.json`);
const provider=await load(`${dir}/gocardless.json`);
const sheet=await load('exports/private-bnms-manual-phase1/spreadsheet.json');
const {members:old}=await load('exports/private-bnms-manual-phase1/reconciliation.json');
const accounting=await load('exports/private-bnms-alpha-20260920-verified/accounting-evidence.json');
const norm=v=>String(v||'').trim().toLowerCase();
const members=old.filter(m=>!m.overlap.length).map(m=>{
 const member=s.members.find(v=>v.id===m.memberId);
 const customer=provider.discovery.customers.find(v=>m.customerIds.includes(v.id));
 const preferences=s.preferences.filter(v=>v.member_id===m.memberId);
 const configs=matchingStructures(s.structures,preferences.filter(v=>v.name==='member_class'),'2026-10-01');
 if(configs.length!==1||configs[0].currency!=='GBP'||configs[0].pricing_model!=='flat')throw Error('Current price scope unresolved');
 const emails=[norm(member.email),norm(customer.email)].filter(Boolean);
 const contacts=accounting.contacts.filter(c=>emails.includes(norm(c.EmailAddress)));
 const mandates=provider.discovery.mandates.filter(v=>v.links?.customer===customer.id&&v.status==='active');
 if(mandates.length!==1)throw Error('Current mandate ambiguous');
 return {memberId:member.id,customerId:customer.id,mandateId:mandates[0].id,sourceRows:m.sourceRows,
   structure:configs[0],monthlyAmountMinor:Math.round(Number(configs[0].dd_monthly_amount)*100),
   cachedCandidateContacts:contacts,contactBindingVerified:false};
});
if(members.length!==95)throw Error('Exact separate 95-person scope required');
const total=members.reduce((sum,m)=>sum+m.monthlyAmountMinor,0);
const report={mode:'blocked_accounting_architecture_review',sheetSha256:sheet.sha256,
 observedAt:provider.observedAt,completedAt:provider.completedAt,
 memberCount:95,existingAlphaNoOps:10,monthlyTotalMinor:total,
 retired:{count:members.filter(m=>m.structure.structure_match_value==='Retired').length,monthlyAmountMinor:392},
 authority:{source:'explicit_user_operator_attestation',existingMandateMigration:true,acceptedAt:null,
   legacyCollectionsDisabled:true,currentMembershipRecognized:true},
 accounting:{provider:s.accountingProvider,settings:s.accountingSettings,
   cachedUniqueEmailCandidates:members.filter(m=>m.cachedCandidateContacts.length===1).length,
   cachedNoEmailCandidate:members.filter(m=>m.cachedCandidateContacts.length===0).length,
   bindingTables:s.contactSchema.filter(v=>v.column_name==='xero_contact_id').map(v=>v.table_name),
   blockers:['Native Xero contact path searches by name and can create/update contacts; not an exact verified ownership binding.',
     'Dedicated GoCardless bank code is absent. Existing approved code-less bank AccountID is accessible only through exact pilot/beta/alpha contexts.',
     'Exact-contact and permanent invoice claim/link safety is Alpha-specific, not provided by native generic accounting.']},
 members};
const evidenceSha256=hash(report);
await writeFile(`${dir}/accounting-review.json`,JSON.stringify({evidenceSha256,report},null,2),{mode:0o600,flag:'wx'});
console.log(JSON.stringify({mode:report.mode,evidenceSha256,members:95,monthlyTotalMinor:total,retired:report.retired,
 cachedUniqueEmailCandidates:report.accounting.cachedUniqueEmailCandidates,cachedNoEmailCandidate:report.accounting.cachedNoEmailCandidate,
 liveWrites:0,xeroRequests:0,releaseAuthorizedByThisArtifact:false}));