import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('shared confirmation renderer preserves the ordinary mailer contract and supports frozen templates',async()=>{
  const source=readFileSync(new URL('./eventConfirmationEmail.js',import.meta.url),'utf8');
  const start=source.indexOf('export async function sendConfirmationEmailsFromTemplate(');
  const end=source.indexOf('\n}',start)+2;
  const config={id:'original',subject:'Confirmed',body:'Original body'};
  const calls=[],tables=[];let offline=false;
  const db={from:table=>{
    tables.push(table);
    const q={select:()=>q,eq:()=>q,in:()=>q,
      single:async()=>({data:{id:'event',tenant_id:'tenant',is_online:!offline,is_complex:false}}),
      then:resolve=>resolve({data:[config]})};
    return q;
  }};
  const dependencies={supabase:db,sendEmail:async(...args)=>{calls.push(args);return {success:true};},
    fetchTrainingAgendaData:async()=>null,personaliseEmailZoomTargets:async()=>{},
    createEventEmailZoomResolver:()=>({}),buildSessionScheduleHtml:()=>'',buildIcsAttachment:()=>null,
    buildInboxDelivery:async()=>({}),resolveEventEmailSurvey:async(_db,c)=>c,
    replacePlaceholders:s=>s,applyAgendaPlaceholders:s=>s,parseCcField:()=>[],formatBodyAsHtml:s=>s,
    buildConfirmationQrHtml:async()=>{throw new Error('QR preparation unavailable');}};
  const render=new Function(...Object.keys(dependencies),
    `${source.slice(start,end).replace('export ','')};return sendConfirmationEmailsFromTemplate;`)(...Object.values(dependencies));
  const booking={id:'booking',attendee_email:'recipient@example.test'};
  assert.equal((await render('event',booking,null,null,null,'tenant'))[0].success,true);
  assert.equal(calls.length,1);assert.equal(calls[0].length,1);
  tables.length=0;
  let intercepted=0;
  await render('event',booking,null,null,null,'tenant',{emailConfigs:[config],send:async(payload,selected)=>{
    intercepted++;assert.equal(selected,config);assert.equal(payload.to,booking.attendee_email);
    return {success:true};
  }});
  assert.equal(intercepted,1);assert.equal(calls.length,1);
  assert.equal(tables.includes('event_email'),false);
  offline=true;
  const guarded=await render('event',booking,null,null,null,'tenant',{emailConfigs:[config],requireCheckin:true});
  assert.equal(guarded[0].success,false);assert.equal(calls.length,1);
  // Ordinary confirmation behavior stays unchanged; only the funnel opts into
  // refusing a confirmation when an applicable entrance ticket is unavailable.
  assert.equal((await render('event',booking,null,null,null,'tenant',{emailConfigs:[config]}))[0].success,true);
  assert.equal(calls.length,2);
});
