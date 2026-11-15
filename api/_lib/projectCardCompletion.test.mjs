import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';

let role, card, activities, writes, allowed;
globalThis.__completionDb = { from(table) {
  let update, insert;
  const q = {
    select() { return q; }, eq() { return q; }, single() { return q; },
    update(value) { update = value; return q; },
    insert(value) { insert = value; return q; },
    then(resolve) {
      let data;
      if (table === 'project_board_member') data = role ? { role } : null;
      if (table === 'project_card') {
        if (update) { writes++; card = { ...card, ...update }; }
        data = card;
      }
      if (table === 'project_card_activity') activities.push(insert);
      return Promise.resolve({data, error:null}).then(resolve);
    },
  };
  return q;
} };
globalThis.__completionAllowed = () => allowed;
const output = await build({
  entryPoints:['api/projects/cards/[cardId].js'], bundle:true, write:false,
  platform:'node', format:'cjs', packages:'external', logLevel:'silent',
  plugins:[{name:'completion-isolation', setup(b) {
    b.onLoad({filter:/\/_lib\/database\.js$/}, () => ({contents:'export const supabase=globalThis.__completionDb;'}));
    b.onLoad({filter:/\/_lib\/session\.js$/}, () => ({contents:'export const getSession=async()=>({data:{identityId:"actor"}});'}));
    b.onLoad({filter:/\/_lib\/salesLinkedProjectGuard\.js$/}, () => ({
      contents:'export const guardSalesLinkedProject=async(req,res)=>{if(globalThis.__completionAllowed())return true;res.status(403).json({error:"Denied"});return false;};',
    }));
  }}],
});
const mod = new Module(`${process.cwd()}/completion-test.cjs`);
mod.filename = `${process.cwd()}/completion-test.cjs`;
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(output.outputFiles[0].text, mod.filename);
function reset() {
  role = 'member'; allowed = true; activities = []; writes = 0;
  card = {id:'card', board_id:'board', list_id:'list', title:'Saved title',
    description:'Saved description', due_date:'2026-12-01', is_complete:false};
}
async function patch(body) {
  const res = {statusCode:200, setHeader() {}, status(n) {this.statusCode=n;return this;},
    json(body) {this.body=body;return this;}};
  await mod.exports.default({method:'PATCH',headers:{},query:{cardId:'card'},body},res);
  return res;
}
test('completion and reopening preserve unrelated fields and retain timestamp, actor and activity behavior', async () => {
  reset();
  const before = { ...card };
  assert.equal((await patch({is_complete:true})).statusCode,200);
  assert.equal(card.is_complete,true);
  assert.equal(card.completed_by,'actor');
  assert.ok(Number.isFinite(Date.parse(card.completed_at)));
  assert.equal(activities[0].action_type,'completed');
  assert.equal(activities[0].identity_id,'actor');
  for (const key of ['title','description','due_date','list_id']) assert.equal(card[key],before[key]);
  await patch({title:'Later title'});
  assert.equal(card.is_complete,true);
  await patch({is_complete:false});
  assert.equal(card.is_complete,false);
  assert.equal(card.completed_at,null);
  assert.equal(card.completed_by,null);
  assert.equal(activities.at(-1).action_type,'reopened');
});
test('viewer, nonmember and linked-project denial cannot complete or reopen cards', async () => {
  for (const membership of ['viewer', null, 'member']) for (const is_complete of [true,false]) {
    reset(); role = membership; allowed = membership !== 'member';
    assert.equal((await patch({is_complete})).statusCode,403);
    assert.equal(writes,0); assert.equal(activities.length,0);
  }
});
