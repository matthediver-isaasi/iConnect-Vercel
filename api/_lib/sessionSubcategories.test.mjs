import test from 'node:test';
import assert from 'node:assert/strict';
import { listSessionCategories, validateSessionCategoryIds, resolveSessionCategories, guardGenericSessionCategories } from './sessionSubcategories.js';
const A = '00000000-0000-0000-0000-000000000001';
const B = '00000000-0000-0000-0000-000000000002';
const bone = `${A}:Bone`, brain = `${A}:Brain`, otherBone = `${B}:Bone`;
const viewer = { roleId: 'limited' };
function fixture() {
  const rows = [
    { id: A, tenant_id: 'tenant', name: 'Focus', subcategories: ['Bone', 'Brain'], subcategory_excluded_role_ids: { Brain: ['limited'] } },
    { id: B, tenant_id: 'other', name: 'Foreign', subcategories: ['Bone'] },
  ];
  let failure = false;
  return { rows, fail: () => { failure = true; }, db: { from() {
    const filters = []; let start = 0, end = Infinity;
    const q = { select() { return q; }, eq(k,v) { filters.push(r=>r[k]===v); return q; },
      in(k,v) { filters.push(r=>v.includes(r[k])); return q; }, order() { return q; },
      range(a,b) { start=a;end=b;return q; },
      then(resolve) { resolve({ data: failure ? null : rows.filter(r=>filters.every(f=>f(r))).slice(start,end+1), error: failure ? new Error('Lookup failed') : null }); } };
    return q;
  } } };
}
test('catalogue contains only selectable children with parent context and no policy fields', async () => {
  const f=fixture();
  const options=await listSessionCategories(f.db,'tenant',viewer);
  assert.deepEqual(options.map(o=>[o.id,o.name,o.category_name]),[[bone,'Bone','Focus']]);
  assert.ok(!JSON.stringify(options).includes('excluded_role'));
});
test('subcategory validation rejects parents, foreign children, missing names and restricted additions', async () => {
  const f=fixture();
  for(const key of [A,otherBone,`${A}:Unknown`,brain,`${A}:`]) {
    await assert.rejects(validateSessionCategoryIds(f.db,'tenant',[key],[],viewer),{status:400});
  }
  assert.deepEqual(await validateSessionCategoryIds(f.db,'tenant',[bone,bone],[],viewer),[bone]);
});
test('limited editors preserve hidden and unavailable assignments while privileged editors can clear', async () => {
  const f=fixture();
  assert.deepEqual(await validateSessionCategoryIds(f.db,'tenant',[],[bone,brain],viewer),[brain]);
  f.rows[0].subcategories=[];
  assert.deepEqual(await validateSessionCategoryIds(f.db,'tenant',[],[bone,brain],viewer),[bone,brain]);
  assert.deepEqual(await validateSessionCategoryIds(f.db,'tenant',[],[bone,brain],{isPrivileged:true}),[]);
});
test('public badges use subcategory names only and never legacy parent assignments', async () => {
  const f=fixture();
  const [row]=await resolveSessionCategories(f.db,'tenant',[{id:'s',subcategory_keys:[bone,brain],category_ids:[A]}],{isGuest:true});
  assert.deepEqual(row,{id:'s',categories:[{id:bone,name:'Bone',category_name:'Focus'}]});
  f.rows[0].subcategories=['Brain'];
  assert.deepEqual((await resolveSessionCategories(f.db,'tenant',[{subcategory_keys:[bone]}],viewer))[0].categories,[]);
});
test('duplicate child names remain scoped to their parent and failures fail closed', async () => {
  const f=fixture();f.rows[1].tenant_id='tenant';
  f.rows[0].excluded_role_ids=['limited'];
  assert.deepEqual((await listSessionCategories(f.db,'tenant',viewer)).map(o=>o.id),[otherBone]);
  await assert.rejects(validateSessionCategoryIds(f.db,'tenant',[bone],[],viewer));
  f.fail();
  await assert.rejects(resolveSessionCategories(f.db,'tenant',[{subcategory_keys:[bone]}],viewer),/Lookup failed/);
});
test('generic projections and inference cannot expose subcategory keys', () => {
  const res={status(){return this;},json(value){this.value=value;}};
  assert.equal(guardGenericSessionCategories({query:{filter:{subcategory_keys:[brain]}}},res,'complexeventsession'),true);
  guardGenericSessionCategories({query:{}},res,'complexeventsession');
  res.json({rows:[{id:'s',subcategory_keys:[brain],category_ids:[A]}]});
  assert.deepEqual(res.value,{rows:[{id:'s'}]});
});
