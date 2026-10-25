import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';
import { jobAlertState } from '../_lib/jobAlerts.js';

export async function handleJobAlerts(req, res, deps = {}) {
  const db = deps.db || supabase;
  res.setHeader('Cache-Control', 'private, no-store');
  if (!['GET','PATCH'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  try {
    const member = await (deps.getMember || getSessionMember)(req);
    if (!member?.id || !member.tenant_id) return res.status(401).json({ error: 'Member sign-in required' });
    const loadState = deps.loadState || jobAlertState;
    const state = await loadState(db, member);
    if (req.method === 'GET') return res.json(state);
    const { action, subscribed } = req.body || {};
    if (!['subscribe','later','never'].includes(action) || (action === 'subscribe' && typeof subscribed !== 'boolean'))
      return res.status(400).json({ error: 'Invalid preference' });
    if (!state.enabled || (!state.eligible && !(action === 'subscribe' && !subscribed)))
      return res.status(403).json({ error: 'Job alerts are not available' });
    if (action === 'subscribe') {
      if (subscribed && state.optedOutAll) return res.status(409).json({ error: 'Turn off “Opt out of all communications” in your communication preferences first.' });
      const { error } = await db.rpc('set_email_preference_category_state', {
        p_tenant_id: member.tenant_id, p_email: member.email, p_member_id: member.id,
        p_category_id: state.categoryId, p_is_subscribed: subscribed, p_campaign_id: null,
      });
      if (error) throw error;
    }
    const { error } = await db.from('job_alert_prompt').upsert({
      tenant_id: member.tenant_id, member_id: member.id,
      never_ask: action !== 'later',
      ask_after: action === 'later' ? new Date(Date.now() + 7 * 86400000).toISOString() : null,
    }, { onConflict: 'tenant_id,member_id' });
    if (error) throw error;
    return res.json(await loadState(db, member));
  } catch (error) {
    console.error('[Job alerts] Preference request failed', error.code || error.message);
    return res.status(503).json({ error: 'Job alert preferences are unavailable. Please try again.' });
  }
}
export default handleJobAlerts;
