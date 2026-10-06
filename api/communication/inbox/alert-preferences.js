import { createHash } from 'node:crypto';
import { supabase } from '../../_lib/database.js';
import { getSession } from '../../_lib/session.js';
import { getTenantContext } from '../../_lib/tenantContext.js';

export function validAlertPatch(body) {
  return body && !Array.isArray(body) && Object.keys(body).length === 1
    && ['always_hide', 'hide_until_login', 'shown'].includes(Object.keys(body)[0])
    && typeof Object.values(body)[0] === 'boolean'
    && (body.shown === undefined || body.shown === true);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!['GET', 'PATCH'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  if (req.method === 'PATCH' && !validAlertPatch(req.body?.preference)) return res.status(400).json({ error: 'Invalid alert preference' });
  try {
    const ctx = await getTenantContext(req);
    const session = await getSession(req);
    if (!ctx.isAuthenticated || !ctx.memberId || !ctx.tenantId || !session
      || session.data.memberId !== ctx.memberId || session.data.tenantId !== ctx.tenantId) {
      return res.status(401).json({ error: 'Member session required' });
    }
    const scope = { tenant_id: ctx.tenantId, member_id: ctx.memberId };
    const loginScope = { ...scope, sid: session.id };
    const loginKey = createHash('sha256').update(`inbox-alert:${session.id}`).digest('hex');
    if (req.method === 'PATCH') {
      if (req.body.member_id !== ctx.memberId || req.body.tenant_id !== ctx.tenantId
        || req.body.login_key !== loginKey) {
        return res.status(409).json({ error: 'Your login changed. Reload alert preferences.' });
      }
      const [field, value] = Object.entries(req.body.preference)[0];
      const { error } = await supabase.rpc('set_inbox_alert_preference', {
        p_sid: session.id, p_tenant: ctx.tenantId, p_member: ctx.memberId,
        p_field: field, p_value: value,
      });
      if (error) throw error;
    }
    const [preference, login] = await Promise.all([
      supabase.from('member_inbox_alert_preference').select('always_hide').match(scope).maybeSingle(),
      supabase.from('member_inbox_alert_login').select('hide_until_login,shown').match(loginScope).maybeSingle(),
    ]);
    if (preference.error || login.error) throw preference.error || login.error;
    return res.json({
      ...scope,
      // One-way display identity, never a credential or a reusable session token.
      login_key: loginKey,
      always_hide: preference.data?.always_hide === true,
      hide_until_login: login.data?.hide_until_login === true,
      shown: login.data?.shown === true,
    });
  } catch {
    return res.status(503).json({ error: 'Could not save or load alert preferences. Please retry.' });
  }
}
