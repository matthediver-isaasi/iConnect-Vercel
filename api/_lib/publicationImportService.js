import { createHmac, timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { LEGACY_TO_NEW_MAPPING, FEATURE_TO_PAGE, RESOURCE_TO_MODULE } from './roleAccessHierarchy.generated.js';

export class PublicationImportError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
// Match GET /article-briefs/settings when no settings record has been saved.
export const DEFAULT_PUBLICATION_SETTINGS = {
  stages: [
    { key: 'new', label: 'New', color: '#6b7280' },
    { key: 'assigned', label: 'Assigned', color: '#3b82f6' },
    { key: 'in_progress', label: 'In Progress', color: '#f59e0b' },
    { key: 'changes_requested', label: 'Changes Requested', color: '#f97316' },
    { key: 'approved', label: 'Approved', color: '#22c55e' },
    { key: 'rejected', label: 'Rejected', color: '#ef4444' },
  ],
  categories: ['General', 'News', 'Feature', 'Opinion', 'Review', 'Interview', 'Tutorial'],
  notify_reviewer: false,
  notify_writer: false,
};
const fail = (message, status) => { throw new PublicationImportError(message, status); };
export const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, sort(value[k])]));
  return value;
}
export const planDigest = rows => createHash('sha256').update(canonical(rows)).digest('hex');
export function signPlan(plan, secret) {
  if (!secret) fail('Publication import signing key is not configured', 503);
  const body = Buffer.from(JSON.stringify(plan)).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}
