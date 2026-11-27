import {requireFunnelOwner,requireSameOriginJson} from './eventFunnelJourneyHandler.js';
import {fetchFunnelInvoicePdf} from './eventFunnelInvoiceReaders.js';
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function createFunnelOwnedInvoicesHandler({db,resolveTenant,loadViewer,fetchPdf=fetchFunnelInvoicePdf}) {
  return async(req,res)=>{
    for(const [key,value] of Object.entries({'Cache-Control':'private, no-store','CDN-Cache-Control':'no-store',
      'Vercel-CDN-Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow',Vary:'Cookie'})) res.setHeader(key,value);
    try {
      if(req.method!=='POST') {res.setHeader('Allow','POST');return res.status(405).json({error:'Method not allowed'});}
      requireSameOriginJson(req);
      const body=req.body;
      if(!body||Array.isArray(body)||!uuid(body.sessionId)||!uuid(body.orderId)
        || !['list','download'].includes(body.action)
        || (body.action==='download'&&!uuid(body.invoiceId))
        || Object.keys(body).some(key=>!['sessionId','orderId','action',...(body.action==='download'?['invoiceId']:[])].includes(key))) {
        return res.status(400).json({error:'Invalid invoice request'});
      }
      const owner=await requireFunnelOwner({req,res,db,resolveTenant,loadViewer,sessionId:body.sessionId});
      const result=await db.rpc('event_funnel_owned_invoices',{p_tenant:owner.tenantId,p_id:owner.sessionId,
        p_member:owner.memberId,p_capability_hash:owner.capabilityHash,p_order:body.orderId,
        p_invoice:body.action==='download'?body.invoiceId:null});
      if(result.error||!result.data) return res.status(result.error?.code==='PT404'?404:result.error?.code==='PT409'?409:503)
        .json({error:'The original checkout invoices are not available. Your bookings have not changed.'});
      if(body.action==='list') {
        if(!Array.isArray(result.data.invoices)) throw new Error('Invalid invoice projection');
        const email=result.data.email;
        return res.status(200).json({state:result.data.state,invoiceMode:result.data.invoiceMode,
          invoices:result.data.invoices.map(item=>({id:item.id,number:item.number,status:item.status,available:item.available===true})),
          // Absent until the invoice email migration is installed.
          email:email&&typeof email.to==='string'&&['pending','sent','unconfirmed'].includes(email.state)
            ?{to:email.to,state:email.state}:null});
      }
      const pdf=await fetchPdf({db,tenantId:owner.tenantId,link:result.data});
      const filename=String(result.data.invoiceNumber||'invoice').replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,100);
      res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Length',pdf.length);
      res.setHeader('Content-Disposition',`attachment; filename="${filename}.pdf"`);
      return res.send(pdf);
    } catch(error) {
      return res.status([400,403,404,429].includes(error.status)?error.status:503)
        .json({error:'Invoice access is not available. Your confirmed bookings have not changed.'});
    }
  };
}
