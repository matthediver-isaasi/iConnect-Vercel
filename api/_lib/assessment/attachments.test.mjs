import test from 'node:test';
import assert from 'node:assert/strict';
import {captureReviewAttachments} from './attachments.js';
const tenant='11111111-1111-4111-8111-111111111111',submission='22222222-2222-4222-8222-222222222222';
function fixture({path=`${tenant}/form-submissions/${submission}/file.pdf`,retained=false,downloadError=null}={}){
  const calls=[];
  const capture={form_snapshot:{review_field_ids:['file'],fields:[{id:'file',type:'file'},{id:'secret',type:'file'}]},
    answer_snapshot:{file:{bucket:'private-uploads',path,name:'Original.pdf'},secret:{bucket:'private-uploads',path:'private/secret'}}};
  return{calls,from(table){const q={select(){return q;},eq(){return q;},single:async()=>({data:capture}),
    maybeSingle:async()=>({data:retained?{id:'retained'}:null})};return q;},
    storage:{from(bucket){return{async download(file){calls.push(['download',bucket,file]);return{data:new Blob(['retained bytes']),error:downloadError};}};}},
    async rpc(name,args){calls.push([name,args]);return{data:{id:'file'}};},
  };
}
test('only explicitly allowed submission-owned private files are retained',async()=>{
  const db=fixture();await captureReviewAttachments(db,{tenantId:tenant,submissionId:submission});
  assert.equal(db.calls.filter(call=>call[0]==='download').length,1);
  assert.equal(db.calls[1][1].p_field,'file');
  assert.equal(db.calls[1][1].p_digest.length,64);
  await assert.rejects(captureReviewAttachments(fixture({path:'another-tenant/file.pdf'}),{tenantId:tenant,submissionId:submission}),/exact submission/);
});
test('retained bytes survive missing originals; new copy failures do not silently finalise',async()=>{
  const db=fixture({retained:true,downloadError:{code:'404'}});
  await captureReviewAttachments(db,{tenantId:tenant,submissionId:submission});
  assert.deepEqual(db.calls,[]);
  await assert.rejects(captureReviewAttachments(fixture({downloadError:{code:'404'}}),{tenantId:tenant,submissionId:submission}),/could not be retained/);
});
test('repeatable files preserve row and child provenance and never infer row positions',async()=>{
  const calls=[],path=`${tenant}/form-submissions/${submission}/evidence.pdf`;
  const capture={form_snapshot:{review_field_ids:['rows'],fields:[{id:'rows',type:'repeatable_rows',
    repeatable_row:{children:[{id:'proof',type:'file'},{id:'secret',type:'text'}]}}]},
    answer_snapshot:{rows:[{_row_id:'row-one',proof:{bucket:'private-uploads',path,name:'Evidence.pdf'},secret:'not a file'}]}};
  const db=fixture();
  db.from=()=>{const q={select(){return q;},eq(){return q;},single:async()=>({data:capture}),maybeSingle:async()=>({data:null})};return q;};
  db.rpc=async(name,args)=>{calls.push({name,args});return{data:true};};
  await captureReviewAttachments(db,{tenantId:tenant,submissionId:submission});
  assert.equal(calls.length,1);
  assert.equal(calls[0].args.p_cell,'["row-one", "proof"]');
  calls.length=0;
  await captureReviewAttachments(db,{tenantId:tenant,submissionId:submission,copyFromApplication:'application'});
  assert.equal(calls[0].name,'awards_copy_amendment_cell_files');
  delete capture.answer_snapshot.rows[0]._row_id;
  await assert.rejects(captureReviewAttachments(db,{tenantId:tenant,submissionId:submission}),/stable row/);
});
