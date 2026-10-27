export async function readMemberMonthlyChanges(db,tenantId,memberId){
  const ready=await db.rpc('monthly_change_execution_available',{});
  if(ready.error){
    if(['PGRST202','42883'].includes(ready.error.code))return {
      monthlyExecutionAvailable:false,monthlyExecutionNotice:'Monthly membership changes require the reviewed database migration.',
      monthlyChanges:[],financialExecutionAvailable:false,memberCreditExecutionAvailable:false,financialChanges:[],
    };
    throw Object.assign(new Error('Monthly membership readiness could not be checked.'),{status:503});
  }
  if(ready.data!==true)throw Object.assign(new Error('Monthly membership execution is unavailable.'),{status:503});
  const creditReady=await db.rpc('member_credit_execution_available',{});
  if(creditReady.error&&!['PGRST202','42883'].includes(creditReady.error.code)){
    throw Object.assign(new Error('Member credit readiness could not be checked.'),{status:503});
  }
  async function pages(table,columns,filters){
    const all=[];
    for(let offset=0;;offset+=500){
      let q=db.from(table).select(columns).eq('tenant_id',tenantId);
      for(const [k,v] of Object.entries(filters))q=q.eq(k,v);
      const order=table==='member_monthly_change_notification'?'operation_id':
        table==='member_change_execution'?'authority_id':'id';
      const {data,error}=await q.order(order).range(offset,offset+499);
      if(error||!Array.isArray(data))throw Object.assign(new Error('Monthly membership history could not be read.'),{status:503});
      all.push(...data);if(data.length<500)return all;
    }
  }
  const authorities=await pages('member_change_authority','id,authority,created_at',{member_id:memberId});
  const monthly=authorities.filter(row=>row.authority?.sourceSnapshot?.commitment_snapshot?.payment_frequency==='monthly');
  const upfront=authorities.filter(row=>row.authority?.sourceSnapshot?.commitment_snapshot?.payment_frequency==='upfront');
  const executions=upfront.length?await pages('member_change_execution','*',{member_id:memberId}):[];
  async function related(table){
    const rows=[];
    for(let start=0;start<executions.length;start+=100){
      const {data,error}=await db.from(table).select('*').eq('tenant_id',tenantId)
        .in('amendment_id',executions.slice(start,start+100).map(e=>e.amendment_id));
      if(error||!Array.isArray(data))throw Object.assign(new Error('Financial change history could not be read.'),{status:503});
      rows.push(...data);
    }
    return rows;
  }
  const [settlements,applications,financialNotifications]=await Promise.all([
    related('member_membership_amendment_settlement'),related('member_membership_amendment_application'),
    related('member_membership_amendment_notification'),
  ]);
  const ops=monthly.length?await pages('member_amendment_provider_operation',
    'id,operation_key,state,evidence,prepared,created_at,updated_at',{member_id:memberId}):[];
  const notifications=[];
  for(let start=0;start<ops.length;start+=100){
    const {data,error}=await db.from('member_monthly_change_notification')
      .select('operation_id,state,created_at,updated_at').eq('tenant_id',tenantId)
      .in('operation_id',ops.slice(start,start+100).map(op=>op.id));
    if(error||!Array.isArray(data))throw Object.assign(new Error('Monthly notification state could not be read.'),{status:503});
    notifications.push(...data);
  }
  return {monthlyExecutionAvailable:true,monthlyExecutionNotice:null,
    financialExecutionAvailable:true,memberCreditExecutionAvailable:!creditReady.error&&creditReady.data===true,
    financialChanges:upfront.map(row=>{
      const execution=executions.find(e=>e.authority_id===row.id);
      const settlement=settlements.find(s=>s.amendment_id===execution?.amendment_id);
      return {...row,execution:execution||null,
        settlement:settlement?{id:settlement.id,choice:settlement.choice,state:settlement.state,evidence:settlement.evidence,
          updated_at:settlement.updated_at}:null,
        application:applications.find(a=>a.amendment_id===execution?.amendment_id)||null,
        notifications:financialNotifications.filter(n=>n.amendment_id===execution?.amendment_id)
          .map(n=>({kind:n.kind,state:n.state,updated_at:n.updated_at})),
      };
    }).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))),
    monthlyChanges:monthly.map(row=>{
      const operation=ops.find(op=>op.operation_key===`monthly-change:${row.id}`);
      return {...row,operation:operation?{id:operation.id,state:operation.state,
        prepared:{quote:operation.prepared?.quote||null},
        evidence:{application:operation.evidence?.application||null},
        created_at:operation.created_at,updated_at:operation.updated_at}:null,
      notification:notifications.find(n=>n.operation_id===operation?.id)||null};
    }).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)))};
}