export function verifyPlan(token, secret, context) {
  if (!secret) fail('Publication import signing key is not configured', 503);
  if (typeof token !== 'string' || token.length > 3000000) fail('Invalid import plan');
  const [body, signature, extra] = token.split('.');
  const expected = createHmac('sha256', secret).update(body || '').digest();
  const actual = Buffer.from(signature || '', 'base64url');
  if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail('Invalid import plan');
  let plan;
  try { plan = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { fail('Invalid import plan'); }
  if (plan.version !== 1 || plan.tenant !== context.tenantId || plan.actor !== actorKey(context)) fail('Import plan belongs to a different actor or tenant', 403);
  return plan;
}
const actorKey = ctx => ctx.tenantUserId ? `tenant_user:${ctx.tenantUserId}` : `member:${ctx.memberId}`;

export function permissions(snapshot, context) {
  if (context.tenantMismatch) fail('Session tenant does not match this site', 403);
  if (!context.isAuthenticated || !context.tenantId) fail('Authentication required', 401);
  const actor = snapshot.actor;
  if (!actor || actor.is_active === false || actor.deleted_at || ['inactive', 'suspended', 'deleted'].includes(actor.status)) fail('Current actor is unavailable', 403);
  const role = snapshot.role;
  // Tenant owners without a member identity have explicit tenant administration access.
  const administrator = context.tenantUserId && ['owner', 'admin', 'super_admin'].includes(actor.role);
  if (snapshot.member?.role_id && !role) fail('Current role is unavailable', 403);
  if (!administrator && (!role || !snapshot.member || snapshot.member.role_id !== role.id)) fail('Current role is unavailable', 403);
  const excluded = [...(role?.excluded_features || []), ...(snapshot.member?.member_excluded_features || [])];
  const norm = key => LEGACY_TO_NEW_MAPPING[key] || key;
  const denied = feature => {
    const normalized = excluded.map(norm);
    const parts = feature.split('.');
    if ([feature, FEATURE_TO_PAGE[feature] || parts.slice(0, 2).join('.'),
      RESOURCE_TO_MODULE[feature] || parts[0]].some(key => normalized.includes(key))) return true;
    const items = snapshot.accessItems || [];
    let item = items.find(i => norm(i.item_key) === feature);
    const seen = new Set();
    while (item && !seen.has(item.id)) {
      seen.add(item.id);
      if (excluded.map(norm).includes(norm(item.item_key))) return true;
      item = items.find(i => i.id === item.parent_id);
    }
    return false;
  };
  if (denied('content.briefs.manage')) fail('Manage briefs permission required', 403);
  return { canAssign: !denied('content.briefs.assign') };
}

export function createPublicationImportService({ db, parser, secret, now = () => Date.now() }) {
  async function rpc(name, args) {
    const { data, error } = await db.rpc(name, args);
    if (error) {
      // Transport failures may arrive after commit; keep the plan for receipt recovery.
      const rejected = error.code === 'P0001' || /^23/.test(error.code || '');
      fail(error.message?.includes('lookup limit exceeded') ? error.message :
        error.message?.includes('stale') ? 'Import data changed. Preview the workbook again.' :
          'Publication import database operation failed. Retry the same import.', rejected ? 409 : 503);
    }
    return data;
  }
  const args = ctx => ({ p_tenant: ctx.tenantId, p_member: ctx.memberId || null, p_tenant_user: ctx.tenantUserId || null });
  async function snapshot(ctx) {
    if (ctx.tenantMismatch) fail('Session tenant does not match this site', 403);
    if (!ctx.isAuthenticated || !ctx.tenantId || (!ctx.memberId && !ctx.tenantUserId)) fail('Authentication required', 401);
    const data = await rpc('publication_import_snapshot', args(ctx));
    permissions(data, ctx);
    return data;
  }
  function resolve(records, data, ctx) {
    const permission = permissions(data, ctx);
    try {
      return parser.resolvePublicationRows(records, { settings: data.settings || DEFAULT_PUBLICATION_SETTINGS, members: data.members,
        externalWriters: data.externalWriters, briefs: data.briefs, ...permission });
    } catch (error) { fail(error.message); }
  }
  return {
    async template(ctx) {
      const data = await snapshot(ctx);
      return parser.createPublicationTemplate(data.settings || DEFAULT_PUBLICATION_SETTINGS);
    },
    async preview(ctx, input) {
      const data = await snapshot(ctx);
      if (typeof input.workbook !== 'string' || input.workbook.length > 1398104 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.workbook)) fail('A base64 XLSX workbook up to 1 MB is required');
      if (typeof input.fileName !== 'string' || !/\.xlsx$/i.test(input.fileName)) fail('Only .xlsx workbooks are supported');
      let parsed;
      try {
        parsed = parser.parsePublicationWorkbook(Buffer.from(input.workbook, 'base64'), { fileName: input.fileName, sheetName: input.sheetName });
      } catch (error) { fail(error.message); }
      if (parsed.needsSheetSelection) return { ...parsed, rows: [], planId: null, canApply: false };
      if (!Array.isArray(parsed.records) || !parsed.records.length || parsed.records.length > 100) fail('Import must contain between 1 and 100 rows');
      if (Buffer.byteLength(JSON.stringify(parsed.records)) > 512 * 1024) fail('Publication text exceeds 512 KB. Shorten notes or split this workbook into smaller batches.');
      const rows = resolve(parsed.records, data, ctx);
      const canApply = rows.length > 0 && rows.every(r => ['create', 'skip'].includes(r.action) && !r.errors?.length);
      const planId = canApply ? signPlan({ version: 1, id: randomUUID(), tenant: ctx.tenantId, actor: actorKey(ctx),
        expires: now() + 30 * 60 * 1000, records: parsed.records, digest: planDigest(rows) }, secret) : null;
      return { sheets: parsed.sheets, sheetName: parsed.sheetName, rows, planId, canApply };
    },
    async apply(ctx, token) {
      const plan = verifyPlan(token, secret, ctx);
      const data = await snapshot(ctx);
      // Durable replay precedes expiry and re-resolution, but never current authentication/authorization.
      const previous = await rpc('publication_import_result', { ...args(ctx), p_plan: plan.id });
      if (previous) return previous;
      if (plan.expires <= now()) fail('Import plan expired. Preview the workbook again.', 409);
      const rows = resolve(plan.records, data, ctx);
      if (planDigest(rows) !== plan.digest || rows.some(r => r.action === 'error' || r.errors?.length)) {
        const error = new PublicationImportError('Import plan is stale. Preview the workbook again.', 409);
        error.rows = rows;
        throw error;
      }
      return rpc('publication_import_apply', { ...args(ctx), p_plan: plan.id,
        p_expires: new Date(plan.expires).toISOString(), p_snapshot: data, p_rows: rows });
    },
  };
}
