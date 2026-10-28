import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../_lib/tenantContext.js';
import { AMENDMENT_UUID, createMemberAmendmentsService } from '../_lib/memberAmendments.js';
import { createMemberChangeAuthorityService } from '../_lib/memberChangeAuthority.js';
import { createMemberChangeAuthorityResolver } from '../_lib/memberChangeAuthorityResolver.js';
import { createMemberChangeExecutionService } from '../_lib/memberChangeExecution.js';
import { createMemberMonthlyChangeExecution } from '../_lib/memberMonthlyChangeExecution.js';
import { readMemberMonthlyChanges } from '../_lib/memberMonthlyChangeRead.js';
import {listMemberCreditExpiryReviews,reviewMemberCreditExpiry} from '../_lib/memberCreditExpiryReview.js';
import {createMemberReplacementExecutionService} from '../_lib/memberReplacementExecution.js';
import {MEMBER_REPLACEMENT_PROTOCOL,replacementLifecycle} from '../_lib/memberReplacementRead.js';
import {createMemberChangeFormSettings} from '../_lib/memberChangeFormSettings.js';
import {createMemberCancellationFinance} from '../_lib/memberCancellationFinance.js';

export function createMemberAmendmentsHandler({
  db = supabase, getContext = getTenantContext, isAdmin = hasAdminAccess,
  hasFinance = hasFeatureAccess, service = null, authorityService = null, executionService = null,
  monthlyExecutionService = null,replacementExecutionService=null,cancellationFinanceService=null,
} = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    try {
      const context = await getContext(req);
      if (!context?.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
      if (context.tenantMismatch) return res.status(409).json({ error: 'Tenant context mismatch' });
      if (!context.tenantId || !await isAdmin(context)) return res.status(403).json({ error: 'Tenant admin access required' });
      // Tenant-account administrators without a member role follow the existing
      // monthly-finance gate; role-bearing accounts also need finance visibility.
      if ((!context.tenantUserId && !context.roleId)
          || (context.roleId && !await hasFinance(context.roleId, 'commerce.monthly-finance-report', context.memberExcludedFeatures || []))) {
        return res.status(403).json({ error: 'Membership finance permission required' });
      }
      const actorId = context.tenantUserId || context.memberId;
      if(req.method==='GET'&&req.query?.action==='credit_expiry_reviews'){
        return res.json(await listMemberCreditExpiryReviews(db,context.tenantId,req.query.after));
      }
      if(req.method==='POST'&&req.body?.action==='review_credit_expiry'){
        return res.json(await reviewMemberCreditExpiry(db,context.tenantId,actorId,req.body));
      }
      if (!actorId) return res.status(403).json({ error: 'An authenticated audit identity is required' });
      if((req.method==='GET'?req.query?.action:req.body?.action)==='form_change_settings'){
        const settings=createMemberChangeFormSettings({db});
        return res.json(req.method==='GET'
          ?await settings.read(context.tenantId,req.query.formId)
          :await settings.save(context.tenantId,actorId,req.body));
      }
      const amendments = service || createMemberAmendmentsService({ db });
      if(req.method==='GET'&&req.query?.action==='cancellation_finances'){
        if(!AMENDMENT_UUID.test(req.query.memberId||'')||(req.query.after&&!AMENDMENT_UUID.test(req.query.after))){
          return res.status(400).json({error:'Valid member and pagination identifiers are required'});
        }
        let query=db.from('member_cancellation_request')
          .select('id,financial_state,effective_date,timing,access_ended_at')
          .eq('tenant_id',context.tenantId).eq('member_id',req.query.memberId)
          .not('access_ended_at','is',null).order('id').limit(51);
        if(req.query.after)query=query.gt('id',req.query.after);
        const {data,error}=await query;
        if(error||!Array.isArray(data))return res.status(503).json({error:'Cancellation financial history could not be loaded'});
        return res.json({records:data.slice(0,50),nextCursor:data.length>50?data[49].id:null});
      }
      if(req.method==='POST'&&['preview_cancellation_finance','confirm_cancellation_finance','recover_cancellation_finance'].includes(req.body?.action)){
        if(!AMENDMENT_UUID.test(req.body.memberId||'')||!AMENDMENT_UUID.test(req.body.requestId||'')){
          return res.status(400).json({error:'Valid member and cancellation identifiers are required'});
        }
        const finance=cancellationFinanceService||createMemberCancellationFinance({db});
        const actor={tenantId:context.tenantId,memberId:req.body.memberId,actorId,actorKind:'admin'};
        const {requestId,choice,expectedFingerprint,approve}=req.body;
        if(req.body.action==='preview_cancellation_finance')return res.json(await finance.preview(actor,requestId,{choice}));
        if(req.body.action==='confirm_cancellation_finance'){
          if(approve!==true||!/^[a-f0-9]{64}$/i.test(expectedFingerprint||'')){
            return res.status(400).json({error:'Explicit approval and the current preview fingerprint are required'});
          }
          return res.json(await finance.confirm(actor,requestId,{choice,expectedFingerprint,approve:true}));
        }
        // Recovery resumes an existing approval only. Never accept browser
        // operation limits, balances, provider IDs, or financial treatment.
        return res.json(await finance.recover(actor,requestId));
      }
      if(req.method==='POST' && ['execute_change','resume_change'].includes(req.body?.action)) {
        if(!AMENDMENT_UUID.test(req.body?.memberId||'') || !AMENDMENT_UUID.test(req.body?.authorityId||'')) {
          return res.status(400).json({error:'Valid memberId and authorityId are required'});
        }
        const {data:saved,error}=await db.from('member_change_authority').select('authority')
          .eq('tenant_id',context.tenantId).eq('member_id',req.body.memberId)
          .eq('id',req.body.authorityId).maybeSingle();
        if(error) return res.status(503).json({error:'Confirmed membership authority could not be read'});
        if(!saved) return res.status(404).json({error:'Confirmed membership authority not found'});
        const monthly=saved.authority?.sourceSnapshot?.commitment_snapshot?.payment_frequency==='monthly';
        if(!monthly&&saved.authority?.calculation?.behaviour==='new_term'){
          const ready=await db.rpc('member_replacement_execution_available',{p_protocol:MEMBER_REPLACEMENT_PROTOCOL});
          if(ready.error||ready.data!==true)return res.status(503).json({error:'Replacement execution requires the reviewed database release.'});
          const actor={tenantId:context.tenantId,memberId:req.body.memberId,actorId,actorKind:'admin'};
          const service=replacementExecutionService||createMemberReplacementExecutionService({db});
          const result=await service[req.body.action==='execute_change'?'execute':'resume'](actor,
            {...req.body,choice:req.body.settlementChoice});
          return res.json(replacementLifecycle(saved.authority,result));
        }
        if(monthly){
          const ready=await db.rpc('monthly_change_execution_available',{});
          if(ready.error||ready.data!==true)return res.status(503).json({error:'Monthly membership execution requires the reviewed database migration.'});
        }
        const execution=monthly
          ? monthlyExecutionService || createMemberMonthlyChangeExecution({db})
          : executionService || createMemberChangeExecutionService({db});
        const actor={tenantId:context.tenantId,memberId:req.body.memberId,actorId,actorKind:'admin'};
        return res.json(await execution[req.body.action==='execute_change'?'execute':'resume'](actor,req.body));
      }
      if(req.method==='POST' && ['preview_change','confirm_change','recover_change'].includes(req.body?.action)) {
        if(!AMENDMENT_UUID.test(req.body?.memberId||'')) return res.status(400).json({error:'A valid memberId is required'});
        const authority=authorityService || createMemberChangeAuthorityService({
          db,resolve:createMemberChangeAuthorityResolver({db,amendments}),
        });
        const actor={tenantId:context.tenantId,memberId:req.body.memberId,actorId,actorKind:'admin'};
        if(req.body.action==='preview_change') return res.json(await authority.preview(actor,req.body.selection));
        if(req.body.action==='recover_change') {
          const record=await authority.recover(actor,{key:req.body.idempotencyKey,fingerprint:req.body.fingerprint});
          return res.status(record?200:404).json({record,executionEnabled:false});
        }
        return res.json({record:await authority.confirm(actor,{
          selection:req.body.selection,fingerprint:req.body.fingerprint,key:req.body.idempotencyKey,
        }),executionEnabled:false});
      }
      if (req.method === 'GET') {
        if (!AMENDMENT_UUID.test(req.query?.memberId || '')) return res.status(400).json({ error: 'A valid memberId is required' });
        const [existing,monthly]=await Promise.all([
          amendments.list(context.tenantId,req.query.memberId),
          readMemberMonthlyChanges(db,context.tenantId,req.query.memberId),
        ]);
        return res.json({...existing,...monthly});
      }
      if (req.body?.action === 'preview') return res.json(await amendments.preview(context.tenantId, req.body));
      if (req.body?.action === 'create') {
        const result = await amendments.create(context.tenantId, actorId, req.body);
        return res.status(result.replayed ? 200 : 201).json(result);
      }
      if (['settle', 'reconcile', 'apply', 'notify'].includes(req.body?.action)) {
        if (!AMENDMENT_UUID.test(req.body.amendmentId || '')) return res.status(400).json({ error: 'A valid amendmentId is required' });
        return res.json(await amendments[req.body.action](context.tenantId, actorId, req.body));
      }
      return res.status(400).json({ error: 'action must be preview, create, settle, reconcile, apply or notify' });
    } catch (error) {
      if(error.status===429&&Number.isFinite(Number(error.retryAfter))){
        res.setHeader('Retry-After',String(Math.max(1,Math.min(86400,Math.ceil(Number(error.retryAfter))))));
      }
      return res.status(error.status || 500).json({
        error: error.status ? error.message : 'Membership amendment request failed',
        code: error.code || 'internal_error',
      });
    }
  };
}

export default createMemberAmendmentsHandler();
