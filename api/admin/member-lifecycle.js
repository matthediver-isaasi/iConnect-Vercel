import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../_lib/tenantContext.js';
import { DEFAULT_LIFECYCLE_POLICY, LIFECYCLE_CAPABILITIES, validateLifecyclePolicy,
  evaluateMemberLifecycle } from '../../shared/memberLifecyclePolicy.mjs';
import { lifecycleRows, loadMemberLifecycleEvidence } from '../_lib/memberLifecycleEvidence.js';

export const LIFECYCLE_READINESS_ISSUES = Object.freeze([
  'Preparation only: lifecycle execution and manual record changes are not available yet.',
  'Existing membership-expiry role/login changes need a shared execution boundary.',
  'Complete attendance, CPD and genuine tenant-scoped login evidence must be connected and verified.',
  'Outstanding obligations, legal holds and field-level minimisation require complete verification.',
  'Atomic renewal-safe execution, notifications and operational visibility integration remain outstanding.',
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const mutationCapability = {
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
        const roles = (await readRows(db, 'role', tenantId)).filter(role => role.is_active !== false && !role.is_tenant_admin)
          .map(role => ({ id: role.id, name: role.name || role.id }));
        return { ...saved, roles, permissions, executionReady: false, readinessIssues: LIFECYCLE_READINESS_ISSUES };
      };
      if (req.method === 'GET') {
        if (req.query?.section && req.query.section !== 'settings') {
          fail('Archive Review records are unavailable until lifecycle execution is implemented. No member records have been changed.', 409);
        }
        return res.json(await settings());
      }
      const action = req.method === 'PUT' ? 'configure' : mutationCapability[req.body?.action];
      if (!action) fail('Unknown lifecycle action');
      if (!permissions[action]) fail('You do not have permission for this lifecycle action', 403);
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
        fail('Lifecycle execution is not ready. No member records were changed. Configuration and read-only previews are available.', 409);
      }
      const saved = await readPolicy();
      if (!saved.revision) fail('Save the draft configuration before previewing', 409);
      const policy = validateLifecyclePolicy(saved.policy);
      const cursor = req.body.cursor || null, previewId = req.body.previewId || null;
      if ((cursor && !uuid.test(cursor)) || (previewId && !uuid.test(previewId)) || (!!cursor !== !!previewId)) {
        fail('Invalid preview continuation');
      }
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
        const evidence = await loadEvidence(db, tenantId, member, policy);
        const proposal = evaluateMemberLifecycle({ tenantId, member, evidence, policy, roles });
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
