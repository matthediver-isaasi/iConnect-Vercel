import React, {useEffect, useRef, useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {CheckCircle2, AlertCircle, Loader2} from 'lucide-react';
import {Button} from '@/components/ui/button';

async function invoiceRequest(sessionId,orderId,action,invoiceId) {
  const response=await fetch('/api/event-funnels/invoices',{method:'POST',credentials:'include',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId,orderId,action,...(invoiceId?{invoiceId}:{})})});
  if(!response.ok) throw new Error('Invoices are not available right now. Your confirmed bookings have not changed.');
  return response;
}
// Invoices are raised in the background after confirmation. While any are
// still being prepared the list re-checks itself for a bounded period, so the
// customer can simply wait here.
const POLL_MS=4000,POLL_LIMIT_MS=3*60*1000;
const settled=data=>data.state==='not_applicable'||data.state==='needs_review'
  ||(data.invoices.length>0&&data.invoices.every(invoice=>invoice.available||invoice.status==='needs_review'));

function InvoiceRow({label,status,children}) {
  const icon=status==='ready'?<CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true"/>
    :status==='attention'?<AlertCircle className="h-4 w-4 text-amber-600" aria-hidden="true"/>
    :<Loader2 className="h-4 w-4 animate-spin text-slate-500" aria-hidden="true"/>;
  const text=status==='ready'?'Ready':status==='attention'?'Needs our attention':'Being prepared';
  return <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-3 py-2"
    data-testid="event-funnel-invoice-row" data-status={status}>
    <span className="font-medium">{label}</span>
    <span className="flex items-center gap-3">
      <span className="flex items-center gap-1.5 text-sm text-slate-600">{icon}{text}</span>
      {children}
    </span>
  </li>;
}

export default function EventFunnelInvoices({sessionId,orderId}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const started=useRef(Date.now());
  const query=useQuery({queryKey:['owned-event-reservation-invoices',sessionId,orderId],
    queryFn:async()=>{const data=await (await invoiceRequest(sessionId,orderId,'list')).json();
      if(!Array.isArray(data.invoices)) throw new Error('Invoice information could not be verified.');return data;},
    refetchInterval:q=>q.state.data&&!settled(q.state.data)&&Date.now()-started.current<POLL_LIMIT_MS?POLL_MS:false,
    retry:false,staleTime:0});
  async function download(invoice) {
    setBusy(true);setError('');
    try {
      const response=await invoiceRequest(sessionId,orderId,'download',invoice.id);
      const blob=await response.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');
      a.href=url;a.download=`${invoice.number||'invoice'}.pdf`.replace(/[^a-zA-Z0-9_.-]/g,'_');
      document.body.appendChild(a);a.click();a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    } catch(e) {setError(e.message);} finally {setBusy(false);}
  }
  const data=query.data;
  const preparing=data&&!settled(data);
  // Re-render once the polling window ends so the longer-wait copy appears.
  const [,setTick]=useState(0);
  useEffect(()=>{
    if(!preparing) return undefined;
    const timer=setTimeout(()=>setTick(value=>value+1),Math.max(0,POLL_LIMIT_MS-(Date.now()-started.current))+50);
    return ()=>clearTimeout(timer);
  },[preparing,query.dataUpdatedAt]);
  const timedOut=preparing&&Date.now()-started.current>=POLL_LIMIT_MS;
  const total=data?.invoices.length||0;
  return <section className="event-funnel-checkout__notice space-y-3" aria-label="Your invoices" data-testid="event-funnel-invoices">
    <h4>{total>1?'Your invoices':'Your invoice'}</h4>
    {query.isPending?<ul className="space-y-2"><InvoiceRow label="Invoice" status="preparing"/></ul>
      :query.isError?<p role="alert">{query.error.message}</p>
      :data.state==='not_applicable'?<p>No invoice payment is due.</p>:<>
        <ul className="space-y-2" aria-live="polite">
          {total===0?<InvoiceRow label="Invoice" status={data.state==='needs_review'?'attention':'preparing'}/>
            :data.invoices.map((invoice,index)=><InvoiceRow key={invoice.id}
              label={invoice.number?`Invoice ${invoice.number}`:total>1?`Invoice ${index+1} of ${total}`:'Invoice'}
              status={invoice.available?'ready':invoice.status==='needs_review'?'attention':'preparing'}>
              {invoice.available&&<Button type="button" size="sm" variant="outline" disabled={busy}
                onClick={()=>download(invoice)}>Download invoice</Button>}
            </InvoiceRow>)}
        </ul>
        {preparing&&!timedOut&&<p className="text-sm text-slate-600" data-testid="event-funnel-invoices-helper">
          Your booking is confirmed. Invoices usually take less than a minute to prepare. This list updates by itself, so you can wait here and download {total>1?'them':'it'} when ready.
        </p>}
        {timedOut&&<p className="text-sm text-slate-600" data-testid="event-funnel-invoices-helper">
          This is taking longer than usual. Your booking is confirmed. Check again in a few minutes.
        </p>}
        {(data.state==='needs_review'||data.invoices.some(invoice=>invoice.status==='needs_review'))&&<p className="text-sm text-slate-600">
          We need to check something before we can issue {total>1?'an invoice':'your invoice'}. Your booking is confirmed and we will contact you if anything is needed.
        </p>}
      </>}
    {error&&<p role="alert">{error}</p>}
    {(query.isError||timedOut)&&<Button type="button" variant="outline" disabled={query.isFetching||busy}
      onClick={()=>{started.current=Date.now();query.refetch();}}>Check invoices again</Button>}
  </section>;
}
