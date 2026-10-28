// Read-only campaign and provider investigation; output contains private recipient data.
import fs from 'node:fs/promises';
import {connectDestination} from './annual-meeting-destination.mjs';
const id='4dd7b474-b8f3-47ca-b035-04099f73bce0',tenant='fd82da65-aab7-4a5c-85b8-b2febeb2003d';
const dir='generated-artifacts/gfi-fast-track-evidence';
await fs.mkdir(dir,{recursive:true,mode:0o700});
const db=await connectDestination();
let rows;
try{
 await db.query('BEGIN READ ONLY');
 const c=(await db.query('SELECT id FROM email_campaign WHERE id=$1 AND tenant_id=$2',[id,tenant])).rows;
 if(c.length!==1)throw Error('Campaign scope mismatch');
 rows=(await db.query(`SELECT r.id,r.member_id,r.email,r.first_name,r.last_name,r.status,r.created_at,
 r.sent_at,r.mailgun_message_id,r.delivery_is_test,r.error_message,
 (SELECT count(*)::int FROM email_event e WHERE e.campaign_id=r.campaign_id
 AND (e.recipient_id=r.id OR lower(e.email)=lower(r.email))) local_event_count
 FROM email_campaign_recipient r WHERE r.campaign_id=$1 AND r.status='processing' ORDER BY lower(r.email)`,[id])).rows;
 await db.query('ROLLBACK');
}finally{await db.end();}
if(rows.length!==145)throw Error('Unresolved population changed; review before export');
const lookup=new Map(rows.map(r=>[r.email.toLowerCase(),r]));
const matched=new Map(rows.map(r=>[r.id,[]]));
const uncorrelated=new Map(rows.map(r=>[r.id,0]));
const uncorrelatedDetails=[];
const begin='2026-10-26T13:25:00Z',end=new Date().toISOString();
const base='https://api.eu.mailgun.net/v3/mail.graduatefutures.org/events';
let url=new URL(base);
for(const[k,v]of Object.entries({begin:Date.parse(begin)/1000,end:Date.parse(end)/1000,ascending:'yes',limit:300}))url.searchParams.set(k,v);
let complete=false,scanned=0,pages=0;
for(;pages<150;pages++){
 if(url.origin!=='https://api.eu.mailgun.net'||!(url.pathname===new URL(base).pathname
  ||url.pathname.startsWith(`${new URL(base).pathname}/`)))throw Error('Unexpected pagination');
 const response=await fetch(url,{headers:{Authorization:`Basic ${Buffer.from(`api:${process.env.MAILGUN_EVENTS_API_KEY}`).toString('base64')}`},signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw Error(`Provider evidence read failed ${response.status}`);
 const result=await response.json();if(!Array.isArray(result.items))throw Error('Malformed provider response');
 scanned+=result.items.length;
 for(const event of result.items){
  const row=lookup.get(event.recipient?.toLowerCase());if(!row)continue;
  if(event['user-variables']?.iconn_campaign_id===id)matched.get(row.id).push({
   type:event.event,time:new Date(event.timestamp*1000).toISOString(),id:event.id,
   isTest:event.flags?.['is-test-mode'],messageId:event.message?.headers?.['message-id']||null,
  });
  else if(!event['user-variables']?.iconn_campaign_id){
   uncorrelated.set(row.id,uncorrelated.get(row.id)+1);
   uncorrelatedDetails.push({recipient_id:row.id,email:row.email,type:event.event,
    time:new Date(event.timestamp*1000).toISOString(),provider_event_id:event.id,
    subject:event.message?.headers?.subject||null,message_id:event.message?.headers?.['message-id']||null,
    is_test:event.flags?.['is-test-mode']??null});
  }
 }
 if(!result.items.length||!result.paging?.next){complete=true;break;}
 url=new URL(result.paging.next);
}
if(!complete)throw Error('Provider scan incomplete; no final report produced');
const fields=['recipient_id','member_id','first_name','last_name','email','status','recipient_created_utc',
 'sent_at_utc','mailgun_message_id','send_provenance','local_campaign_events','mailgun_campaign_events',
 'mailgun_campaign_event_types','uncorrelated_provider_events','assessment'];
const records=rows.map(r=>[
 r.id,r.member_id,r.first_name,r.last_name,r.email,r.status,r.created_at.toISOString(),r.sent_at?.toISOString(),
 r.mailgun_message_id,r.delivery_is_test===null?'Not recorded':r.delivery_is_test?'Test':'Live',
 r.local_event_count,matched.get(r.id).length,[...new Set(matched.get(r.id).map(e=>e.type))].join('; '),
 uncorrelated.get(r.id),matched.get(r.id).length?'Campaign provider evidence found — review required':'No campaign send or provider event found; submission remains unverified',
]);
const cell=v=>`"${String(v??'').replaceAll('"','""').replace(/^[=+@-]/,"'$&")}"`;
await fs.writeFile(`${dir}/145-recipient-review.csv`,[fields,...records].map(r=>r.map(cell).join(',')).join('\r\n'),{mode:0o600});
const summary={campaign:'Fast Track - 26 October 2026',campaignId:id,checkedAt:end,
 providerWindow:{begin,end,complete,eventsScanned:scanned,pages:pages+1},recipients:rows.length,
 linkedMembers:rows.filter(r=>r.member_id).length,withoutMember:rows.filter(r=>!r.member_id).length,
 withLocalEvents:rows.filter(r=>r.local_event_count>0).length,
 withCampaignProviderEvents:rows.filter(r=>matched.get(r.id).length).length,
 recipientsWithUncorrelatedEvents:rows.filter(r=>uncorrelated.get(r.id)).length,
 note:'Other or uncorrelated events are not proof this campaign was sent. Absence is not a guaranteed non-submission. No emails sent or campaign records changed.'};
await fs.writeFile(`${dir}/evidence-summary.json`,JSON.stringify(summary,null,2),{mode:0o600});
await fs.writeFile(`${dir}/uncorrelated-events.json`,JSON.stringify(uncorrelatedDetails,null,2),{mode:0o600});
console.log(JSON.stringify(summary));
