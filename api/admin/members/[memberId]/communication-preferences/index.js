import { supabase } from '../../../../_lib/database.js';
import {
  authorizeCommunicationPreferencesAdmin,
  loadAdminMemberCommunicationPreferences,
  setAdminMemberCommunicationGlobalState,
} from '../../../../_lib/adminCommunicationPreferences.js';

export async function handleAdminCommunicationPreferencesRead(req, res, dependencies = {}) {
  const database = dependencies.database || supabase;
  if (!['GET', 'PATCH'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!database) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const authorization = await authorizeCommunicationPreferencesAdmin(req, dependencies);
  if (authorization.error) {
    return res.status(authorization.status).json({ error: authorization.error });
  }

  try {
    const args = {
      tenantId: authorization.context.tenantId,
      memberId: req.query.memberId,
    };
    let result;
    if (req.method === 'PATCH') {
      if (req.body?.action !== 'toggle_all' || typeof req.body?.optOutAll !== 'boolean') {
        return res.status(400).json({ error: 'A valid global opt-out state is required' });
      }
      result = await setAdminMemberCommunicationGlobalState(database, {
        ...args,
        optOutAll: req.body.optOutAll,
      });
    } else {
      result = await loadAdminMemberCommunicationPreferences(database, args);
    }
    if (!result) {
      return res.status(404).json({ error: 'Member not found' });
    }
    return res.json(result);
  } catch (error) {
    console.error('[Admin Communication Preferences Read] Error:', error);
    return res.status(500).json({ error: 'Failed to load communication preferences' });
  }
}

export default function handler(req, res) {
  return handleAdminCommunicationPreferencesRead(req, res);
}