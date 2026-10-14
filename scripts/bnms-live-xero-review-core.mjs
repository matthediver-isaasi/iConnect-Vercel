import { addCalendarMonths } from '../shared/rollingMembershipTerm.js';
export function assessMember({review,live,provider,configs,classFieldId,today='2026-10-14'}){
  const holds=[];
  const invoice=provider.membershipInvoices.find(i=>i.InvoiceID===provider.latestPaidInvoiceId);
  const structures=configs.filter(c=>c.is_active&&c.structure_scope_type==='member'&&c.structure_field_id===classFieldId
    &&c.structure_match_value===review.memberClass&&c.effective_from<=today&&(!c.effective_to||c.effective_to>=today));
  const latest=provider.membershipInvoices.find(i=>i.InvoiceID===provider.latestInvoiceId);
  const itemisedLines=(invoice?.LineItems||[]).filter(l=>/\bmembership\b/i.test(l.Description||'')
    && !/\bevent|attend|conference|meeting|ticket|party|dinner|bootcamp|discount/i.test(l.Description||''));
  const membershipLine=itemisedLines.length===1?itemisedLines[0]:null;
  const separateLine=invoice?.LineItems?.length>1&&membershipLine?.Quantity===1
    &&membershipLine.LineAmount>0&&membershipLine.TaxAmount===0
    &&invoice.LineItems.every(l=>l.LineAmount>=0)
    &&membershipLine.LineAmount<=invoice.Total;
  const payments=provider.payments;
  const account=provider.contacts?.[0]?.AccountNumber?.trim();
  const identityVerified=provider.exact&&(!account
    ||account===review.liveSource.preferences.ym_web_site_member_id?.trim());
  const paid=!!invoice&&invoice.Type==='ACCREC'&&invoice.Status==='PAID'&&invoice.Total>0
    &&invoice.CurrencyCode==='GBP'&&invoice.AmountDue===0&&invoice.AmountPaid===invoice.Total
    &&!(invoice.AmountCredited>0)&&!(invoice.CreditNotes||[]).length&&payments.length>0
    &&payments.every(p=>p.Status==='AUTHORISED'&&p.Invoice?.InvoiceID===invoice.InvoiceID&&p.Amount>0)
    &&Math.abs(payments.reduce((sum,p)=>sum+p.Amount,0)-invoice.Total)<0.005;
  if(!identityVerified)holds.push('Contact identity needs review');
  if(!invoice)holds.push('No paid membership invoice found');
  else if(!paid)holds.push('Full cash settlement not verified');
  if(latest&&invoice&&latest.InvoiceID!==invoice.InvoiceID)holds.push('Newer membership invoice needs review');
  if(invoice){
    if((invoice.LineItems?.length!==1&&!separateLine)||!membershipLine||membershipLine.Quantity!==1
      ||/\bupgrade|adjustment|balance|instalment|direct debit|\bDD\b|pro.?rata/i.test(membershipLine?.Description||''))
      holds.push('Invoice is not a clear single annual membership charge');
  }
  if(review.sourceState!=='source_fields_corroborated')holds.push('Original import evidence needs reconciliation');
  if(review.historicalDDDescription||live.dd_evidence)holds.push('DD evidence needs reconciliation');
  if(live.history_count!==0)holds.push('Membership history now exists');
  if(review.liveDrift||JSON.stringify(live.preferences)!==JSON.stringify(review.liveSource.preferences))
    holds.push('Live membership fields changed');
  if(structures.length!==1||structures[0].billing_period!=='annual')holds.push('No unique annual member-class structure');
  let start=null,renewal=null,offsetDays=null;
  try{
    const end=new Date(`${review.retainedExpiry}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate()+1);renewal=end.toISOString().slice(0,10);
    const year=Number(renewal.slice(0,4))-1;
    start=`${year}${renewal.slice(4)}`;
    if(addCalendarMonths(start,12)!==renewal)throw Error('Ambiguous annual boundary');
    if(invoice){
      offsetDays=(Date.parse(invoice.DateString.slice(0,10))-Date.parse(start))/86400000;
      if(offsetDays < -90 || offsetDays > 31 || start>today)
        holds.push('Payment timing does not corroborate retained expiry for a 12-month term');
    }
  }catch{holds.push('Annual term dates need review');start=null;renewal=null;}
  return {memberId:review.memberId,name:review.name,email:review.email,memberClass:review.memberClass,
    identityVerified,paidInvoiceVerified:paid&&identityVerified,
    conditionalCandidate:holds.length===0,
    outcome:holds.length?'Further review required':'Candidate for approved 12-month reconstruction',
    holds,invoiceNumber:invoice?.InvoiceNumber||'',invoiceDate:invoice?.DateString?.slice(0,10)||'',
    amount:invoice?.Total??null,currency:invoice?.CurrencyCode||'',description:invoice?.LineItems?.map(l=>l.Description).join('; ')||'',
    invoiceKind:separateLine?'Separately itemised membership on mixed invoice':'Standalone or unresolved',
    membershipAmount:separateLine?membershipLine.LineAmount:membershipLine&&invoice?.LineItems?.length===1?invoice.Total:null,
    latestInvoiceNumber:latest?.InvoiceNumber||'',latestInvoiceStatus:latest?.Status||'',
    proposedStart:start,retainedExpiry:review.retainedExpiry,proposedRenewal:renewal,offsetDays,
    structure:structures.length===1?structures[0].name:'Unresolved',sourceState:review.sourceState,
    authority:'Investigation only: dates are a conditional 12-month reconstruction, not provider-confirmed coverage. No repair authorised.'};
}
