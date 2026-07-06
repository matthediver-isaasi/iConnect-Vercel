/**
 * Incremental Supabase Storage → Cloudflare R2 backup (daily cron, 02:00 UTC).
 *
 * Thin wrapper around runStorageBackup() in api/_lib/backupRunner.js — the same
 * runner powers the platform manual-trigger endpoint. See that module for the
 * incremental / resumable behaviour.
 *
 * Guard: Authorization: Bearer <CRON_SECRET>
 * maxDuration: 300 s (set in vercel.json for this function)
 */

import { runStorageBackup } from '../_lib/backupRunner.js';

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const result = await runStorageBackup();
  return res.status(result.ok ? 200 : 500).json(result);
}
