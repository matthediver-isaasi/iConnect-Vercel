import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverPopupFields } from './cmsPopupAudience.js';
import { validatePopupGroups } from '../../shared/cmsPopupContract.js';

test('role names are labelled tenant-scoped IDs and custom choices survive discovery', async () => {
  const roleId = '5be10af3-cfd9-4e25-80c9-886e804314da';
  const rows = { role: [{id:roleId,name:'Super Admin'}], organization: [],
    preference_field:[{id:'custom',label:'Region',field_type:'dropdown',entity_scope:'member',options:[{value:'N',label:'North'}]}] };
  const filters=[];
  const db={from(table){
    const q={then(resolve){return Promise.resolve({data:rows[table],count:rows[table].length}).then(resolve);}};
    for(const op of ['select','eq','in','order','range']) q[op]=(...args)=>{filters.push([table,op,...args]);return q;};
    return q;
  }};
  const fields=await discoverPopupFields(db,'tenant',{choices:true});
  assert.deepEqual(fields.member.core.find(f=>f.key==='role_id').options,[{value:roleId,label:'Super Admin'}]);
  assert.deepEqual(fields.member.custom[0].options,[{value:'N',label:'North'}]);
  assert.ok(filters.some(([t,op,k,v])=>t==='role'&&op==='eq'&&k==='tenant_id'&&v==='tenant'));
  const rule={entity_scope:'member',field_type:'core',field_key:'role_id',data_type:'text',operator:'equals',value:roleId};
  assert.doesNotThrow(()=>validatePopupGroups([{conditions:[rule]}],fields));
  assert.throws(()=>validatePopupGroups([{conditions:[{...rule,value:'Super Admin'}]}],fields),/Choose a member role/);
});
