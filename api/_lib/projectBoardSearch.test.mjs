import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProjectBoardSearchIndex } from './projectBoardSearch.js';

function database(rows, fail = false) {
  const calls = [];
  return { calls, from(table) {
    const call = { table }; calls.push(call);
    const q = {
      select(columns) { call.columns = columns; return q; },
      in(key, ids) { call.key = key; call.ids = ids; return q; },
      order(key) { call.order = key; return q; },
      range(start, end) { call.start = start; call.end = end; return q; },
      then(resolve) { return Promise.resolve({
        data: (rows[table] || []).filter(row => call.ids.includes(row.card_id)).slice(call.start, call.end + 1),
        error: fail ? { code: 'load_failed' } : null,
      }).then(resolve); },
    };
    return q;
  } };
}
test('search covers complete comment/activity history, human action text and names without leaking child objects', async () => {
  const db = database({
    project_card_comment: Array.from({length: 501}, (_, i) => ({id: i, card_id: 'c', content: i === 500 ? 'Historical partial keyword: a*b%' : 'Earlier'})),
    project_card_activity: [
      {id: 'a', card_id: 'c', identity_id: 'member', action_type: 'moved', action_data: {to_list: 'list'}},
      {id: 'b', card_id: 'c', action_type: 'attachment_added', action_data: {fileName: 'Agenda.pdf'}},
      {id: 'c', card_id: 'c', action_type: 'assigned', action_data: {assignee_id: 'member'}},
      {id: 'd', card_id: 'foreign', action_type: 'updated', action_data: {title: 'private elsewhere'}},
    ],
  });
  const result = await buildProjectBoardSearchIndex(db,
    [{id:'c',title:'Title',description:'Description'}], [{id:'list',name:'Ready to publish'}],
    [{identity_id:'member',first_name:'Example',last_name:'Member'}]);
  assert.equal(result.documents.length,1);
  const doc = result.documents[0];
  assert.deepEqual(Object.keys(doc),['cardId','text']);
  for(const value of ['Title','Description','Historical partial keyword: a*b%', 'moved this card','Ready to publish','Example Member','Agenda.pdf']) {
    assert.ok(doc.text.includes(value),value);
  }
  assert.ok(!doc.text.includes('private elsewhere'));
  assert.deepEqual(db.calls.filter(c=>c.table==='project_card_comment').map(c=>[c.start,c.end]),[[0,499],[500,999]]);
  for(const call of db.calls) {
    assert.deepEqual(call.ids,['c']);
    assert.equal(call.key,'card_id');
    assert.equal(call.order,'id');
  }
});
test('large boards use bounded ID batches and failures never yield a partial success', async () => {
  const cards = Array.from({length:201},(_,i)=>({id:`c${i}`}));
  const db=database({});
  const result=await buildProjectBoardSearchIndex(db,cards);
  assert.equal(result.documents.length,201);
  assert.deepEqual(db.calls.map(c=>c.ids.length),[100,100,100,100,1,1]);
  await assert.rejects(buildProjectBoardSearchIndex(database({},true),cards));
  const empty=database({});
  assert.deepEqual(await buildProjectBoardSearchIndex(empty,[]),{documents:[]});
  assert.equal(empty.calls.length,0);
});
