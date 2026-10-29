import React, {useEffect, useRef, useState} from "react";
import {Button} from "@/components/ui/button";
import {cpdRegistrationKey} from "@/lib/cpdPointsReplay";

const certificateEndpoint="/api/reports/attendee-cpd-certificate";
async function request(url,body,signal){
  const response=await fetch(url,{credentials:"include",signal,...(body?{
    method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}:{})});
  const data=await response.json();
  if(!response.ok) throw new Error(data.error||"The action could not be completed.");
  return data;
}

// Kept separate from the delivery review: PDF inspection never supplies send
// consent, an award override, or a delivery request ID.
function CertificatePdfPreview({registration,disabled}){
  const [attempt,setAttempt]=useState(0);
  const [state,setState]=useState({loading:false,url:"",error:""});
  useEffect(()=>{
    if(!attempt)return;
    const controller=new AbortController();
    let url="";
    setState({loading:true,url:"",error:""});
    const load=async()=>{
      try{
        const identity={booking_id:registration.booking_id,booking_source:registration.booking_source};
        const meta=await request(`${certificateEndpoint}?${new URLSearchParams(identity)}`,null,controller.signal);
        if(controller.signal.aborted)return;
        if(!meta.available)throw new Error(meta.reason||"This attendee's certificate is unavailable.");
        if(!meta.fingerprint)throw new Error("Certificate details are incomplete. Retry the preview.");
        const response=await fetch(certificateEndpoint,{
          method:"POST",credentials:"include",signal:controller.signal,
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify({...identity,action:"preview",expected_fingerprint:meta.fingerprint}),
        });
        if(!response.ok){
          const data=await response.json().catch(()=>({}));
          throw new Error(data.error||"The certificate PDF could not be prepared.");
        }
        if(!response.headers.get("Content-Type")?.includes("application/pdf"))
          throw new Error("The server did not return a certificate PDF. Retry the preview.");
        const blob=await response.blob();
        if(controller.signal.aborted)return;
        url=URL.createObjectURL(blob);
        setState({loading:false,url,error:""});
      }catch(e){
        if(!controller.signal.aborted)setState({loading:false,url:"",error:e.message});
      }
    };
    load();
    return()=>{controller.abort();if(url)URL.revokeObjectURL(url);};
  },[attempt,registration.booking_id,registration.booking_source]);
  return <div className="space-y-2">
    <Button type="button" variant="outline" disabled={disabled||state.loading} onClick={()=>setAttempt(n=>n+1)}>
      {state.error?"Retry certificate PDF preview":state.url?"Refresh certificate PDF preview":"Preview certificate PDF"}
    </Button>
    {state.loading&&<div role="status" className="rounded border bg-muted/40 p-4 text-sm">Preparing the selected attendee&apos;s PDF…</div>}
    {state.error&&<p role="alert" className="text-sm text-destructive">{state.error}</p>}
    {state.url&&<div className="space-y-2">
      <iframe title={`CPD certificate PDF — ${registration.attendee_name||"Unnamed attendee"}`} src={state.url} className="h-[45vh] min-h-64 w-full rounded border"/>
      <a href={state.url} target="_blank" rel="noopener noreferrer" className="text-sm underline">Open selected attendee&apos;s PDF in a new tab</a>
    </div>}
  </div>;
}

