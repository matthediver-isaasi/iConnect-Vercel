/**
 * Supabase Postgres logical dump → Cloudflare R2 backup (scheduled cron).
 *
 * Fires every 10 minutes (offset :05) between 02:00–07:59 UTC (see
 * vercel.json). Each invocation:
 *   1. exits cheaply if today's dump already completed (per-UTC-day check),
 *   2. otherwise loops resumable chunks via runDatabaseBackupToCompletion()
 *      until the dump finishes or the invocation nears its 300s cap —
 *      the next scheduled fire resumes from the persisted cursor.
 *
 * The same runner powers the platform manual-trigger endpoint. See
 * api/_lib/backupRunner.js for the schema scope (DB_BACKUP_SCHEMAS, default
 * "public") and R2 key layout.
 *
 * Guard: Authorization: Bearer <CRON_SECRET>
 * maxDuration: 300 s (set in vercel.json for this function)
 */

import {
  runDatabaseBackupToCompletion,
  getCompletedTodayCursor,
  acquireBackupLock,
  releaseBackupLock,
} from '../_lib/backupRunner.js';
import { createHeartbeatReporter, HEARTBEAT_ENV_VARS } from '../_lib/heartbeat.js';

const MAX_DURATION_MS = 300_000;
const SAFETY_HEADROOM_MS = 30_000;

export function isDatabaseBackupHeartbeatHealthy(result) {
  return Boolean(
    result?.ok
    && (!Array.isArray(result.erroredTables) || result.erroredTables.length === 0)
    && (!Array.isArray(result.errored) || result.errored.length === 0),
  );
}

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const reportHeartbeat = createHeartbeatReporter({
    envVar: HEARTBEAT_ENV_VARS.databaseBackup,
  });

  let lock = null;
  try {
    const completedToday = await getCompletedTodayCursor('database');
    if (completedToday) {
      await reportHeartbeat(true);
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: 'Database backup already completed today',
        completedAt: completedToday.clearedAt,
      });
    }

    lock = await acquireBackupLock('database', { holder: 'cron' });
    if (!lock.acquired) {
      await reportHeartbeat(true);
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: 'Another database backup run is in progress',
        lockedBy: lock.holder,
        lockExpiresAt: lock.expiresAt,
      });
    }

    const deadline = Date.now() + MAX_DURATION_MS - SAFETY_HEADROOM_MS;
    const result = await runDatabaseBackupToCompletion({ deadline });
    await reportHeartbeat(isDatabaseBackupHeartbeatHealthy(result));
    return res.status(result.ok ? 200 : 500).json(result);
  } catch (error) {
    await reportHeartbeat(false);
    throw error;
  } finally {
    if (lock?.acquired) await releaseBackupLock('database', lock.token);
  }
}
