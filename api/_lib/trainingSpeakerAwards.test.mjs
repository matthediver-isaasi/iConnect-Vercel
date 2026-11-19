import test from 'node:test';
import assert from 'node:assert/strict';
import {processTrainingSpeakerAwards,loadTrainingSpeakerIds} from './trainingSpeakerAwards.js';
import {speakerCertificateValues} from './speakerRecognition.js';
import {stripGenericServerOwnedFields,redactSpeakerAwardSettings} from './serverOwnedEntityBoundary.js';
import {removedAgendaSpeakerIds,removedAgendaSpeakerGrants} from '../../client/src/lib/speakerAwardLifecycle.js';

test('training award mutations carry parent and tenant, never a union of speaker IDs',async()=>{
  const calls=[];
  const db={rpc:async(name,args)=>{calls.push({name,args});return {data:[]};}};
  await processTrainingSpeakerAwards(db,{tenantId:'tenant',eventId:'event',assignment:true});
  assert.deepEqual(calls,[{name:'process_training_speaker_awards',args:{p_tenant:'tenant',p_event:'event',p_assignment:true}}]);
  await assert.rejects(loadTrainingSpeakerIds({rpc:async()=>({error:{message:'unavailable'}})},'tenant','event'),/unavailable/);
  await assert.rejects(loadTrainingSpeakerIds({rpc:async()=>({data:null})},'tenant','event'),/invalid/);
});
test('new scoped certificates preserve parent meaning and use agenda activity dates without attendee points',()=>{
  const values=speakerCertificateValues({event_title:'Parent',event_start_date:'2027-03-01',event_end_date:'2027-03-03',
    event_timezone:'Europe/London',agenda_item_id:'line',agenda_description:'Second day',
    agenda_start_date:'2027-03-02T09:00:00Z',agenda_end_date:'2027-03-02T17:00:00Z',speaker_name:'Speaker'});
  assert.equal(values['event.name'],'Parent');
  assert.equal(values['event.start_date'],'2027-03-01');
  assert.equal(values['agenda.id'],'line');
  assert.equal(values['cpd.activity_title'],'Parent — Second day');
  assert.match(values['cpd.activity_date'],/2 March 2027/);
  assert.equal(values['cpd.cpd_points'],undefined);
  assert.equal(values['booking.reference'],undefined);
});
test('removing one appearance still prompts even if the same speaker remains on another line',()=>{
  const before=[{id:'a',speaker_ids:['speaker']},{id:'b',speaker_ids:['speaker']}];
  const after=[{id:'a',speaker_ids:[]},{id:'b',speaker_ids:['speaker']}];
  const grants=[{agenda_item_id:'a',speaker_id:'speaker'},{agenda_item_id:'b',speaker_id:'speaker'},{agenda_item_id:null,speaker_id:'speaker'}];
  assert.deepEqual(removedAgendaSpeakerIds(before,after),['speaker']);
  assert.deepEqual(removedAgendaSpeakerGrants(grants,after),[grants[0]]);
});
test('generic callers cannot forge readiness, completion or processing error state',()=>{
  assert.deepEqual(stripGenericServerOwnedFields('Event',{speaker_scope_ready:true,speaker_scope_attempted_at:'x',title:'Event'}),{title:'Event'});
  assert.deepEqual(stripGenericServerOwnedFields('EventAgendaItem',{speaker_awards_error:'x',speaker_awards_granted_at:'x',description:'Line'}),{description:'Line'});
  assert.deepEqual(redactSpeakerAwardSettings('EventAgendaItem',[{id:'line',speaker_award_config:{enabled:true},speaker_awards_error:'private',speaker_ids:['speaker']}]),
    [{id:'line',speaker_ids:['speaker']}]);
});
