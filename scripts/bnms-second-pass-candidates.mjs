import fs from 'node:fs';
const dir='generated-artifacts/bnms-expiry-only-audit';
const review=JSON.parse(fs.readFileSync(`${dir}/live-review.json`));
const completed=JSON.parse(fs.readFileSync(`${dir}/reconstruction-apply.json`)).receipts;
const ignoredIssues=new Set(['Invoice date does not corroborate retained annual term','Annual duration requires confirmation']);
export const held=[];
export const candidates=[];
for(const r of review.reports){
  if(completed.some(c=>c.memberId===r.memberId))continue;
  // A different invoice date is normal; an invoice for a different annual
  // cycle is not automatically evidence of this term.
  const windowStart=Date.parse(r.proposedStart)-120*86400000;
  const relevant=r.evidence.filter(i=>i.date&&Date.parse(i.date)>=windowStart&&i.date<=r.expiry);
  const usable=relevant.filter(i=>i.issues.every(issue=>ignoredIssues.has(issue))
    && !/event|congress|conference|attending|incl(?:uding|\.)|ticket|bundle/i.test(i.membershipLine?.description||'')
    && i.membershipLine?.tax===0
    && /membership/i.test(i.membershipLine?.description||''));
  if(usable.length!==1||relevant.length!==1||!r.schedule){
    held.push({name:r.name,memberId:r.memberId,reason:!r.schedule?'Schedule unresolved':
      relevant.length>1?'Multiple invoices in the potential coverage period':
      !relevant.length?'No linked invoice near the current annual period':'Identity, settlement or membership allocation needs review'});
    continue;
  }
  const chosen=usable[0];
  const desc=chosen.membershipLine.description.toLowerCase();
  const cls=r.memberClass.toLowerCase();
  const category=cls.includes('trainee')?'trainee':cls.includes('junior')?'junior':cls.includes('associate')?'associate':cls.includes('full')?'full':null;
  if(!category||!desc.includes(category)){held.push({name:r.name,memberId:r.memberId,reason:'Invoice membership type differs from current class'});continue;}
  candidates.push({memberId:r.memberId,name:r.name,invoice:chosen.number,start:r.proposedStart,end:r.expiry,
    schedule:r.schedule,membershipLine:chosen.membershipLine});
}
