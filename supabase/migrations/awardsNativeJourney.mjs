import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';

// Existing login is a fixture seam; all awards handlers, score calculations,
// Supabase query builders, HTTP requests and domain transactions below are real.
export async function prepareNativeJourney(db,tenant,admin){
  const roles=[randomUUID(),randomUUID()],judges=[randomUUID(),randomUUID(),randomUUID()],formId=randomUUID(),eventId=randomUUID(),staffAlias=randomUUID();
  await db.query(`RESET ROLE; CREATE TABLE role(id uuid PRIMARY KEY,tenant_id uuid,excluded_features jsonb);
    ALTER DATABASE postgres SET statement_timeout='12s';
    ALTER ROLE service_role SET statement_timeout='5s';
    GRANT SELECT ON role TO service_role;
    ALTER TABLE tenant ADD COLUMN IF NOT EXISTS slug text;
    ALTER TABLE tenant ADD COLUMN IF NOT EXISTS domain text;
    ALTER TABLE form ADD COLUMN IF NOT EXISTS slug text;
    ALTER TABLE member ADD COLUMN IF NOT EXISTS first_name text;
    ALTER TABLE member ADD COLUMN IF NOT EXISTS last_name text;
    ALTER TABLE event ADD COLUMN IF NOT EXISTS status text DEFAULT 'published';
    CREATE TABLE IF NOT EXISTS tenant_user(id uuid PRIMARY KEY,tenant_id uuid,email text);
    GRANT SELECT ON tenant TO service_role`);
  await db.query("UPDATE member SET first_name='Native',last_name='Applicant' WHERE tenant_id=$1",[tenant]);
  await db.query('INSERT INTO tenant_user(id,tenant_id,email) SELECT $1,tenant_id,email FROM member WHERE id=$2',[staffAlias,admin]);
  await db.query("UPDATE tenant SET slug='native-awards-fixture' WHERE id=$1",[tenant]);
  await db.query("INSERT INTO role VALUES($1,$3,'[]'),($2,$3,'[\"admin\"]')",[...roles,tenant]);
  for(const [i,judge]of judges.entries())await db.query('INSERT INTO member(id,tenant_id,email) VALUES($1,$2,$3)',[judge,tenant,`journey-${i}@example.invalid`]);
  await db.query(`INSERT INTO form(id,tenant_id,is_active,slug,fields) VALUES($1,$2,true,'native-award-entry','[{"id":"research","type":"text","label":"Research"},{"id":"document","type":"file","label":"Supporting evidence"}]')`,[formId,tenant]);
  await db.query('INSERT INTO event(id,tenant_id) VALUES($1,$2)',[eventId,tenant]);
  await db.query('SET ROLE service_role');
  return{roles,judges,formId,eventId,staffAlias};
}

