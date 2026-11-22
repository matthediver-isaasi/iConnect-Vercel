import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../_lib/tenantContext.js';
import { DEFAULT_LIFECYCLE_POLICY, LIFECYCLE_CAPABILITIES, validateLifecyclePolicy,
  evaluateMemberLifecycle } from '../../shared/memberLifecyclePolicy.mjs';
import { lifecycleRows, loadMemberLifecycleEvidence } from '../_lib/memberLifecycleEvidence.js';
import { LIFECYCLE_REVIEW_ACTIONS, lifecycleUuid, lifecycleReviewDetail,
  loadLifecycleMember, recordLifecycleDecision } from '../_lib/memberLifecycleReview.js';
import { lifecycleRuntimeReady, runtimeLifecyclePreview } from '../_lib/memberLifecycleRuntime.js';
import { executeLifecycleTransition } from '../_lib/memberLifecycleExecution.js';
import { previewLifecyclePrivacy, applyLifecyclePrivacy } from '../_lib/memberLifecyclePrivacy.js';

export const LIFECYCLE_READINESS_ISSUES = Object.freeze([
  'Automatic transitions and disposal are not ready. Non-destructive review decisions are available.',
  'Existing membership-expiry role/login changes need a shared execution boundary.',
  'Complete attendance, CPD and genuine tenant-scoped login evidence must be connected and verified.',
  'Outstanding obligations, legal holds and field-level minimisation require complete verification.',
  'Atomic renewal-safe execution, notifications and operational visibility integration remain outstanding.',
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const mutationCapability = {
  resolve_notice: 'review',
  resolve_cleanup: 'minimise',
  record_evidence: 'review',
  preview: 'configure', approve: 'configure', pause: 'configure',
  retain: 'review', release_hold: 'review', extend: 'review', exempt: 'review', clear_exemption: 'review',
  archive: 'archive', restore: 'archive', minimise_preview: 'minimise', minimise: 'minimise',
  delete_preview: 'delete', delete: 'delete',
};

export function createMemberLifecycleHandler({
  db = supabase, getContext = getTenantContext, isAdmin = hasAdminAccess,
  featureAccess = hasFeatureAccess, readRows = lifecycleRows, loadEvidence = loadMemberLifecycleEvidence,
} = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!['GET', 'PUT', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
    try {
      const context = await getContext(req);
      if (!context?.isAuthenticated) fail('Authentication required', 401);
      if (context.tenantMismatch) fail('Tenant context mismatch', 409);
      if (!context.tenantId || !await isAdmin(context)) fail('Administrator access required', 403);
      if (!db) fail('Database unavailable', 503);
      const actor = context.tenantUserId ? `tenant_user:${context.tenantUserId}`
        : context.memberId ? `member:${context.memberId}` : null;
      if (!actor) fail('Authenticated audit identity required', 403);
      const permissions = {};
      for (const resource of LIFECYCLE_CAPABILITIES) {
        // Preserve the established verified tenant-user admin bypass. Portal
        // member-role administrators must pass each dedicated capability.
        permissions[resource.split('.').at(-1)] = !!context.tenantUserId
          || await featureAccess(context.roleId, resource, context.memberExcludedFeatures || []);
      }
      if (!permissions.view) fail('Archive Review access required', 403);
      const tenantId = context.tenantId;
      const readPolicy = async () => {
        const { data, error } = await db.from('member_lifecycle_policy')
          .select('policy,revision,enabled').eq('tenant_id', tenantId).maybeSingle();
        if (error) throw error;
        return data || { policy: { ...DEFAULT_LIFECYCLE_POLICY }, revision: 0, enabled: false };
      };
      const settings = async () => {
        const saved = await readPolicy();
        const ready = await lifecycleRuntimeReady(db);
        let runtime;
        if (ready) {
          const result = await db.from('member_lifecycle_runtime').select('last_run_at,last_error,next_run_at').eq('tenant_id', tenantId).maybeSingle();
          if (result.error) throw result.error;
          runtime = { lastRunAt: result.data?.last_run_at || null, paused: !saved.enabled,
            lastError: result.data?.last_error || null, nextRunAt: result.data?.next_run_at || null };
        }
        const roles = (await readRows(db, 'role', tenantId)).filter(role => role.is_active !== false && !role.is_tenant_admin)
          .map(role => ({ id: role.id, name: role.name || role.id }));
        return { ...saved, roles, permissions, runtime, reviewReady: true, executionReady: ready,
          readinessIssues: ready ? [] : LIFECYCLE_READINESS_ISSUES };
      };
      if (req.method === 'GET') {
        if (req.query?.section === 'cleanup') {
          if (!permissions.minimise && !permissions.delete) fail('Privacy review permission required',403);
          const { data,error } = await db.from('member_lifecycle_cleanup')
            .select('id,member_id,kind,state,reason,created_at,resource_reference').eq('tenant_id',tenantId)
            .eq('state','needs_review').order('created_at').order('id').limit(100);
          if(error || !Array.isArray(data))throw error || new Error('Cleanup queue unavailable');
          return res.json({items:data.map(row=>({id:row.id,memberId:row.member_id,kind:row.kind,state:row.state,
            reason:row.reason,createdAt:row.created_at,referenceLabel:storageReferenceLabel(row.resource_reference)})),limited:data.length===100});
        }
        if (req.query?.section === 'operations') {
          const { data, error } = await db.from('member_lifecycle_operation')
            .select('id,member_id,action,status,reason,created_at,role_delivery,delivery_error').eq('tenant_id', tenantId)
            .order('created_at', { ascending: false }).order('id').limit(100);
          if (error || !Array.isArray(data)) throw error || new Error('Operation history unavailable');
          const notices=await db.from('member_lifecycle_notice').select('id,member_id,outcome_code,created_at')
            .eq('tenant_id',tenantId).eq('status','needs_review').order('created_at',{ascending:false}).order('id').limit(100);
          if(notices.error || !Array.isArray(notices.data))throw notices.error || new Error('Notification history unavailable');
          const items=[...data.map(row => ({
            id: row.id, memberId: row.member_id, action: row.action,
            status: row.role_delivery==='needs_review'||row.delivery_error?'needs_attention':row.status,
            reason: row.role_delivery==='needs_review'?`${row.reason}; role workflow requires reconciliation`
              :row.delivery_error?`${row.reason}; ${row.delivery_error}`:row.reason, createdAt: row.created_at,
          })),...notices.data.map(row=>({id:row.id,memberId:row.member_id,action:'notification',
            status:'needs_attention',reason:row.outcome_code,createdAt:row.created_at}))];
          items.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
          return res.json({ items:items.slice(0,100), limited: data.length === 100 || notices.data.length===100 || items.length>100 });
        }
        if (req.query?.section === 'review') {
          const cursor = req.query.cursor || null;
          if (cursor && !lifecycleUuid(cursor)) fail('Invalid review cursor');
          const { data, error } = await db.rpc('member_lifecycle_review_page', { p_tenant_id: tenantId, p_cursor: cursor });
          if (error) throw error;
          if (!data || !Array.isArray(data.items)) throw new Error('Review unavailable');
          return res.json(data);
        }
        if (req.query?.section === 'detail') {
          const saved = await readPolicy();
          return res.json(await lifecycleReviewDetail(db, tenantId, req.query.memberId,
            validateLifecyclePolicy(saved.policy), { readRows, loadEvidence, expiryCoordinated: await lifecycleRuntimeReady(db) }));
        }
        if (req.query?.section && req.query.section !== 'settings') {
          fail('Unknown lifecycle section');
        }
        return res.json(await settings());
      }
      const action = req.method === 'PUT' ? 'configure' : mutationCapability[req.body?.action];
      if (!action) fail('Unknown lifecycle action');
      if (!permissions[action] && !(req.body?.action==='resolve_cleanup' && permissions.delete)) {
        fail('You do not have permission for this lifecycle action', 403);
      }
      if (req.method === 'POST' && req.body?.action === 'record_evidence') {
        const body = req.body;
        if (!lifecycleUuid(body.memberId) || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0
          || !['membership', 'portal_login'].includes(body.source)
          || typeof body.reference !== 'string' || !body.reference.trim() || body.reference.trim().length > 2000) {
          fail('A member, current revision and documented evidence reference are required');
        }
        const saved = await readPolicy();
        const detail = await lifecycleReviewDetail(db, tenantId, body.memberId, saved.policy, { readRows, loadEvidence });
        if (detail.revision !== body.expectedRevision) fail('Member review changed; reload', 409);
        let evidence;
        if (body.source === 'membership') {
          if (detail.evidence.membershipRows !== 0 || !detail.evidence.membershipFingerprint) {
            fail('Existing or unavailable membership history must be resolved at its source, not overridden', 409);
          }
          if (!['former', 'never'].includes(body.historyKind)
            || (body.historyKind === 'former' && !/^\d{4}-\d{2}-\d{2}$/.test(body.graceEndDate || ''))) {
            fail('Select verified history and provide the grace end date for former members');
          }
          evidence = { historyKind: body.historyKind,
            graceEndDate: body.historyKind === 'former' ? body.graceEndDate : null,
            fingerprint: detail.evidence.membershipFingerprint };
        } else {
          if (detail.evidence.activity?.portal_login?.source !== 'member_lifecycle_login_evidence') {
            fail('Login capture must be available before historical coverage can be reviewed', 409);
          }
          if (body.lastOccurredAt && !/^\d{4}-\d{2}-\d{2}$/.test(body.lastOccurredAt)) fail('Invalid login occurrence date');
          evidence = { lastOccurredAt: body.lastOccurredAt || null };
        }
        const { data, error } = await db.rpc('member_lifecycle_record_evidence', {
          p_tenant_id: tenantId, p_member_id: body.memberId, p_revision: body.expectedRevision,
          p_source: body.source, p_evidence: { ...evidence, reference: body.reference.trim() }, p_actor: actor,
        });
        if (error) throw error;
        return res.json({ memberId: body.memberId, revision: data.revision });
      }
      if (req.method === 'POST' && LIFECYCLE_REVIEW_ACTIONS.has(req.body?.action)) {
        return res.json(await recordLifecycleDecision(db, tenantId, actor, req.body));
      }
      if (req.method === 'PUT') {
        const policy = validateLifecyclePolicy(req.body?.policy);
        const revision = req.body?.expectedRevision;
        if (!Number.isSafeInteger(revision) || revision < 0) fail('A valid settings revision is required');
        const { error } = await db.rpc('save_member_lifecycle_policy', {
          p_tenant_id: tenantId, p_expected_revision: revision, p_policy: policy, p_actor: actor,
        });
        if (error) throw error;
        return res.json(await settings());
      }
      if (req.body.action !== 'preview') {
        if (await lifecycleRuntimeReady(db)) {
          const saved = await readPolicy();
          if(req.body.action==='resolve_notice'){
            if(!lifecycleUuid(req.body.noticeId)||!['sent','retry'].includes(req.body.resolution)
              ||req.body.confirmation!==(req.body.resolution==='sent'?'VERIFIED DELIVERY':'VERIFIED NOT SENT')
              ||typeof req.body.reason!=='string'||!req.body.reason.trim()||req.body.reason.length>2000)fail('Verified notification outcome required');
            const {data,error}=await db.rpc('member_lifecycle_resolve_notice',{p_tenant_id:tenantId,p_id:req.body.noticeId,p_actor:actor,
              p_resolution:req.body.resolution,p_reason:req.body.reason.trim(),p_confirmation:req.body.confirmation});
            if(error)throw error;
            return res.json(data);
          }
          if(req.body.action==='resolve_cleanup'){
            if(!lifecycleUuid(req.body.cleanupId)||req.body.confirmation!=='VERIFIED REMOVED'
              ||typeof req.body.reason!=='string'||!req.body.reason.trim()||req.body.reason.length>2000)fail('Verified removal and documented reason required');
            const {data,error}=await db.rpc('member_lifecycle_resolve_cleanup',{p_tenant_id:tenantId,p_id:req.body.cleanupId,
              p_actor:actor,p_reason:req.body.reason.trim(),p_confirmation:req.body.confirmation});
            if(error)throw error;
            return res.json(data);
          }
          if (['approve', 'pause'].includes(req.body.action)) {
            if (req.body.expectedRevision !== saved.revision
              || (req.body.action === 'approve' && (!lifecycleUuid(req.body.previewId) || req.body.confirmed !== true))) {
              fail('Explicit acknowledgement and a current complete preview are required', 409);
            }
            const { error } = await db.rpc('member_lifecycle_control', {
              p_tenant_id: tenantId, p_actor: actor, p_revision: saved.revision,
              p_action: req.body.action, p_preview_id: req.body.previewId || null,
            });
            if (error) throw error;
            return res.json(await settings());
          }
          if (['archive', 'restore'].includes(req.body.action)) {
            return res.json(await executeLifecycleTransition(db, { tenantId, actor, saved, body: req.body }));
          }
          if (['minimise_preview','delete_preview'].includes(req.body.action)) {
            return res.json(await previewLifecyclePrivacy(db,{tenantId,actor,saved,body:req.body}));
          }
          if (['minimise','delete'].includes(req.body.action)) {
            return res.json(await applyLifecyclePrivacy(db,{tenantId,actor,body:req.body}));
          }
        }
        fail('Lifecycle execution is not ready. No member records were changed. Configuration and read-only previews are available.', 409);
      }
      const saved = await readPolicy();
      if (!saved.revision) fail('Save the draft configuration before previewing', 409);
      const policy = validateLifecyclePolicy(saved.policy);
      const cursor = req.body.cursor || null, previewId = req.body.previewId || null;
      if ((cursor && !uuid.test(cursor)) || (previewId && !uuid.test(previewId)) || (!!cursor !== !!previewId)) {
        fail('Invalid preview continuation');
      }
      if (await lifecycleRuntimeReady(db)) return res.json(await runtimeLifecyclePreview(db, tenantId, actor, saved, req.body, { readRows, loadEvidence }));
      // Check ownership/revision BEFORE querying any continuation members.
      if (previewId) {
        const { data, error } = await db.from('member_lifecycle_preview').select('*')
          .eq('tenant_id', tenantId).eq('id', previewId).eq('created_by', actor).maybeSingle();
        if (error) throw error;
        if (!data || data.complete || data.cursor !== cursor || data.policy_revision !== saved.revision
          || new Date(data.expires_at) <= new Date()) fail('Preview expired or changed; start again', 409);
      }
      let query = db.from('member').select('id,tenant_id,role_id,organization_id,membership_paused,membership_cancelled')
        .eq('tenant_id', tenantId).order('id').limit(11);
      if (cursor) query = query.gt('id', cursor);
      const { data: members, error } = await query;
      if (error || !Array.isArray(members)) throw error || new Error('Invalid preview source');
      const roles = await readRows(db, 'role', tenantId);
      const items = [];
      for (const member of members.slice(0, 10)) {
        const loaded = await loadLifecycleMember(db, tenantId, member.id);
        const evidence = await loadEvidence(db, tenantId, loaded.member, policy);
        const proposal = evaluateMemberLifecycle({ tenantId, member: loaded.member, evidence, policy, roles });
        // No names/contact data in durable preview items or response.
        items.push({ memberId: member.id, ...proposal, unavailableSources: evidence.unavailableSources || [] });
      }
      const next = items.at(-1)?.memberId || cursor;
      const { data, error: saveError } = await db.rpc('member_lifecycle_preview_page', {
        p_tenant_id: tenantId, p_actor: actor, p_revision: saved.revision, p_preview_id: previewId,
        p_cursor: cursor, p_items: items, p_next_cursor: next, p_complete: members.length <= 10,
      });
      if (saveError) throw saveError;
      return res.json({ ...data, items, executionReady: false, readinessIssues: LIFECYCLE_READINESS_ISSUES });
    } catch (error) {
      const conflict = error?.code === 'PT409';
      return res.status(conflict ? 409 : error.status || (error.code === '22023' ? 400 : 503)).json({
        error: error.status || conflict || error.code === '22023' ? error.message
          : 'Lifecycle preparation is unavailable. Its migration may not be installed. No member change was confirmed.',
      });
    }
  };
}
export default createMemberLifecycleHandler();

function storageReferenceLabel(value){
  if(typeof value!=='string')return 'Storage reference unavailable';
  try{
    const url=new URL(value);
    return ['https:','http:'].includes(url.protocol)?`${url.protocol}//${url.host}${url.pathname}`:'Storage administrator review required';
  }catch{return value.startsWith('/')?value.split(/[?#]/)[0]:'Storage administrator review required';}
}
