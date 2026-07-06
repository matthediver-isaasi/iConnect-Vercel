/**
 * Supabase Postgres logical dump → Cloudflare R2 backup (daily cron, 02:10 UTC).
 *
 * Thin wrapper around runDatabaseBackup() in api/_lib/backupRunner.js — the same
 * runner powers the platform manual-trigger endpoint. See that module for the
 * schema scope (DB_BACKUP_SCHEMAS, default "public"), R2 key layout, and the
 * resume-cursor behaviour that lets large databases complete across runs.
 *
 * Guard: Authorization: Bearer <CRON_SECRET>
 * maxDuration: 300 s (set in vercel.json for this function)
 */

import { runDatabaseBackup } from '../_lib/backupRunner.js';

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const result = await runDatabaseBackup();
  return res.status(result.ok ? 200 : 500).json(result);
}
