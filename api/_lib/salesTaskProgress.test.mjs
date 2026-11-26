import test from 'node:test';
import assert from 'node:assert/strict';
import { createSalesReportsHandler } from '../sales/reports/index.js';
import { parseSalesReportQuery } from './salesReports.js';

const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const summary = { opportunityCount: 13, availableOpportunities: 12, restrictedOpportunities: 1,
  unavailableOpportunities: 0, totalTasks: 1101, openTasks: 1000, completedTasks: 101, overdueTasks: 12,
  completionPercent: 9.2, partial: true };
function fixture({ denied = [], context = {}, error = null, identity = uid(3), admin = false } = {}) {
  const rpcs = [], reads = [];
  const db = {
    from(table) {
      const filters = {};
      const q = {
        select(columns) { reads.push({table,columns,filters}); return q; },
        eq(key,value) { filters[key] = value; return q; },
        async maybeSingle() { return { data: {identity_id:identity}, error:null }; },
      };
      return q;
    },
    async rpc(name,args) {
      rpcs.push({name,args});
      return { error, data:error ? null : {items:[{id:uid(9),status:'restricted',totalTasks:null}],summary,
        total:13,page:args.p_page,pageSize:args.p_size,pages:2} };
    },
  };
  const handler = createSalesReportsHandler({ db,
    getTenantContext:async()=>({isAuthenticated:true,tenantId:uid(1),memberId:uid(2),roleId:'role',...context}),
    hasFeatureAccess:async(_role,key)=>!denied.includes(key),
    hasAdminAccess:async()=>admin,
    loadSalesReportData:async()=>{throw Error('Task progress must not load financial or raw task data');},
  });
  const send = async (query={}) => {
    const res = {headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}};
    await handler({method:'GET',query:{view:'task-progress',...query}},res);
    return res;
  };
  return {send,rpcs,reads};
}
test('progress handler uses authenticated actor and independent pagination, not request authority or close filters',async()=>{
  const f=fixture();
  const result=await f.send({taskProgressPage:'2',taskProgressPageSize:'10',expectedCloseFrom:'2030-01-01',
    p_admin:true,p_identity:uid(99),tenantId:uid(99)});
  assert.equal(result.statusCode,200);
  assert.equal(result.headers['Cache-Control'],'private, no-store');
  assert.deepEqual(f.rpcs,[{name:'sales_opportunity_task_progress',args:{
    p_tenant:uid(1),p_actor:uid(2),p_kind:'member',p_admin:false,p_identity:uid(3),
    p_projects:true,p_page:2,p_size:10,
  }}]);
  assert.deepEqual(result.body.summary,summary);
  assert.equal(result.body.items[0].totalTasks,null);
  assert.ok(f.reads.every(r=>r.filters.tenant_id===uid(1)));
});
test('baseline and dashboard permissions independently gate progress; Projects denial is passed without widening access',async()=>{
  for (const denied of [['sales.dashboard'],['sales.view']]) {
    const f=fixture({denied});
    const r=await f.send();
    assert.equal(r.statusCode,403);
    assert.equal(f.rpcs.length,0);
  }
  for (const opts of [{denied:['projects.board-view']},{identity:null}]) {
    const f=fixture(opts),r=await f.send();
    assert.equal(r.statusCode,200);
    assert.equal(f.rpcs[0].args.p_projects,opts.denied?false:true);
    assert.equal(f.rpcs[0].args.p_identity,opts.identity===null?null:uid(3));
  }
  const unauth=fixture({context:{isAuthenticated:false}});
  assert.equal((await unauth.send()).statusCode,401);
  assert.equal(unauth.rpcs.length,0);
});
test('staff progress uses the active principal and separately checked board identity',async()=>{
  const f=fixture({context:{tenantUserId:uid(5)},admin:true});
  assert.equal((await f.send()).statusCode,200);
  assert.equal(f.rpcs[0].args.p_kind,'tenant_user');
  assert.equal(f.rpcs[0].args.p_actor,uid(5));
  assert.equal(f.rpcs[0].args.p_admin,true);
  assert.equal(f.rpcs[0].args.p_identity,uid(3));
});
test('progress failures remain retryable errors, never zero totals',async()=>{
  for (const code of ['PGRST202','42883','42703','XX000']) {
    const f=fixture({error:{code,message:'private database detail'}});
    const r=await f.send();
    assert.equal(r.statusCode,503);
    assert.equal(r.body.summary,undefined);
    assert.doesNotMatch(r.body.error,/private database detail/);
  }
});
test('progress pagination is bounded and validated before database reads',async()=>{
  for (const query of [{taskProgressPage:'0'},{taskProgressPage:'1.5'},{taskProgressPage:'1000001'},
    {taskProgressPageSize:'101'},{taskProgressPageSize:'0'},{taskProgressPage:'Infinity'}]) {
    const f=fixture();
    assert.equal((await f.send(query)).statusCode,400);
    assert.equal(f.rpcs.length,0);
  }
  assert.equal(parseSalesReportQuery({view:'task-progress'}).taskProgressPageSize,10);
});
