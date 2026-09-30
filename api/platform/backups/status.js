/**
 * Platform backup status.
 *
 * GET /api/platform/backups/status
 *
 * Returns the persisted storage + database resume cursors from R2 so the UI can
 * show whether each backup is idle (last sweep complete), paused mid-run, or
 * has never run.
 *
 * Auth: platform owner session cookie (same as other /api/platform/* routes).
 */

import { getSessionPlatformOwner } from '../../_lib/platformSession.js';
import { getBackupStatus } from '../../_lib/backupRunner.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const owner = await getSessionPlatformOwner(req);
  if (!owner) {
    return res.status(401).json({ error: 'Unauthorized - Platform owner access required' });
  }

  try {
    const status = await getBackupStatus();
    return res.status(200).json(status);
  } catch (err) {
    console.error('[platform/backups/status] fatal:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to read backup status' });
  }
}
