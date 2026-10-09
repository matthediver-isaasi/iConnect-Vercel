import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';

let cards;
globalThis.__moveOrderDb = { from(table) {
  const filters = [];
  let patch, single = false;
  const q = {
    select() { return q; }, update(value) { patch = value; return q; },
    insert() { return q; },
    eq(key,value) { filters.push(row => row[key]===value); return q; },
    neq(key,value) { filters.push(row => row[key]!==value); return q; },
    gt(key,value) { filters.push(row => row[key]>value); return q; },
    gte(key,value) { filters.push(row => row[key]>=value); return q; },
    lt(key,value) { filters.push(row => row[key]<value); return q; },
    lte(key,value) { filters.push(row => row[key]<=value); return q; },
    single() { single=true; return q; },
    then(resolve) {
      const rows=table==='project_card' ? cards.filter(row=>filters.every(f=>f(row)))
        : table==='project_board_member' ? [{role:'member'}] : [];
      if(patch) rows.forEach(row=>Object.assign(row,patch));
      return Promise.resolve({data:single ? (rows[0] ? {...rows[0]} : null) : rows.map(row=>({...row})),error:null}).then(resolve);
    },
  };
  return q;
} };
const output=await build({
  entryPoints:['api/projects/cards/[cardId]/move.js'],bundle:true,write:false,
  format:'cjs',platform:'node',packages:'external',logLevel:'silent',
  plugins:[{name:'move-order',setup(b){
    b.onLoad({filter:/\/_lib\/database\.js$/},()=>({contents:'export const supabase=globalThis.__moveOrderDb;'}));
    b.onLoad({filter:/\/_lib\/session\.js$/},()=>({contents:'export const getSession=async()=>({data:{identityId:"actor"}});'}));
    b.onLoad({filter:/\/_lib\/salesLinkedProjectGuard\.js$/},()=>({contents:'export const guardSalesLinkedProject=async()=>true;'}));
  }}],
});
const mod=new Module(`${process.cwd()}/move-order-test.cjs`);
mod.filename=`${process.cwd()}/move-order-test.cjs`;
mod.paths=Module._nodeModulePaths(process.cwd());
mod._compile(output.outputFiles[0].text,mod.filename);
test('moving forwards and backwards preserves intermediate hidden-card ordering and unique positions',async()=>{
  for(const [moving,to,expected] of [
    ['a',3,['hidden-1','hidden-2','b','a','c']],
    ['c',1,['a','c','hidden-1','hidden-2','b']],
  ]) {
    cards=['a','hidden-1','hidden-2','b','c'].map((id,position)=>({id,position,list_id:'list',board_id:'board'}));
    const res={statusCode:200,setHeader(){},status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}};
    await mod.exports.default({method:'POST',headers:{},query:{cardId:moving},body:{list_id:'list',position:to}},res);
    assert.equal(res.statusCode,200);
    assert.deepEqual([...cards].sort((a,b)=>a.position-b.position).map(c=>c.id),expected);
    assert.equal(new Set(cards.map(c=>c.position)).size,5);
  }
});
