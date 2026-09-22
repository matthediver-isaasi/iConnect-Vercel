import { supabase } from '../../_lib/database.js';
import { authorizeCommunicationPreferencesAdmin } from '../../_lib/adminCommunicationPreferences.js';
import { loadCommunicationStatusReport } from '../../_lib/memberCommunicationStatusReport.js';

export async function handleCommunicationStatusReport(req, res, dependencies = {}) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const database = dependencies.database || supabase;
  if (!database) return res.status(503).json({ error: 'Database not configured' });

  const authorization = await authorizeCommunicationPreferencesAdmin(req, dependencies);
  if (authorization.error) {
    return res.status(authorization.status).json({ error: authorization.error });
  }
  try {
    const loadReport = dependencies.loadCommunicationStatusReport
      || loadCommunicationStatusReport;
    const report = await loadReport(database, {
      tenantId: authorization.context.tenantId,
      query: req.query,
    });
    return res.json(report);
  } catch (error) {
    console.error('[Communication Status Report] Error:', error);
    return res.status(error.status || 500).json({
      error: error.status ? error.message : 'Failed to load communication status report',
    });
  }
}

export default function handler(req, res) {
  return handleCommunicationStatusReport(req, res);
}