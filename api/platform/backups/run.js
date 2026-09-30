/**
 * Platform manual backup trigger.
 *
 * POST /api/platform/backups/run   body: { type: "storage" | "database" }
 *
 * Runs ONE bounded chunk of the requested backup (reusing the same runner as
 * the daily cron) and returns its summary. Because the runners are resumable,
 * the client re-invokes this endpoint until the summary reports the backup is
 * done (storage: deferred === false; database: complete === true), driving a
 * full manual backup to completion while showing live progress.
 *
 * Auth: platform owner session cookie (same as other /api/platform/* routes).
 * maxDuration: 300 s (set in vercel.json for this function).
 */

import { getSessionPlatformOwner } from '../../_lib/platformSession.js';
import {
  runStorageBackup,
  runDatabaseBackup,
  acquireBackupLock,
  releaseBackupLock,
} from '../../_lib/backupRunner.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const owner = await getSessionPlatformOwner(req);
  if (!owner) {
    return res.status(401).json({ error: 'Unauthorized - Platform owner access required' });
  }

  const type = req.body?.type;
  if (type !== 'storage' && type !== 'database') {
    return res.status(400).json({ error: 'Invalid backup type. Use "storage" or "database".' });
  }

  // Lease lock: don't process the same backup concurrently with a cron chunk
  // loop (or another manual run) — they share resume cursors in R2. Each
  // manual invocation is one chunk, so acquire/release around the chunk; the
  // TTL guarantees a crashed run never wedges backups.
  const lock = await acquireBackupLock(type, { holder: 'manual' });
  if (!lock.acquired) {
    return res.status(409).json({
      error: `A ${type} backup run is already in progress (started by ${lock.holder}). Try again shortly.`,
      inProgress: true,
      lockedBy: lock.holder,
      lockExpiresAt: lock.expiresAt,
    });
  }

  try {
    const result = type === 'storage' ? await runStorageBackup() : await runDatabaseBackup();
    return res.status(result.ok ? 200 : 500).json({ type, ...result });
  } catch (err) {
    console.error('[platform/backups/run] fatal:', err.message);
    return res.status(500).json({ error: err.message || 'Backup run failed' });
  } finally {
    await releaseBackupLock(type, lock.token);
  }
}