export async function runNativeJourney({db,client,tenant,admin,approver,formId,eventId,roles,judges,staffAlias}){
  process.env.ROLE_ACCESS_OVERLAY_SKIP_PRIME='1';
  const {__setRoleAccessOverlayForTests}=await import('../../api/_lib/roleVisibility.js');
  __setRoleAccessOverlayForTests([]);
  const handlers={};
  for(const path of ['awards/index','awards/rounds','awards/applications','awards/allocation','awards/shortlist','awards/invitations','awards/moderation','awards/outcomes','awards/publications','awards/advance','awards/events','awards/certificates','awards/communications','judging/index','judging/assessment','judging/conflict','judging/session','judging/attachment'])
    handlers[path]=(await import(`../../api/${path}.js`)).default;
  handlers['awards/assessment-history']=(await import('../../api/awards/assessment-history.js')).default;
  handlers['public/awards-event']=(await import('../../api/public/awards-event.js')).default;
  async function call(path,body,member=admin,query={}){
    const external=typeof member==='object';
    const response={statusCode:200,headers:{},setHeader(key,value){this.headers[key]=value;},status(code){this.statusCode=code;return this;},json(value){this.body=value;return this;},send(value){this.body=value;return this;}};
    await handlers[path]({method:body?'POST':'GET',body,query,headers:{
      'x-awards-request':'1','x-judging-request':'1','content-type':'application/json',
      ...(external?{cookie:member.cookie,'x-judging-csrf':member.csrf}:{}),
    }},response,{supabase:client,encryptionSecret:'isolated-journey-only-not-a-real-encryption-secret',rateLimitSecret:'isolated-journey-rate-limit',
      resolveTenant:async()=>({id:tenant}),getMember:async()=>external?null:({id:member,tenant_id:tenant}),
      getTenantContext:async()=>({isAuthenticated:!external,tenantId:tenant,memberId:external||member===staffAlias?null:member,
        tenantUserId:member===staffAlias?staffAlias:null,roleId:roles[[admin,approver,staffAlias].includes(member)?0:1]})});
    return response;
  }
  const ok=async(...args)=>{
    const result=await call(...args);assert.ok(result.statusCode>=200&&result.statusCode<300,`${args[0]} ${JSON.stringify(args[1])}: ${JSON.stringify(result.body)}`);
    return args[0]==='awards/index'?result.body.award:args[0]==='awards/rounds'?result.body.round:result.body;
  };
  let award=await ok('awards/index',{command:'create',payload:{name:'Native three-judge journey'}});
  const configure=async(command,payload)=>award=await ok('awards/index',{command,id:award.id,version:award.version,payload});
  await configure('bind_form',{form_id:formId,review_field_ids:['research','document']});
  await configure('configure',{opens_at:'2020-01-01T00:00:00Z',closes_at:'2099-01-01T00:00:00Z',
    retention_policy:{retention_days:365,disposal_authority:'Fixture administrator',legal_hold_policy:'Retain during legal holds'}});
  await configure('transition',{state:'open',reason:'Verified native intake'});
  const {link:eventLink}=await ok('awards/events',{payload:{award_id:award.id,event_id:eventId,show_information:true,show_application_link:true,audience:'public'}});
  const eventProjection=async()=>{
    const result=await client.rpc('awards_event_projection',{p_tenant:tenant,p_event:eventId,p_complex:false,p_audience:'public'});
    assert.equal(result.error,null,JSON.stringify(result.error));return result.data;
  };
  assert.equal((await eventProjection())[0].applicationSlug,'native-award-entry');
  const binding=(await db.query('SELECT id FROM awards_form_binding WHERE award_id=$1',[award.id])).rows[0].id;
  const submission=randomUUID();
  const filePath=`${tenant}/form-submissions/${submission}/evidence.txt`,fileBytes=Buffer.from('Retained native attachment');
  // Canonical ingestion fixture: real table/trigger, not a parallel application.
  await db.query('RESET ROLE');
  await db.query('INSERT INTO form_submission(id,tenant_id,form_id,submission_data,awards_binding_id,awards_applicant_member_id) VALUES($1,$2,$3,$4,$5,$6)',
    [submission,tenant,formId,{research:'Immutable native journey evidence',document:{bucket:'private-uploads',path:filePath,name:'Evidence.txt'}},binding,admin]);
  await db.query('SET ROLE service_role');
  await db.query('SELECT awards_capture_attachment($1,$2,$3,$4,$5,$6,$7)',
    [tenant,submission,'document',filePath,'Evidence.txt',fileBytes.toString('hex'),createHash('sha256').update(fileBytes).digest('hex')]);
  const finalised=await client.rpc('awards_finalise_intake',{p_tenant:tenant,p_submission:submission,p_binding:binding});
  assert.equal(finalised.error,null,JSON.stringify(finalised.error));
  const application=finalised.data;
  await ok('awards/applications',{applicationId:application.id,version:1,state:'eligible',reason:'Eligibility reviewed'});
  let round=await ok('awards/rounds',{command:'create',awardId:award.id,payload:{name:'Three independent judges'}});
  const roundCommand=async(command,payload)=>round=await ok('awards/rounds',{command,awardId:award.id,roundId:round.id,version:round.version,payload});
  await roundCommand('configure',{opens_at:'2020-01-01T00:00:00Z',closes_at:'2099-01-01T00:00:00Z',required_judges:3,require_all:true});
  await roundCommand('criteria',{definition:{optionalPolicy:'incomplete',criteria:[
    {id:'merit',title:'Research merit',type:'numeric',min:0,max:10,weight:100,required:true},
  ]}});
  for(const judge of judges){
    await roundCommand('appoint',{member_id:judge,role:'judge'});
    const invited=await ok('awards/invitations',{appointmentId:round.appointment_id,version:1,revoke:false,reason:'Invite the fixture panel'});
    await ok('judging/index',{appointmentId:round.appointment_id,version:invited.version,accept:true},judge);
  }
  const allocation=await ok('awards/allocation',{command:'preview',roundId:round.id,mode:'all'});
  assert.equal(allocation.assignments.length,3);
  await ok('awards/allocation',{command:'confirm',roundId:round.id,version:allocation.roundVersion,assignments:allocation.assignments});
  round.version=Number((await db.query('SELECT version FROM assessment_round WHERE id=$1',[round.id])).rows[0].version);
  await roundCommand('start',{});
  const browser=process.env.AWARDS_NATIVE_BROWSER_TEST==='1'
    ?(await import('../../scripts/test-support/awards-browser-bridge.mjs')).createAwardsBrowserBridge(call):null;
  try{
  for(const [i,judge]of judges.entries()){
    const dashboard=await ok('judging/index',null,judge);
    const assignment=dashboard.assignments.find(item=>item.roundId===round.id||item.round_id===round.id);
    assert.ok(assignment,'Assigned work appears in the real native dashboard');
    await ok('judging/conflict',{assignmentId:assignment.id,version:assignment.version,conflict:'none',reason:'No conflict declared'},judge);
    const opened=await ok('judging/assessment',null,judge,{assignmentId:assignment.id});
    const payload={assignmentId:assignment.id,expectedRevision:0,requestId:randomUUID(),submit:false,
      criteriaVersionId:opened.assignment.criteriaVersionId,applicationVersionId:opened.assignment.applicationVersionId,
      answers:{merit:{value:2+i*3}}};
    assert.equal((await call('judging/assessment',payload,judges[(i+1)%judges.length])).statusCode,403,
      'A judge cannot write another judge’s assessment');
    let draft;
    if(browser){
      await browser.assess({judge,assignmentId:assignment.id,value:2+i*3});
      const submitted=await ok('judging/assessment',null,judge,{assignmentId:assignment.id});
      assert.equal(submitted.assessment.state,'submitted');
      assert.equal(Number(submitted.assessment.answers.merit.value),2+i*3);
      draft={revision:1};
    }else{
      draft=await ok('judging/assessment',payload,judge);
      const resumed=await ok('judging/assessment',null,judge,{assignmentId:assignment.id});
      assert.deepEqual(resumed.assessment.answers,payload.answers);
      await ok('judging/assessment',{...payload,expectedRevision:draft.revision,requestId:randomUUID(),submit:true},judge);
    }
    const locked=await call('judging/assessment',{...payload,expectedRevision:draft.revision+1,requestId:randomUUID()},judge);
    assert.equal(locked.statusCode,400);
  }
  }finally{browser?.close();}
  const preview=await ok('awards/shortlist',{command:'preview',roundId:round.id,mode:'threshold',threshold:40});
  assert.equal(preview.entries.length,1);
  assert.deepEqual(preview.entries[0].officialScore,{numerator:'50',denominator:'1'});
  const before=await ok('awards/moderation',null,admin,{roundId:round.id,applicationId:application.id});
  assert.equal(before.assessments.length,3);
  const originals=before.assessments.map(a=>({id:a.revisionId,score:a.score,answers:a.answers}));
  const moderationInput={roundId:round.id,applicationId:application.id,reason:'Review the substantial panel difference'};
  const discussion=await ok('awards/moderation',{...moderationInput,command:'message',version:0});
  let proposed;
  const moderationBrowser=process.env.AWARDS_NATIVE_BROWSER_TEST==='1'
    ?(await import('../../scripts/test-support/awards-browser-bridge.mjs')).createAwardsBrowserBridge(call):null;
  try{
  if(moderationBrowser){
    await moderationBrowser.moderate({judge:admin,roundId:round.id,applicationId:application.id,tenantId:tenant,action:'propose',score:70});
    proposed=(await ok('awards/moderation',null,admin,{roundId:round.id,applicationId:application.id})).moderation;
  }else proposed=await ok('awards/moderation',{...moderationInput,command:'propose',version:discussion.version,method:'overall',overall:'70'});
  const selfApproval=await call('awards/moderation',{...moderationInput,command:'approve',version:proposed.version});
  assert.equal(selfApproval.statusCode,400);
  if(moderationBrowser)await moderationBrowser.moderate({judge:approver,roundId:round.id,applicationId:application.id,tenantId:tenant,action:'approve'});
  else await ok('awards/moderation',{...moderationInput,command:'approve',version:proposed.version},approver);
  }finally{moderationBrowser?.close();}
  const after=await ok('awards/moderation',null,admin,{roundId:round.id,applicationId:application.id});
  assert.deepEqual(after.assessments.map(a=>({id:a.revisionId,score:a.score,answers:a.answers})),originals);
  for(const state of ['recommended','confirmed']){
    const fresh=await ok('awards/shortlist',{command:'preview',roundId:round.id,mode:'threshold',threshold:60});
    assert.deepEqual(fresh.entries[0].officialScore,{numerator:'70',denominator:'1'});
    await ok('awards/shortlist',{command:'record',roundId:round.id,mode:'threshold',threshold:60,state,
      applicationIds:[application.id],fingerprints:fresh.fingerprints,reason:'Confirmed qualifying evidence'});
  }
  const {category}=await ok('awards/outcomes',{command:'category',awardId:award.id,name:'Winner',certificateEnabled:true});
  let outcome=null;
  for(const [index,state]of ['provisional','recommended','approved'].entries()){
    if(state==='approved'){
      const aliasApproval=await call('awards/outcomes',{command:'decide',awardId:award.id,roundId:round.id,applicationId:application.id,
        categoryId:category.id,expectedRevision:index,state,method:'score',reason:'Same person using team access',override:false},staffAlias);
      assert.equal(aliasApproval.statusCode,400,'Switching login modes must not bypass independent outcome approval');
    }
    const result=await ok('awards/outcomes',{command:'decide',awardId:award.id,roundId:round.id,applicationId:application.id,
      categoryId:category.id,expectedRevision:index,state,method:'score',reason:'Verified score-based outcome',override:false},
    state==='approved'?approver:admin);
    outcome=result.outcome;
  }
  const publicResults=async()=>{
    const result=await client.rpc('awards_public_outcomes',{p_tenant:tenant,p_award:award.id,p_audience:'public',p_event_link:null});
    assert.equal(result.error,null,JSON.stringify(result.error));return result.data;
  };
  assert.deepEqual(await publicResults(),[],'Approval must not expose the winner');
  assert.equal((await call('awards/outcomes',{command:'decide',awardId:award.id,roundId:round.id,applicationId:application.id,
    categoryId:category.id,expectedRevision:3,state:'approved',method:'score',reason:'Unauthorised judge approval'},judges[0])).statusCode,403);
  assert.equal((await call('awards/publications',{command:'publish',outcomeId:outcome.id,action:'publish',audience:'public',expectedRevision:0,
    projection:{title:'Not authorised'},reason:'Unauthorised judge publication'},judges[0])).statusCode,403);
  await ok('awards/publications',{command:'publish',outcomeId:outcome.id,action:'publish',audience:'public',expectedRevision:0,
    projection:{title:'Published winner',recipient:'Explicit public recipient',summary:'Approved public summary'},reason:'Authorised publication'});
  assert.equal((await publicResults()).length,1);
  assert.equal((await db.query('SELECT count(*)::int n FROM awards_delivery_release WHERE outcome_revision_id=$1',[outcome.id])).rows[0].n,0,
    'Public publication must not release recipient delivery');
  const denied=await call('awards/index',null,judges[0]);
  assert.equal(denied.statusCode,403,'An ordinary judge cannot acquire administration through an appointment');
  await ok('awards/publications',{command:'publish',outcomeId:outcome.id,action:'retract',audience:'public',expectedRevision:1,
    projection:{},reason:'Explicitly reopen selection for a subsequent round'});
  await ok('awards/outcomes',{command:'decide',awardId:award.id,roundId:round.id,applicationId:application.id,categoryId:category.id,
    expectedRevision:3,state:'reopened',method:'score',reason:'Start an additional final round without retaining a final decision',override:false});
  // A fresh round/panel uses different criteria; previous scores stay immutable.
  const firstRound=round.id;
  const shortlist=(await db.query(`SELECT id FROM assessment_shortlist_decision WHERE round_id=$1 AND application_id=$2
    AND state='confirmed' ORDER BY created_at DESC LIMIT 1`,[firstRound,application.id])).rows[0];
  round=await ok('awards/rounds',{command:'create',awardId:award.id,payload:{name:'Final external panel'}});
  await roundCommand('configure',{opens_at:'2020-01-01T00:00:00Z',closes_at:'2099-01-01T00:00:00Z',required_judges:1,require_all:true});
  await roundCommand('criteria',{definition:{optionalPolicy:'incomplete',criteria:[
    {id:'final',title:'Final presentation',type:'numeric',min:0,max:5,weight:100,required:true},
  ]}});
  await ok('awards/advance',{sourceRoundId:firstRound,targetRoundId:round.id,
    selections:[{applicationId:application.id,shortlistDecisionId:shortlist.id}],reason:'Advance confirmed candidate to a fresh panel'});
  await roundCommand('appoint',{external_email:'external-journey@example.invalid',external_name:'External fixture judge',role:'judge'});
  const externalAppointment=round.appointment_id;
  const invitation=await ok('awards/invitations',{appointmentId:externalAppointment,version:1,revoke:false,reason:'Invite external final judge'});
  const {deliverAwardsInvitations}=await import('../../api/_lib/assessment/invitationDelivery.js');
  const sent=[];
  await deliverAwardsInvitations(client,{secret:'isolated-journey-only-not-a-real-encryption-secret',
    send:async message=>{sent.push(message);return{success:true,messageId:'isolated-provider-ack'};}});
  const email=sent.find(message=>message.to==='external-journey@example.invalid');
  assert.ok(email,'The real invitation worker submits a secure email to the isolated provider fixture');
  const token=JSON.stringify(email).match(/#token=([A-Za-z0-9_-]{43})/)?.[1];
  assert.ok(token);
  const exchanged=await call('judging/session',{token,accept:true},{});
  assert.equal(exchanged.statusCode,200,JSON.stringify(exchanged.body));
  const external={cookie:exchanged.headers['Set-Cookie'].split(';')[0],csrf:exchanged.body.csrfToken};
  assert.equal((await call('judging/session',{token,accept:true},{})).statusCode,403,'Invitation redemption is single-use');
  const nextAllocation=await ok('awards/allocation',{command:'preview',roundId:round.id,mode:'all'});
  await ok('awards/allocation',{command:'confirm',roundId:round.id,version:nextAllocation.roundVersion,assignments:nextAllocation.assignments});
  round.version=Number((await db.query('SELECT version FROM assessment_round WHERE id=$1',[round.id])).rows[0].version);
  await roundCommand('start',{});
  const externalDashboard=await ok('judging/index',null,external);
  assert.equal(externalDashboard.assignments.length,1);
  const externalAssignment=externalDashboard.assignments[0];
  await ok('judging/conflict',{assignmentId:externalAssignment.id,version:externalAssignment.version,conflict:'none',reason:'No conflict'},external);
  const externalView=await ok('judging/assessment',null,external,{assignmentId:externalAssignment.id});
  const file=await call('judging/attachment',null,external,{assignmentId:externalAssignment.id,attachmentId:externalView.application.attachments[0].id,offset:'0'});
  assert.equal(file.statusCode,206);assert.equal(file.body.equals(fileBytes),true);
  const externalInput={assignmentId:externalAssignment.id,criteriaVersionId:externalView.assignment.criteriaVersionId,
    applicationVersionId:externalView.assignment.applicationVersionId,expectedRevision:0,requestId:randomUUID(),submit:false,answers:{final:{value:4}}};
  if(process.env.AWARDS_NATIVE_BROWSER_TEST==='1'){
    const externalBrowser=(await import('../../scripts/test-support/awards-browser-bridge.mjs')).createAwardsBrowserBridge(call);
    try{
      await externalBrowser.assess({judge:external,assignmentId:externalAssignment.id,value:4,criterionId:'final',
        cookie:exchanged.headers['Set-Cookie'],csrf:exchanged.body.csrfToken});
      const submitted=(await ok('judging/assessment',null,external,{assignmentId:externalAssignment.id})).assessment;
      assert.equal(submitted.state,'submitted');assert.equal(Number(submitted.answers.final.value),4);
    }finally{externalBrowser.close();}
  }else{
    await ok('judging/assessment',externalInput,external);
    assert.deepEqual((await ok('judging/assessment',null,external,{assignmentId:externalAssignment.id})).assessment.answers,externalInput.answers);
    await ok('judging/assessment',{...externalInput,expectedRevision:1,requestId:randomUUID(),submit:true},external);
  }
  assert.equal((await call('awards/index',null,external)).statusCode,401);
  const otherAssignment=(await db.query('SELECT id FROM assessment_assignment WHERE round_id=$1 LIMIT 1',[firstRound])).rows[0].id;
  assert.ok([403,404].includes((await call('judging/assessment',null,external,{assignmentId:otherAssignment})).statusCode));
  const appointmentVersion=Number((await db.query('SELECT version FROM assessment_appointment WHERE id=$1',[externalAppointment])).rows[0].version);
  await ok('awards/invitations',{appointmentId:externalAppointment,version:appointmentVersion,revoke:true,reason:'End external access'});
  assert.equal((await call('judging/index',null,external)).statusCode,401);
  const finalModeration={roundId:round.id,applicationId:application.id,reason:'Final panel justification'};
  const finalProposal=await ok('awards/moderation',{...finalModeration,command:'propose',version:0,method:'overall',overall:'85'});
  await ok('awards/moderation',{...finalModeration,command:'approve',version:finalProposal.version},approver);
  const {category:finalCategory}=await ok('awards/outcomes',{command:'category',awardId:award.id,name:'Final winner',certificateEnabled:true});
  const staleDecision=await call('awards/outcomes',{command:'decide',awardId:award.id,roundId:round.id,applicationId:application.id,
    categoryId:finalCategory.id,expectedRevision:0,state:'provisional',method:'panel',reason:'Stale version regression',override:false});
  assert.equal(staleDecision.statusCode,409,'Application conflicts must return promptly, never enter PostgREST serialization retries');
  let finalOutcome;
  for(const [expectedRevision,state]of ['provisional','recommended','approved'].entries()){
    finalOutcome=await ok('awards/outcomes',{command:'decide',awardId:award.id,roundId:round.id,applicationId:application.id,
      categoryId:finalCategory.id,expectedRevision:expectedRevision+4,state,method:'panel',reason:'Approved final panel',override:false},state==='approved'?approver:admin);
    finalOutcome=finalOutcome.outcome;
  }
  assert.deepEqual((await eventProjection())[0].outcomes,[],'Approved final winners remain confidential on event pages');
  const browserEvent=async published=>{
    if(process.env.AWARDS_NATIVE_BROWSER_TEST!=='1')return;
    const bridge=(await import('../../scripts/test-support/awards-browser-bridge.mjs')).createAwardsBrowserBridge(call);
    try{await bridge.event({eventId,published});}finally{bridge.close();}
  };
  await browserEvent(false);
  await ok('awards/publications',{command:'publish',outcomeId:finalOutcome.id,eventLinkId:eventLink.id,action:'publish',audience:'public',expectedRevision:0,
    projection:{title:'Event winner',recipient:'Native Applicant',summary:'Authorised event result'},reason:'Event release approved'});
  assert.equal((await eventProjection())[0].outcomes.length,1);
  await browserEvent(true);
  await ok('awards/communications',{command:'configure',awardId:award.id,category:'winner',enabled:true,version:0});
  const message={command:'schedule',awardId:award.id,category:'winner',applicationId:application.id,outcomeId:finalOutcome.id,
    requestId:randomUUID(),dueAt:new Date(Date.now()-1000).toISOString(),reason:'Authorised recipient notification'};
  assert.equal((await call('awards/communications',message)).statusCode,409,'Public event publication alone cannot send a winner email');
  await ok('awards/publications',{command:'release',outcomeId:finalOutcome.id,reason:'Authorise winner notification'});
  await ok('awards/communications',message);
  const {deliverAwardMessages}=await import('../../api/_lib/assessment/messageDelivery.js');
  const delivered=[];
  for(let batch=0;batch<5&&!delivered.length;batch++)await deliverAwardMessages(client,{
    send:async envelope=>{delivered.push(envelope);return{success:true,messageId:'isolated-winner-provider-ack'};},
    secret:'isolated-journey-only-not-a-real-encryption-secret'});
  assert.equal(delivered.length,1);
  assert.ok(delivered[0].html.includes('Final winner'));
  const deliveryRow=(await db.query("SELECT state FROM awards_delivery WHERE award_id=$1 AND category='winner'",[award.id])).rows[0];
  assert.equal(deliveryRow.state,'delivered');
  await deliverAwardMessages(client,{send:async()=>{throw new Error('A delivered winner message must never be replayed');}});
  const {PDFDocument}=await import('pdf-lib');
  const templateDocument=await PDFDocument.create();templateDocument.addPage([600,400]);
  const templateBytes=await templateDocument.save(),sourcePath=`${tenant}/awards-certificate-template/native.pdf`;
  Object.defineProperty(client,'storage',{configurable:true,value:{from(bucket){
    assert.equal(bucket,'private-uploads');
    return{async download(path){assert.equal(path,sourcePath);return{data:new Blob([templateBytes],{type:'application/pdf'}),error:null};}};
  }}});
  const {template}=await ok('awards/certificates',{command:'template',name:'Native award certificate',revision:0,sourcePath,
    placeholders:[{placeholder_key:'recipient.name',page_number:1,x:20,y:20,width:250,height:40,font_size:12}]});
  const certificateRequest={command:'preview',outcomeId:finalOutcome.id,templateId:template.id};
  const previewPdf=await ok('awards/certificates',certificateRequest);
  assert.equal((await PDFDocument.load(previewPdf)).getPageCount(),1);
  if(process.env.AWARDS_NATIVE_BROWSER_TEST==='1'){
    const bridge=(await import('../../scripts/test-support/awards-browser-bridge.mjs')).createAwardsBrowserBridge(call);
    try{await bridge.certificate({judge:admin,tenantId:tenant,template,outcome:finalOutcome});}finally{bridge.close();}
  }
  const issued=await ok('awards/certificates',{...certificateRequest,command:'issue',approved:true,reason:'Approve final award certificate generation'});
  assert.equal(issued.sent,false);assert.equal(issued.delivery,'unchanged');
  if(process.env.AWARDS_NATIVE_BROWSER_TEST==='1')assert.equal(issued.replayed,true,'A browser-issued PDF is retained on a later retry');
  const earlier=await ok('awards/moderation',null,admin,{roundId:firstRound,applicationId:application.id});
  assert.deepEqual(earlier.assessments.map(a=>({id:a.revisionId,score:a.score,answers:a.answers})),originals);
  assert.equal((await db.query('SELECT count(*)::int n FROM member WHERE email=$1',['external-journey@example.invalid'])).rows[0].n,0);
  return{awardId:award.id,roundId:round.id,applicationId:application.id};
}
