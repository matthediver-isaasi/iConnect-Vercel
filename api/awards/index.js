import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { isResourceExcluded } from '../_lib/roleVisibility.js';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export async function authorizeAwards(req, database, resolveContext = getTenantContext, capability = 'awards.management') {
  const context = await resolveContext(req);
  if (context?.tenantMismatch) return { status: 409, code: 'TENANT_CONTEXT_CHANGED', error: 'Tenant context changed' };
  if (!context?.isAuthenticated || !context.tenantId) return { status: 401, error: 'Authentication required' };
  if (!context.roleId || !(context.memberId || context.tenantUserId)) return { status: 403, error: 'Awards permission required' };
  const { data: role, error } = await database.from('role').select('excluded_features')
    .eq('id', context.roleId).eq('tenant_id', context.tenantId).maybeSingle();
  if (error || !role) return { status: 403, error: 'Awards permission required' };
  const exclusions = [...(role.excluded_features || []), ...(context.memberExcludedFeatures || [])];
  if (isResourceExcluded(exclusions, capability)) return { status: 403, error: 'Awards permission required' };
  return { context };
}

export default async function handler(req, res, dependencies = {}) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  const database = dependencies.supabase || supabase;
  if (!database) return res.status(503).json({ error: 'Database unavailable' });
  try {
    if (req.method === 'POST') {
      // A same-origin custom header plus JSON prevents simple cross-site form
      // requests; no CORS permission is granted by this endpoint.
      if (req.headers?.['x-awards-request'] !== '1'
        || !String(req.headers?.['content-type'] || '').startsWith('application/json')
        || req.headers?.['sec-fetch-site'] === 'cross-site') {
        return res.status(403).json({ error: 'Use the awards administration page' });
      }
    }
    const auth = await authorizeAwards(req, database, dependencies.getTenantContext,
      req.method === 'POST' ? 'awards.management.configure' : 'awards.management');
    if (!auth.context) return res.status(auth.status).json({ error: auth.error, code: auth.code });
    const context = auth.context;
    if (req.method === 'GET') {
      const page = Number(req.query?.page || 1);
      if (!Number.isSafeInteger(page) || page < 1 || page > 100000) return res.status(400).json({ error: 'Invalid page' });
      const { data, error, count } = await database.from('awards_competition').select('*,form_bindings:awards_form_binding(form_id,active,review_field_ids)', { count: 'exact' })
        .eq('tenant_id', context.tenantId).order('created_at', { ascending: false }).order('id')
        .range((page - 1) * 50, page * 50 - 1);
      if (error) throw error;
      return res.json({ awards: data.map(({ form_bindings, ...award }) => ({
        ...award, form_id: form_bindings?.find(binding => binding.active)?.form_id || null,
        review_field_ids: form_bindings?.find(binding => binding.active)?.review_field_ids || [],
      })), total: count, page, pageSize: 50 });
    }
    const { command, id, version, payload } = req.body || {};
    if (!['create','configure','bind_form','transition','duplicate'].includes(command)
      || command !== 'create' && (!uuid(id) || !Number.isSafeInteger(version) || version < 1)
      || !payload || typeof payload !== 'object' || Array.isArray(payload)
      || JSON.stringify(payload).length > 50000) {
      return res.status(400).json({ error: 'Invalid award command' });
    }
    const { data, error } = command === 'duplicate' ? await database.rpc('awards_duplicate', {
      p_tenant:context.tenantId,p_source:id,p_expected_version:version,
      p_actor_kind:context.memberId?'member':'tenant_user',p_actor:context.memberId||context.tenantUserId,p_name:payload.name,
    }) : await database.rpc('awards_configure', {
      p_tenant: context.tenantId,
      p_actor_kind: context.memberId ? 'member' : 'tenant_user',
      p_actor: context.memberId || context.tenantUserId,
      p_command: command, p_id: command === 'create' ? null : id,
      p_expected_version: command === 'create' ? null : version, p_payload: payload,
    });
    if (error) throw error;
    return res.status(command === 'create' ? 201 : 200).json({ award: data });
  } catch (error) {
    const missingSchema = ['42P01','PGRST202','PGRST205'].includes(error.code);
    const status = missingSchema ? 503 : ['40001','PT409'].includes(error.code) ? 409 : error.code === 'P0002' ? 404
      : ['P0001','23514','23503','23505','22007','22P02'].includes(error.code) ? 400 : 500;
    return res.status(status).json({ error: missingSchema ? 'Awards database setup is not installed'
      : status === 500 ? 'Unable to process awards request' : error.message });
  }
}
