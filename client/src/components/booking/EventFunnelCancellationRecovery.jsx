import React, {useEffect, useRef, useState} from 'react';
import {adminFetch} from '@/lib/adminFetch';

const labels={reserved:'Queued',processing:'Processing',retry:'Waiting to retry',needs_review:'Needs attention',
  complete:'Complete',released:'Released',not_applicable:'Not needed'};
const legLabels={card:'Card refund',training:'Training fund',voucher:'Voucher',credit:'Accounting credit',
  cleanup:'Booking access and notifications'};
export default function EventFunnelCancellationRecovery({orderId}){
  const [open,setOpen]=useState(false),[state,setState]=useState({busy:false,operations:[],error:null});
  const [now,setNow]=useState(Date.now),controller=useRef(null);
  async function load(action='list',operationId,signal=controller.current?.signal){
    if(!signal||signal.aborted)return;
    setState(previous=>({...previous,busy:true,error:null}));
    try{
      const response=await adminFetch('/api/event-funnels/reversals',{method:'POST',credentials:'include',signal,
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({action,orderId,...(operationId?{operationId}:{})})});
      const data=await response.json();
      if(!response.ok)throw new Error(data.error||'Cancellation recovery could not be loaded.');
      if(!Array.isArray(data.operations))throw new Error('Cancellation recovery returned an invalid response.');
      if(!signal.aborted)setState({busy:false,operations:data.operations,error:null});
    }catch(error){
      if(!signal.aborted)setState(previous=>({...previous,busy:false,error:error.message}));
    }
  }
  useEffect(()=>{
    if(!open)return;
    const current=new AbortController();controller.current=current;
    setState({busy:true,operations:[],error:null});
    load('list',undefined,current.signal);
    const timer=setInterval(()=>setNow(Date.now()),1000);
    return ()=>{current.abort();clearInterval(timer);controller.current=null;};
  },[open,orderId]);
  return <div className="text-xs" onClick={event=>event.stopPropagation()}>
    <button type="button" className="underline text-primary" aria-expanded={open}
      onClick={()=>setOpen(value=>!value)}>Cancellation recovery</button>
    {open&&<div role="region" aria-label="Shared checkout cancellation recovery" className="mt-2 space-y-2 rounded border p-3">
      <p>Only previously approved cancellations can be reconciled here. This does not change refund amounts or cancel another booking.</p>
      <button type="button" className="underline" disabled={state.busy} onClick={()=>load()}>Refresh status</button>
      {state.busy&&<p role="status">Checking cancellation recovery…</p>}
      {state.error&&<p role="alert">{state.error}</p>}
      {!state.busy&&!state.error&&!state.operations.length&&<p>No recorded cancellations for this checkout.</p>}
      {state.operations.map((operation,index)=><div key={operation.id} className="border-t pt-2">
        <p title={operation.id}>Cancellation {index+1}: <strong>{labels[operation.state]||'Status unavailable'}</strong></p>
        {operation.cancelledAt&&<p>Accepted {new Date(operation.cancelledAt).toLocaleString()}</p>}
        <ul>{Object.entries(operation.outcomes||{}).map(([key,status])=><li key={key}>
          {legLabels[key]||key}: {labels[status]||'Status unavailable'}
        </li>)}</ul>
        {!['complete','released'].includes(operation.state)&&<>
          {Date.parse(operation.nextAttemptAt)>now&&<p>Eligible for retry after {new Date(operation.nextAttemptAt).toLocaleString()}.</p>}
          <button type="button" className="underline text-primary"
            disabled={state.busy||Date.parse(operation.nextAttemptAt)>now}
            onClick={()=>load('retry',operation.id)}>Retry reconciliation</button>
        </>}
      </div>)}
    </div>}
  </div>;
}
