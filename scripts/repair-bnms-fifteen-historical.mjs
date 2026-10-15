// Approved, bounded historical repairs. Xero GETs only; no financial entrypoints.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {connectDestination} from './lib/member-index-destination.mjs';
import {destinationTarget} from './apply-custom-object-relationship-deleted-members-migration.mjs';
import {buildRollingCommitment} from '../api/_lib/rollingMembershipCommitment.js';
const mode=process.argv[2];assert.ok(['prepare','dry-run','apply','verify'].includes(mode));
const tenant='ff2df806-b321-4254-b651-3af11fccf1db';
const additional=process.argv[3]==='additional-nine';
const mary=process.argv[3]==='mary-included';
const mariana=process.argv[3]==='mariana-paid';
const martti=process.argv[3]==='martti-paid';
const osama=process.argv[3]==='osama-paid';
const rakesh=process.argv[3]==='rakesh-paid';
const heather=process.argv[3]==='heather-complimentary';
const included=process.argv[3]==='jo-included'||mary;
assert.ok(!process.argv[3]||additional||included||mariana||martti||osama||rakesh||heather);
const approved=heather?['009a46d1-eb3c-4c0a-b774-f3e2ee6a6c8e']:rakesh?['9de12938-46f6-4bd8-a41c-0d160563c99c']:osama?['dea0d7ed-b311-4759-aacb-47f68a3fd3fa']:martti?['ce6bd29b-f9a5-4217-a6b8-e35b2d5ce093']:mariana?['a7d48296-c57c-43c9-8eb7-9139b764dd07']:mary?['7bd2fb4f-aee9-4b9f-b925-7343f317aa4e']:included?['2ed34ac1-6f57-44d5-8a21-75bf3521d826']:additional?[
  '5310e36a-5c40-4e3d-b533-781037a52543','6aa9e9aa-f72a-42da-b516-89b219e89309',
  '5f6a2fb2-d4f0-4cdf-a437-b985493e3a5c','784682f0-9445-45d5-beb5-dbfd5ac58c60',
  'f1485422-d0ac-49fd-b8df-fb9386a56fee','575f64e2-a940-4ecf-8bda-909fa1fe32d1',
  '5c622874-0743-4310-9d3c-3b2f3815abc0','7f03f328-b428-404c-9cc8-88767fafdb94',
  'c05d0240-5884-43c2-9435-311c44f4e84d',
]:[
  '061b8e4d-c007-418e-9eb1-7e2953db9406','0b4143f2-4de3-4e06-8588-cccaeb4aef4d',
  '0f13863a-ee27-480d-9711-e6eaae948037','22d6148c-55b6-4725-95fd-2db1d2b3af3c',
  '2a0353bb-c971-4f85-a134-c43ec99c1b0d','3e7d67fa-d7b9-4c00-852e-975242d034e6',
  '50dd9c6a-2310-43c9-bd5b-9c34dbec5277','6db0422f-d262-486a-82ec-75609890e6f5',
  '79cc3f7e-fe05-43ad-bad4-eeb9b7979137','83d75b63-150a-4fb6-bf61-0c1c0589f832',
  '9eabe936-d53c-45d6-b9c6-9ac14d39d497','c0923843-6bea-436e-abee-8c838f8b3f4f',
  'ca24a246-4bd3-40ba-9db4-a39044c5a8ef','df2ba5a2-a6ba-4c40-b914-446b6e956027',
  'fe1b50de-d67e-412a-83c9-47cd2a1aca2f',
];
const dir=heather?'generated-artifacts/bnms-heather-complimentary-membership':rakesh?'generated-artifacts/bnms-rakesh-paid-membership':osama?'generated-artifacts/bnms-osama-paid-membership':martti?'generated-artifacts/bnms-martti-paid-membership':mariana?'generated-artifacts/bnms-mariana-paid-membership':mary?'generated-artifacts/bnms-mary-included-membership':included?'generated-artifacts/bnms-jo-included-membership':additional?'generated-artifacts/bnms-additional-nine-historical':'generated-artifacts/bnms-fifteen-historical';
fs.mkdirSync(dir,{recursive:true,mode:0o700});
const save=(name,value)=>fs.writeFileSync(`${dir}/${name}.json`,JSON.stringify(value,null,2),{mode:0o600});
const load=name=>JSON.parse(fs.readFileSync(`${dir}/${name}.json`,'utf8'));
destinationTarget(process.env);process.env.SUPABASE_URL=process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY=process.env.DEST_SUPABASE_KEY;
const {projectMembershipPaymentReport}=await import('../api/_lib/membershipPaymentReport.js');
const {shapePersistedCommitment}=await import('../api/membership/member-membership.js');
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const stableId=member=>{
  const s=hash({tenant,member,source:'approved_historical_fifteen'}).slice(0,32);
  return `${s.slice(0,8)}-${s.slice(8,12)}-5${s.slice(13,16)}-a${s.slice(17,20)}-${s.slice(20)}`;
};
const db=await connectDestination();
async function snapshot(){
  const tables={};
  for(const table of ['member','member_membership_history','membership_billing_agreements','membership_payment_plans','historical_member_invoice']){
    const owner=table==='member'?'id':'member_id';
    tables[table]=(await db.query(`SELECT to_jsonb(r) data FROM ${table} r WHERE tenant_id=$1 AND ${owner}=ANY($2::uuid[]) ORDER BY id`,
      [tenant,approved])).rows.map(r=>r.data);
  }
  tables.preferences=(await db.query(`SELECT v.id,v.member_id,v.value,f.id field_id,f.name FROM member_preference_value v
    JOIN preference_field f ON f.id=v.field_id WHERE f.tenant_id=$1 AND v.member_id=ANY($2::uuid[]) ORDER BY v.id`,
  [tenant,approved])).rows;
  tables.configs=(await db.query(`SELECT to_jsonb(c) data FROM membership_tier_config c WHERE tenant_id=$1
    AND structure_scope_type='member' AND is_active=true AND effective_from<=CURRENT_DATE
    AND (effective_to IS NULL OR effective_to>=CURRENT_DATE) ORDER BY id`,[tenant])).rows.map(r=>r.data);
  return tables;
}
try{
  if(mode==='prepare'){
    await db.query('BEGIN READ ONLY');const before=await snapshot();await db.query('ROLLBACK');
    assert.equal(before.member.length,approved.length);assert.equal(before.member_membership_history.length,0);
    assert.equal(before.membership_billing_agreements.length,0);assert.equal(before.membership_payment_plans.length,0);
    const prior=JSON.parse(fs.readFileSync('generated-artifacts/bnms-current-commitments/recovery-review.json')).rows;
    const providers=JSON.parse(fs.readFileSync('generated-artifacts/bnms-remaining-84/members.json'));
    const {getValidXeroAccessToken}=await import('../api/_lib/xero.js');
    const auth=await getValidXeroAccessToken(tenant);
    assert.equal(auth.tenantId,'3d57dce6-2205-462f-abf6-9c7cbf00be23');
    let last=0,remaining=null,requests=0;
    const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    async function get(path,params={}){
      if(remaining!==null&&remaining<12){await sleep(65000);remaining=null;}
      await sleep(Math.max(0,2100-(Date.now()-last)));
      assert.ok(++requests<=100);last=Date.now();
      const r=await fetch(`https://api.xero.com/api.xro/2.0/${path}?${new URLSearchParams(params)}`,{headers:{
        Authorization:`Bearer ${auth.accessToken}`,'xero-tenant-id':auth.tenantId,Accept:'application/json'},
        signal:AbortSignal.timeout(30000)});
      assert.equal(r.status,200,'Xero verification incomplete');
      if(r.headers.has('x-daylimit-remaining'))assert.ok(Number(r.headers.get('x-daylimit-remaining'))>100);
      remaining=r.headers.has('x-minlimit-remaining')?Number(r.headers.get('x-minlimit-remaining')):null;
      return r.json();
    }
    const records=[],evidence=[];
    for(const member of approved){
      const p=prior.find(r=>r.memberId===member),provider=providers.find(r=>r.memberId===member);
      if(heather){
        assert.equal(p.proposedStart,'2025-05-01');assert.equal(p.retainedExpiry,'2026-04-30');
        assert.equal(p.invoiceNumber,'300004410');assert.equal(p.amount,61);
        assert.equal(provider.latestPaidInvoiceId,'97079742-ed2a-4462-aa75-91710d6e394c');
      }
      if(rakesh){
        assert.equal(p.proposedStart,'2025-06-08');assert.equal(p.retainedExpiry,'2026-06-07');
        assert.equal(p.invoiceNumber,'300005419');assert.equal(p.amount,156);assert.equal(p.membershipAmount,156);
        assert.equal(provider.latestPaidInvoiceId,'ec6e9974-b50f-4ae2-900a-167d14d101f0');
      }
      if(osama){
        assert.equal(p.proposedStart,'2025-09-22');assert.equal(p.retainedExpiry,'2026-09-21');
        assert.equal(p.invoiceNumber,'300004785');assert.equal(p.amount,61);assert.equal(p.membershipAmount,61);
        assert.equal(provider.latestPaidInvoiceId,'d8daf65c-3a3a-418d-ae41-1d71446047de');
      }
      if(martti){
        assert.equal(p.proposedStart,'2025-09-27');assert.equal(p.retainedExpiry,'2026-09-26');
        assert.equal(p.invoiceNumber,'300004821');assert.equal(p.amount,47);assert.equal(p.membershipAmount,47);
        assert.equal(provider.latestPaidInvoiceId,'2b9b35ec-ba58-4361-b57e-12e76478564e');
      }
      if(mariana){
        assert.equal(p.proposedStart,'2025-05-21');assert.equal(p.retainedExpiry,'2026-05-20');
        assert.equal(p.invoiceNumber,'300004428');assert.equal(p.amount,71);assert.equal(p.membershipAmount,71);
        assert.equal(provider.latestPaidInvoiceId,'f7d67aaf-1f59-4e44-8021-9fae113c6af0');
      }
      if(mary){
        assert.equal(p.proposedStart,'2025-07-30');assert.equal(p.retainedExpiry,'2026-07-29');
        assert.equal(p.invoiceNumber,'200005869');assert.equal(p.amount,482.5);p.membershipAmount=0;
        provider.latestPaidInvoiceId='7c2770ff-23a2-4008-8ee2-080e3fab1d65';
      }else if(included){
        assert.equal(p.proposedStart,'2025-04-18');assert.equal(p.retainedExpiry,'2026-04-17');
        p.invoiceNumber='200005988';p.amount=556;p.membershipAmount=0;
        provider.latestPaidInvoiceId='3c0ef6a1-a57f-451d-96ee-e48cbc3358ec';
      }
      if(!additional&&!included&&!mariana&&!martti&&!osama&&!rakesh&&!heather){assert.equal(p.category,'Paid historical-only reconstruction candidate');assert.equal(p.holds.length,0);}
      const m=before.member.find(m=>m.id===member);
      assert.equal(m.email.toLowerCase(),p.email.toLowerCase());
      const prefs=before.preferences.filter(v=>v.member_id===member);
      const klass=prefs.find(v=>v.name==='member_class'),expiry=prefs.find(v=>v.name==='ym_date_membership_expires');
      assert.equal(klass.value,p.memberClass);
      assert.equal(expiry.value,`${p.retainedExpiry.slice(8)}/${p.retainedExpiry.slice(5,7)}/${p.retainedExpiry.slice(0,4)}`);
      const configs=before.configs.filter(c=>c.structure_field_id===klass.field_id&&c.structure_match_value===klass.value);
      assert.equal(configs.length,1,`Schedule ambiguity for ${p.name}`);const config=configs[0];
      assert.equal(config.billing_period,'annual');
      const invoice=(await get(`Invoices/${provider.latestPaidInvoiceId}`)).Invoices[0];
      assert.equal(invoice.InvoiceNumber,p.invoiceNumber);
      const contact=(await get(`Contacts/${invoice.Contact.ContactID}`)).Contacts[0];
      if(mariana){
        assert.equal(contact.ContactID,'8aaa1caa-e9e4-4a86-b317-73b59016f2d6');
        assert.equal(contact.Name,'Mariana Pinto');
        assert.equal(contact.EmailAddress.toLowerCase(),'mariana.pinto@belfasttrust.hscni.net');
        assert.equal(m.email.toLowerCase(),'bbmarianapinto@hotmail.com');
      }else if(mary){
        assert.equal(contact.ContactID,'ff299dce-fc45-4abc-845b-669738c47d2f');
        assert.equal(contact.Name,'Mary Akinade');
        assert.equal(contact.EmailAddress.toLowerCase(),'mary.akinade@gstt.nhs.uk');
        assert.equal(m.email.toLowerCase(),'m.akinade@nhs.net');
      }else assert.equal(contact.EmailAddress.toLowerCase(),m.email.toLowerCase());
      const newest=(await get('Invoices',{where:`Contact.ContactID==Guid("${contact.ContactID}")`,order:'Date DESC',page:'1'})).Invoices;
      assert.ok(newest.length<100,'Contact invoice pagination required');
      const outstanding=rakesh?newest.find(i=>i.InvoiceID==='f31b1dab-6829-41e1-a1e3-39348d78c1ac'):null;
      if(rakesh){
        assert.ok(outstanding);assert.equal(outstanding.InvoiceNumber,'300005473');
        assert.equal(outstanding.Type,'ACCREC');assert.equal(outstanding.Status,'AUTHORISED');
        assert.equal(outstanding.Total,156);assert.equal(outstanding.AmountDue,156);
        assert.equal(outstanding.AmountPaid,0);assert.equal(outstanding.AmountCredited,0);
      }
      assert.ok(!newest.some(i=>i.Type==='ACCREC'&&i.InvoiceID!==invoice.InvoiceID
        &&i.DateString>invoice.DateString&&!['VOIDED','DELETED'].includes(i.Status)
        &&!(rakesh&&i.InvoiceID===outstanding.InvoiceID)
        &&!(included&&!mary&&i.InvoiceNumber==='200006008'&&i.AmountPaid===0&&i.AmountDue===0&&i.AmountCredited===420&&i.Total===420)
        &&i.LineItems?.some(l=>/\bmembership\b/i.test(l.Description||''))),`Newer membership invoice: ${p.name}`);
      assert.equal(invoice.Type,'ACCREC');assert.equal(invoice.Status,'PAID');assert.equal(invoice.CurrencyCode,'GBP');
      assert.equal(invoice.Total,p.amount);assert.equal(invoice.AmountPaid,heather?0:invoice.Total);assert.equal(invoice.AmountDue,0);
      if(invoice.AmountCredited!=null)assert.equal(invoice.AmountCredited,heather?61:0);
      if(heather){
        assert.equal(invoice.AmountCredited,61);assert.ok(invoice.CreditNotes.length>0);
      }else assert.equal((invoice.CreditNotes||[]).length,0);
      const lines=invoice.LineItems.filter(l=>/\bmembership\b/i.test(l.Description||'')
        &&!/\bevent|attend|conference|meeting|ticket|discount|includes/i.test(l.Description||''));
      if(mary){
        assert.equal(invoice.LineItems.length,3);
        assert.equal(invoice.LineItems.filter(l=>l.Description==='S2025 - 3 days - reduced includes 1 year free membership - Mary Akinade').length,1);
      }else if(included){
        assert.equal(invoice.LineItems.length,1);
        assert.equal(invoice.LineItems[0].Description,'S2025 - 3 days - full includes 1 year free membership - Jo Hopkins');
      }else{
        assert.equal(lines.length,1);assert.equal(lines[0].Quantity,1);assert.equal(lines[0].TaxAmount,0);
      }
      const amount=heather?0:additional&&p.memberId==='5310e36a-5c40-4e3d-b533-781037a52543'?156:
        additional&&p.memberId==='6aa9e9aa-f72a-42da-b516-89b219e89309'?128:p.membershipAmount;
      if(included||heather)assert.equal(amount,0);
      else assert.equal(lines[0].LineAmount,amount);
      const payments=[];
      // Xero's single-invoice endpoint can expose a BatchPaymentID as PaymentID.
      // The invoice-list response supplies the individual payment ID; still verify
      // its actual invoice association and full cash settlement below.
      const listed=newest.find(i=>i.InvoiceID===invoice.InvoiceID);
      assert.ok(listed);assert.equal(listed.AmountPaid,invoice.AmountPaid);
      for(const entry of listed.Payments||[]){
        const payment=(await get(`Payments/${entry.PaymentID}`)).Payments[0];
        assert.equal(payment.Status,'AUTHORISED');assert.equal(payment.Invoice.InvoiceID,invoice.InvoiceID);
        assert.ok(payment.Amount>0);payments.push(payment);
      }
      if(heather)assert.equal(payments.length,0);
      else assert.ok(payments.length>0);
      assert.ok(Math.abs(payments.reduce((a,p)=>a+p.Amount,0)-(heather?0:invoice.Total))<0.005);
      const paidAt=heather?null:new Date(Math.max(...payments.map(p=>Number(/\/Date\((\d+)/.exec(p.Date)[1])))).toISOString();
      if(rakesh)assert.equal(paidAt.slice(0,10),'2026-08-24');
      if(osama)assert.equal(paidAt.slice(0,10),'2025-12-23');
      if(martti)assert.equal(paidAt.slice(0,10),'2026-01-06');
      if(mariana)assert.equal(paidAt.slice(0,10),'2025-05-22');
      if(included)assert.equal(paidAt.slice(0,10),mary?'2025-07-29':'2025-04-17');
      const amounts={annual_cost:amount,final_cost:amount,vat_amount:0,total_with_vat:amount,currency:'GBP'};
      const commitment=buildRollingCommitment({config,startDate:p.proposedStart,paymentMethod:'upfront',
        paymentFrequency:'upfront',amounts,pricingSnapshot:{tier_label:klass.value,...amounts}});
      assert.equal(commitment.term_end_date,p.retainedExpiry);
      const record={id:stableId(member),tenant_id:tenant,member_id:member,config_id:config.id,...commitment,...amounts,
        membership_year:commitment.term_key,tier_label:klass.value,field_value:klass.value,billing_period:'annual',
        status:'expired',payment_status:'paid',payment_method:'upfront',paid_at:paidAt,accounting_provider:'xero',
        accounting_invoice_id:invoice.InvoiceID,accounting_invoice_number:invoice.InvoiceNumber,
        xero_invoice_id:invoice.InvoiceID,xero_invoice_number:invoice.InvoiceNumber,
        notes:JSON.stringify({source:martti||osama||rakesh?'operator_approved_late_paid_retained_term':mariana?'operator_approved_identity_reconciled_paid_membership':included?'operator_approved_included_event_membership':additional?'operator_approved_nine_retained_expiry_reconstructions':'operator_approved_fifteen_historical_reconstructions',approvalDate:'2026-10-15',
          outstandingInvoiceAuthority:rakesh?{invoiceId:outstanding.InvoiceID,invoiceNumber:outstanding.InvoiceNumber,
            amountDue:outstanding.AmountDue,instruction:'Owner approved linking paid invoice to retained term, leaving outstanding invoice unchanged and unresolved.'}:null,
          includedMembershipAuthority:included?'Owner approved one year free membership included in paid event invoice. Zero separate membership charge; event consideration is not membership revenue.':null,
          identityAuthority:mary||mariana?{basis:'Owner explicitly confirmed Xero and iConnect addresses belong to the same member',
            memberEmail:m.email,providerEmail:contact.EmailAddress,contactId:contact.ContactID}:null,
          latePaymentAuthority:additional||martti||osama||rakesh?'Owner explicitly instructed retaining stored expiry; late payment does not shift the approved annual term.':null,
          termAuthority:'approved_12_month_term_retaining_recorded_expiry',scope:'historical_only_not_renewed',
          scheduleAuthority:'Current member-class schedule approved for reconstruction; not historical configuration evidence.',
          invoiceId:invoice.InvoiceID,paymentIds:payments.map(p=>p.PaymentID),
          invoiceTotal:invoice.Total,membershipPortion:amount,mixedInvoice:invoice.LineItems.length>1,
          futureCollectionConsent:false,providerWrites:0})};
      if(heather){
        record.accounting_provider=null;record.accounting_invoice_id=null;record.accounting_invoice_number=null;
        record.xero_invoice_id=null;record.xero_invoice_number=null;
        record.notes=JSON.stringify({...JSON.parse(record.notes),
          source:'operator_confirmed_complimentary_membership',
          complimentary:true,cashReceived:0,
          paymentStatusMeaning:'Zero charge settled; no cash payment received.',
          authority:'Owner explicitly confirmed complimentary membership for the retained annual term.',
          invoiceId:null,creditedInvoiceReference:invoice.InvoiceNumber,
          creditedInvoiceIsPaymentEvidence:false});
      }
      records.push(record);evidence.push({memberId:member,invoice,contact,payments,outstanding});
      console.log(JSON.stringify({verified:p.name,invoice:p.invoiceNumber,membershipAmount:amount}));
    }
    save('prepared',{at:new Date().toISOString(),approved,before,records,evidence,requests});
    console.log(JSON.stringify({prepared:records.length,requests,providerWrites:0})); 
  }else{
    const prepared=load('prepared');assert.deepEqual(prepared.approved,approved);
    if(mode!=='verify')assert.ok(Date.now()-Date.parse(prepared.at)<30*60*1000,'Revalidate expired evidence');
    await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await db.query("SET LOCAL lock_timeout='5s'");
    await db.query("SET LOCAL statement_timeout='60s'");
    await db.query('SELECT id FROM member WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',[tenant,approved]);
    const before=await snapshot();
    if(mode==='apply')assert.equal(load('dry-run').preparedHash,hash(prepared));
    const replay=before.member_membership_history.length===approved.length;
    if(mode==='verify')assert.ok(replay,'Repair missing');
    const withoutHistory=x=>({...x,member_membership_history:[]});
    assert.deepEqual(withoutHistory(before),withoutHistory(prepared.before),'Source changed since provider review');
    if(!replay){
      assert.equal(before.member_membership_history.length,0);
      if(mode==='apply')save(`before-${Date.now()}`,before);
      for(const record of prepared.records){
        assert.equal((await db.query(`SELECT count(*)::int n FROM member_membership_history WHERE tenant_id=$1
          AND (accounting_invoice_id=$2 OR xero_invoice_id=$2)`,[tenant,record.accounting_invoice_id])).rows[0].n,0);
        const keys=Object.keys(record);
        await db.query(`INSERT INTO member_membership_history (${keys.join(',')}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(',')})`,
          keys.map(k=>record[k]!==null&&typeof record[k]==='object'?JSON.stringify(record[k]):record[k]));
      }
    }
    const after=await snapshot();assert.deepEqual(withoutHistory(after),withoutHistory(before));
    assert.equal(after.member_membership_history.length,approved.length);
    for(const record of prepared.records){
      const actual=after.member_membership_history.find(h=>h.id===record.id);assert.ok(actual);
      for(const [key,value] of Object.entries(record)){
        if(key==='paid_at'&&value!==null)assert.equal(Date.parse(actual[key]),Date.parse(value));
        else assert.deepEqual(actual[key],value,key);
      }
      const display=shapePersistedCommitment(actual);
      assert.equal(display.lifecycle,'past');assert.equal(display.paymentMethod,'upfront');
      assert.equal(display.agreedPrice,record.total_with_vat);
    }
    const report=projectMembershipPaymentReport({tenantId:tenant,members:after.member,
      history:after.member_membership_history,configs:after.configs,today:'2026-10-15'});
    assert.equal(report.length,approved.length);assert.ok(report.every(r=>r.status==='expired'&&r.paymentMethod==='upfront'));
    await db.query(mode==='apply'?'COMMIT':'ROLLBACK');
    if(mode==='dry-run')save('dry-run',{preparedHash:hash(prepared)});
    save(`${mode}-${Date.now()}`,{after,report,replay});
    console.log(JSON.stringify({mode,replay,records:approved.length,reportIncluded:report.length,providerWrites:0}));
  }
}catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}finally{await db.end();}
