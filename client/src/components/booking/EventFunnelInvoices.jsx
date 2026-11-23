import React, {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Button} from '@/components/ui/button';

async function invoiceRequest(sessionId,orderId,action,invoiceId) {
  const response=await fetch('/api/event-funnels/invoices',{method:'POST',credentials:'include',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId,orderId,action,...(invoiceId?{invoiceId}:{})})});
  if(!response.ok) throw new Error('Invoices are not available right now. Your confirmed bookings have not changed.');
  return response;
}
export default function EventFunnelInvoices({sessionId,orderId}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const query=useQuery({queryKey:['owned-event-reservation-invoices',sessionId,orderId],
    queryFn:async()=>{const data=await (await invoiceRequest(sessionId,orderId,'list')).json();
      if(!Array.isArray(data.invoices)) throw new Error('Invoice information could not be verified.');return data;},
    retry:false,staleTime:0});
  async function download(invoice) {
    setBusy(true);setError('');
    try {
      const response=await invoiceRequest(sessionId,orderId,'download',invoice.id);
      const blob=await response.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');
      a.href=url;a.download='invoice.pdf';document.body.appendChild(a);a.click();a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    } catch(e) {setError(e.message);} finally {setBusy(false);}
  }
  return <section className="event-funnel-checkout__notice" aria-label="Your invoices">
    <h4>Your invoices</h4>
    {query.isPending?<p role="status">Loading invoices…</p>:query.isError?<p role="alert">{query.error.message}</p>:<>
      {query.data.state==='not_applicable'?<p>No invoice payment is due.</p>:query.data.invoices.length===0?
        <p>{query.data.state==='needs_review'?'Invoice preparation needs our attention.':'Your invoices are being prepared.'} Your bookings remain confirmed.</p>:null}
      {query.data.invoices.map((invoice,index)=><div key={invoice.id}>
        <span>{invoice.number||`Invoice ${index+1}`}</span>{' '}
        {invoice.available?<Button type="button" variant="outline" disabled={busy} onClick={()=>download(invoice)}>Download invoice</Button>:
          <span>{invoice.status==='needs_review'?'Needs attention':'Being prepared'}</span>}
      </div>)}
    </>}
    {error&&<p role="alert">{error}</p>}
    <Button type="button" variant="outline" disabled={query.isFetching||busy} onClick={()=>query.refetch()}>Check invoices again</Button>
  </section>;
}
