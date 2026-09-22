import { destinationConnection } from './run-bnms-dd-pilot-history.mjs';
import { TENANT, XERO_TENANT } from './audit-bnms-non-dd-pilot.mjs';
import { digest, invoiceProof, invoiceCandidate } from './prepare-bnms-non-dd-current.mjs';

// Called before the short write transaction; transaction source guards catch
// intervening identity/legacy/DD changes. No provider write or token refresh.
export async function revalidateInvoices(manifest) {
  // Unlinked operator-attested rows assert membership, not provider settlement.
  // validateManifest enforces unknown amounts and unresolved invoice provenance.
  const linkedRows=manifest.rows.filter(row=>row.xero_invoice_id);
  if(!linkedRows.length)return;
  const c=await destinationConnection();await c.connect();
  let tokens,members;
  try {
    await c.query('BEGIN READ ONLY');
    tokens=(await c.query('SELECT tenant_id,access_token,expires_at FROM xero_token WHERE app_tenant_id=$1',[TENANT])).rows;
    members=(await c.query('SELECT id,email FROM member WHERE tenant_id=$1 AND id=ANY($2::uuid[])',[TENANT,manifest.rows.map(r=>r.member_id)])).rows;
  }finally{await c.query('ROLLBACK');await c.end();}
  if(tokens.length!==1||tokens[0].tenant_id!==XERO_TENANT||new Date(tokens[0].expires_at).getTime()<=Date.now())throw Error('Fresh pinned Xero connection required');
  const get=async resource=>{
    await new Promise(r=>setTimeout(r,2500));
    const res=await fetch(`https://api.xero.com/api.xro/2.0/${resource}`,{
      headers:{Authorization:`Bearer ${tokens[0].access_token}`,'xero-tenant-id':XERO_TENANT,Accept:'application/json'},
      signal:AbortSignal.timeout(30000),
    });
    if(!res.ok)throw Error(`Xero pre-apply validation HTTP ${res.status}; no writes`);
    return res.json();
  };
  for(const row of linkedRows){
    const notes=JSON.parse(row.notes);
    if(!row.xero_invoice_id)throw Error('This reviewed importer requires a linked paid invoice');
    const contact=(await get(`Contacts/${notes.xeroContactId}`)).Contacts;
    const email=members.find(m=>m.id===row.member_id)?.email?.trim().toLowerCase();
    if(contact?.length!==1||contact[0].ContactID!==notes.xeroContactId||contact[0].ContactStatus!=='ACTIVE'
      ||!email||contact[0].EmailAddress?.trim().toLowerCase()!==email
      ||contact[0].AccountNumber!==notes.legacy.ym_web_site_member_id)throw Error('Live contact ownership drift');
    const invoices=[],seen=new Set();
    for(let page=1;;page++){
      if(page>100)throw Error('Invoice pagination incomplete');
      const data=await get(`Invoices?${new URLSearchParams({where:`Contact.ContactID==Guid("${notes.xeroContactId}")&&Type=="ACCREC"`,order:'Date DESC',page:String(page)})}`);
      if(!Array.isArray(data.Invoices))throw Error('Invalid invoice page');
      for(const i of data.Invoices){if(seen.has(i.InvoiceID))throw Error('Invoice pagination drift');seen.add(i.InvoiceID);invoices.push(i);}
      if(data.Invoices.length<100)break;
    }
    const candidate=invoiceCandidate(invoices);
    if(candidate.state!=='candidate'||candidate.invoice.InvoiceID!==row.xero_invoice_id
      ||digest(invoiceProof(candidate.invoice))!==notes.invoiceEvidenceSha256
      ||Number(candidate.invoice.Total)!==row.total_with_vat)throw Error('Latest paid invoice evidence drift');
    for(const payment of candidate.invoice.Payments){
      const result=(await get(`Payments/${payment.PaymentID}`)).Payments;
      if(result?.length!==1||result[0].PaymentID!==payment.PaymentID||result[0].Status!=='AUTHORISED'
        ||result[0].Invoice?.InvoiceID!==row.xero_invoice_id
        ||Number(result[0].Amount)!==Number(payment.Amount))throw Error('Payment settlement evidence drift');
    }
  }
}