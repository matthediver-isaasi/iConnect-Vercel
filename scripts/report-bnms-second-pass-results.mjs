import fs from 'node:fs';
import {held} from './bnms-second-pass-candidates.mjs';
const dir='generated-artifacts/bnms-expiry-only-audit';
const first=JSON.parse(fs.readFileSync(`${dir}/reconstruction-apply.json`)).receipts;
const second=JSON.parse(fs.readFileSync(`${dir}/reconstruction-second-apply.json`)).receipts;
const provider=JSON.parse(fs.readFileSync(`${dir}/verified-second-provider-evidence.json`)).providerHolds;
const verification=JSON.parse(fs.readFileSync(`${dir}/second-renewal-verification.json`));
const initial=JSON.parse(fs.readFileSync(`${dir}/live-review.json`)).reports;
const rows=[['Member','Member ID','Result','Invoice','Membership start','Membership expiry',
  'Membership amount GBP','Renewal verification','Review reason']];
for(const r of initial){
  const repair=[...first,...second].find(v=>v.memberId===r.memberId);
  const checked=verification.find(v=>v.memberId===r.memberId);
  const hold=[...held,...provider].find(v=>v.memberId===r.memberId);
  if(!repair&&!hold)throw Error('Unaccounted member');
  let reason=hold?.reason||'';
  if(reason.includes('Payments HTTP 404'))reason='Xero invoice is paid, but its underlying payment record could not be retrieved. Left unchanged pending verification.';
  if(reason==='Identity, settlement or membership allocation needs review'){
    const issues=new Set(r.evidence.flatMap(i=>i.issues).filter(s=>![
      'Annual duration requires confirmation','Invoice date does not corroborate retained annual term'
    ].includes(s)));
    if(r.evidence.some(i=>/event|congress|conference|attending|incl(?:uding|\.)|ticket|bundle/i.test(i.membershipLine?.description||'')))
      issues.add('Event and membership combined on one line; membership-only amount unproven');
    reason=[...issues].join('; ')||reason;
  }
  rows.push([r.name,r.memberId,repair?'Reconstructed':'Unchanged - review required',
    repair?.invoice||r.evidence.map(i=>i.number).join('; '),repair?.start||'',r.expiry,
    repair?.amount??'',repair?(checked?checked.eligible&&checked.pricingSuccess?'Passed':'Needs review':'Passed in first batch'):'',
    reason]);
}
const quote=v=>`"${String(v??'').replaceAll('"','""')}"`;
fs.writeFileSync(`${dir}/BNMS-current-membership-repair-results.csv`,
  rows.map(row=>row.map(quote).join(',')).join('\r\n'),{mode:0o600});
console.log(JSON.stringify({cohort:initial.length,previouslyRepaired:first.length,newlyRepaired:second.length,
  totalRepaired:first.length+second.length,unchanged:initial.length-first.length-second.length,
  renewalPassed:verification.filter(v=>v.eligible&&v.pricingSuccess).length,
  held:[...held,...provider].map(v=>({name:v.name,reason:v.reason}))}));
