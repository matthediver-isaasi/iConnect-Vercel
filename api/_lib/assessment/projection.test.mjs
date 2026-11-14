test('composites expose declared answers and row-specific attachment metadata only',()=>{
  const projected=reviewProjection({form_snapshot:{review_field_ids:['rows','questions','address'],fields:[
    {id:'rows',label:'Research',type:'repeatable_rows',repeatable_row:{children:[{id:'file',type:'file',label:'Paper'}]}},
    {id:'questions',type:'grouped_question',sub_questions:[{id:'abstract',label:'Abstract'}]},
    {id:'address',type:'address_lookup'}]},
    answer_snapshot:{rows:[{_row_id:'row1',file:'not exposed as a URL'}],questions:{abstract:'Submitted abstract',private:'secret'},address:{city:'London',private:'secret'}},
    attachment_manifest:[{id:'file1',field_id:'rows',cell_id:'["row1","file"]',name:'Paper.pdf'},
      {id:'wrong-row',field_id:'rows',cell_id:'["row2","file"]',name:'Private.pdf'}]});
  assert.deepEqual(projected.attachments,[{id:'file1',name:'Paper.pdf',label:'Research — Row 1 — Paper'}]);
  assert.equal(JSON.stringify(projected).includes('secret'),false);
  assert.equal(JSON.stringify(projected).includes('Submitted abstract'),true);
});
import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewProjection} from './projection.js';
test('review allowlist never exposes hidden answers or raw private URLs',()=>{
  const result=reviewProjection({
    form_snapshot:{review_field_ids:['abstract','file','nested','internal'],
      fields:[{id:'abstract',type:'textarea',label:'Abstract'},{id:'identity',type:'email'},
        {id:'file',type:'file'},{id:'nested',type:'repeatable_rows'},{id:'internal',type:'text',due_diligence:true}]},
    answer_snapshot:{abstract:'Original abstract',identity:'hidden@example.invalid',file:'https://private.invalid/file',
      nested:[{file:'secret'}],internal:'Private check'},
    attachment_manifest:[{id:'owned-file',field_id:'file',path:'secret-path',name:'Evidence.pdf'}],
  });
  assert.deepEqual(result.fields,[{id:'abstract',label:'Abstract',type:'textarea',value:'Original abstract'}]);
  assert.deepEqual(result.attachments,[{id:'owned-file',label:'Attachment',name:'Evidence.pdf'}]);
  assert.equal(JSON.stringify(result).includes('secret'),false);
});
test('missing projection configuration fails closed',()=>{
  assert.deepEqual(reviewProjection({form_snapshot:{fields:[{id:'a',type:'text'}]},answer_snapshot:{a:'private'}}),{fields:[],attachments:[]});
});
test('repeatable projections include only declared visible child answers',()=>{
  const result=reviewProjection({form_snapshot:{review_field_ids:['rows'],fields:[{id:'rows',type:'repeatable_row',
    repeatable_row:{children:[{id:'title',type:'text',label:'Title'},{id:'private',type:'text',hidden:true}]}}]},
    answer_snapshot:{rows:[{title:'Original title',private:'PRIVATE',unknown:'SECRET',storage_path:'private/file'}]}});
  assert.equal(result.fields[0].value[0],'Row 1\nTitle: Original title');
  assert.equal(JSON.stringify(result).includes('SECRET'),false);
});