// Explicit second confirmation: points are committed by the worker before
// current certificate/recipient fingerprints are reviewed. Never auto-send on
// preview, checkbox changes, or points-job completion.
export default function CpdFollowUpActions({registrations,ready,onBusyChange}){
  const [options,setOptions]=useState({badges:false,badgeEmail:false,certificate:false});
  const [busy,setBusy]=useState(false);
  const [deliveries,setDeliveries]=useState(null);
  const [outcomes,setOutcomes]=useState([]);
  const [badgeRuns,setBadgeRuns]=useState([]);
  const [error,setError]=useState("");
  const [selectedRegistration,setSelectedRegistration]=useState("");
  const active=useRef(false);
  const alive=useRef(true);
  const badgeRequests=useRef(new Map());
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const run=async work=>{
    if(active.current||!ready)return;
    active.current=true;setBusy(true);onBusyChange?.(true);setError("");
    try{await work();}catch(e){if(alive.current)setError(e.message);}
    finally{active.current=false;if(alive.current){setBusy(false);onBusyChange?.(false);}}
  };
  const recheck=()=>run(async()=>{
    setDeliveries(null);
    const results=[];
    const runs=[];
    for(const row of registrations){
      if(!alive.current)break;
      const key=`${row.booking_source}:${row.booking_id}`;
      if(!badgeRequests.current.has(key))badgeRequests.current.set(key,crypto.randomUUID());
      try{
        const result=await request("/api/admin/event-cpd-badge-replay",{
          event_id:row.event_id,event_type:row.booking_source==="standard"?"simple":"complex",
          booking_id:row.booking_id,request_id:badgeRequests.current.get(key),confirmed:true
        });
        results.push(`${row.attendee_name||"Unnamed attendee"}: ${result.enqueued_count||0} badge checks queued.`);
        runs.push({row,replayId:result.replay_id,complete:result.enqueued_count===0});
      }catch(e){results.push(`${row.attendee_name||"Unnamed attendee"}: ${e.message}`);}
      if(alive.current)setOutcomes([...results]);
    }
    if(alive.current)setBadgeRuns(runs);
  });
  const checkBadges=()=>run(async()=>{
    const results=[];
    const runs=[];
    for(const item of badgeRuns){
      if(!alive.current)return;
      const state=await request(`/api/admin/event-cpd-badge-replay?${new URLSearchParams({
        event_id:item.row.event_id,event_type:item.row.booking_source==="standard"?"simple":"complex",
        booking_id:item.row.booking_id,replay_id:item.replayId
      })}`);
      runs.push({...item,complete:state.complete,failed:state.failed});
      results.push(`${item.row.attendee_name||"Unnamed attendee"}: ${state.failed?"Check failed — administrator review required":state.complete?"Badge checks complete (existing awards are preserved)":"Badge checks pending"}.`);
    }
    if(alive.current){setBadgeRuns(runs);setOutcomes(results);}
  });
  const preview=()=>run(async()=>{
    setDeliveries(null);
    const list=[];
    for(const row of registrations){
      for(const kind of ["badge","attendee"]){
        if(!alive.current)return;
        if(kind==="badge"?!options.badgeEmail:!options.certificate)continue;
        const identity={booking_id:row.booking_id,booking_source:row.booking_source,
          ...(kind==="badge"?{notification_kind:"badge"}:{})};
        try{
          const meta=await request(`${certificateEndpoint}?${new URLSearchParams(identity)}`);
          list.push({identity,kind,meta,requestId:crypto.randomUUID(),name:row.attendee_name});
        }catch(e){list.push({identity,kind,name:row.attendee_name,meta:{can_send:false,send_reason:e.message}});}
      }
    }
    if(alive.current)setDeliveries(list);
  });
  const send=()=>run(async()=>{
    // Keep the same request IDs and fingerprints after an uncertain response.
    for(const item of deliveries){
      if(!alive.current)break;
      if(!item.meta.can_send||item.sent||item.error)continue;
      try{
        const result=await request(certificateEndpoint,{...item.identity,action:"send",confirmed:true,
          deliberate_resend:true,request_id:item.requestId,expected_fingerprint:item.meta.fingerprint});
        item.sent=result.success===true;
        if(!item.sent)item.error=result.error||"Email was not accepted.";
      }catch(e){item.error=`${e.message} Check delivery history before retrying.`;}
      if(alive.current)setDeliveries([...deliveries]);
    }
  });
  const change=(key,value)=>{setOptions(o=>({...o,[key]:value}));setDeliveries(null);};
  const pdfRegistration=registrations.find(row=>cpdRegistrationKey(row)===selectedRegistration)||registrations[0];
  return <section className="space-y-3 border-t pt-4" aria-label="Optional CPD follow-up actions">
    <h3 className="font-semibold">Optional badge and certificate actions</h3>
    <p className="text-sm text-muted-foreground">Applies to these {registrations.length} reviewed registrations only. Points and attendance are not changed by these controls. Complete any points reprocessing first, then review the emails before sending. Keep this window open until each requested batch finishes.</p>
    {!ready&&<p className="text-sm">Waiting for points processing to finish. Resolve any failed points jobs before sending certificates.</p>}
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={options.badges} disabled={busy||!ready} onChange={e=>change("badges",e.target.checked)}/>Recheck missing badge awards</label>
    {options.badges&&<div className="space-y-2">
      <p className="text-xs text-muted-foreground">Uses the saved badge rules and verified attendance. Existing badges are not duplicated. This queues checks, not emails; allow the background worker to finish before reviewing badge notifications.</p>
      <Button type="button" variant="outline" disabled={busy||!ready} onClick={recheck}>Confirm badge recheck</Button>
      {badgeRuns.length>0&&<Button type="button" variant="outline" disabled={busy||!ready} onClick={checkBadges}>Check badge progress</Button>}
      {outcomes.length>0&&<div role="status" className="max-h-36 overflow-auto text-sm">{outcomes.map((text,i)=><p key={i}>{text}</p>)}</div>}
    </div>}
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={options.badgeEmail} disabled={busy||!ready} onChange={e=>change("badgeEmail",e.target.checked)}/>Send/resend badge notification emails</label>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={options.certificate} disabled={busy||!ready} onChange={e=>change("certificate",e.target.checked)}/>Send/resend CPD certificate emails</label>
    {options.certificate&&<div className="space-y-3 rounded border bg-muted/20 p-3" aria-label="Certificate PDF preview">
      <h4 className="text-sm font-medium">Inspect an attendee&apos;s certificate</h4>
      <p className="text-xs text-muted-foreground">Read-only PDF preview. Does not award points or send emails. Previewing is separate from reviewing recipients and confirming send/resend.</p>
      {registrations.length>1&&<label className="block space-y-1 text-sm">
        <span>Attendee for PDF preview</span>
        <select className="block w-full rounded border bg-background p-2" value={pdfRegistration?cpdRegistrationKey(pdfRegistration):""} disabled={busy} onChange={e=>setSelectedRegistration(e.target.value)}>
          {registrations.map(row=><option key={cpdRegistrationKey(row)} value={cpdRegistrationKey(row)}>{row.attendee_name||"Unnamed attendee"}</option>)}
        </select>
      </label>}
      {pdfRegistration&&<p className="text-xs text-muted-foreground">Selected: {pdfRegistration.attendee_name||"Unnamed attendee"}</p>}
      {ready&&pdfRegistration?<CertificatePdfPreview key={cpdRegistrationKey(pdfRegistration)} registration={pdfRegistration} disabled={busy}/>:<p className="text-sm">PDF preview is unavailable until points processing is ready and a registration is available.</p>}
    </div>}
    {(options.badgeEmail||options.certificate)&&<>
      <p className="text-xs text-muted-foreground">Uses the email template selected in each event&apos;s CPD configuration. Badge-only emails have no PDF attachment: check that the selected template is suitable. Selecting both email options sends two separate emails per eligible attendee.</p>
      <Button type="button" variant="outline" disabled={busy||!ready||(options.badgeEmail&&badgeRuns.some(r=>!r.complete&&!r.failed))} onClick={preview}>Review recipients and eligibility</Button>
      {options.badgeEmail&&badgeRuns.some(r=>!r.complete&&!r.failed)&&<p className="text-sm">Check badge progress before reviewing the notification recipients.</p>}
    </>}
    {busy&&<p role="status" className="text-sm">Processing… Keep this window open.</p>}
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
    {deliveries&&<div className="space-y-3">
      <div className="max-h-64 overflow-auto text-sm space-y-2">{deliveries.map((item,i)=><div key={i} className="border-b pb-2">
        <strong>{item.name||item.meta.attendee_name||"Unnamed attendee"}</strong> · {item.kind==="badge"?"Badge notification":"CPD certificate"}
        <p>{item.meta.recipient||"No recipient"} · {item.meta.email_template_name||"Default certificate email"}</p>
        <p>{item.sent?"Accepted by email provider":item.error||(!item.meta.can_send?(item.meta.send_reason||item.meta.reason||"Unavailable"):"Ready — this may resend a previous email")}</p>
      </div>)}</div>
      <Button type="button" disabled={busy||!ready||!deliveries.some(d=>d.meta.can_send&&!d.sent&&!d.error)} onClick={send}>
        Confirm send/resend to {deliveries.filter(d=>d.meta.can_send&&!d.sent&&!d.error).length} eligible email deliveries
      </Button>
    </div>}
  </section>;
}
