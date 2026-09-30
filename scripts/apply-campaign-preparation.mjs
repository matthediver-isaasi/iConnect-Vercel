#!/usr/bin/env node
// Offline SHA review by default; applying is explicitly pinned to DEST.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
import { connectDestination, PROJECT } from './lib/member-index-destination.mjs';

export const MIGRATION = '20261001_campaign_preparation.sql';

export function validateArgs(args) {
  const applyCount = args.filter(arg => arg === '--apply').length;
  const hashes = args.filter(arg => arg.startsWith('--review-sha256='));
  if (args.some(arg => arg !== '--apply' && !/^--review-sha256=[a-f0-9]{64}$/.test(arg))
    || applyCount > 1 || hashes.length > 1) {
    throw new Error('Supported arguments are --apply and --review-sha256=<64 lowercase hex characters>.');
  }
  return { apply: applyCount === 1, reviewHash: hashes[0]?.slice('--review-sha256='.length) };
}

export function assertReviewHash(args, sha256) {
  const parsed = validateArgs(args);
  if (parsed.apply && parsed.reviewHash !== sha256) {
    throw new Error('Applying requires --review-sha256 matching the exact current migration bytes.');
  }
  return parsed;
}

async function campaignSnapshot(client, excludedColumns) {
  const { rows } = await client.query(`
    SELECT count(*)::bigint AS count,
      md5(coalesce(string_agg(
        md5((to_jsonb(t) - $1::text[])::text) || ':' || t.xmin::text,
        '' ORDER BY t.id), '')) AS digest
    FROM public.email_campaign t
  `, [excludedColumns]);
  return rows[0];
}

export async function applyMigration(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL search_path = public');
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");

    // Keep a stable before/after view while DDL runs. Newly added columns are
    // excluded only if they did not exist before this invocation.
    await client.query('LOCK TABLE public.email_campaign IN ACCESS EXCLUSIVE MODE');
    const existing = await client.query(`
      SELECT attname FROM pg_attribute
      WHERE attrelid = 'public.email_campaign'::regclass
        AND attname = ANY($1::text[]) AND NOT attisdropped
    `, [['preparation_generation', 'preparation_actor_member_id']]);
    const existed = new Set(existing.rows.map(row => row.attname));
    const excluded = ['preparation_generation', 'preparation_actor_member_id']
      .filter(column => !existed.has(column));
    const before = await campaignSnapshot(client, excluded);

    await client.query(sql);

    const definitions = await client.query(`
      SELECT attname, format_type(atttypid, atttypmod) AS type,
        attnotnull AS not_null, atthasdef AS has_default
      FROM pg_attribute
      WHERE attrelid = 'public.email_campaign'::regclass
        AND attname = ANY($1::text[]) AND NOT attisdropped
    `, [['preparation_generation', 'preparation_actor_member_id']]);
    const byName = new Map(definitions.rows.map(row => [row.attname, row]));
    for (const column of ['preparation_generation', 'preparation_actor_member_id']) {
      const definition = byName.get(column);
      if (!definition || definition.type !== 'uuid' || definition.not_null || definition.has_default) {
        throw new Error(`Unexpected ${column} definition; transaction rolled back.`);
      }
    }
    const after = await campaignSnapshot(client, excluded);
    if (before.count !== after.count || before.digest !== after.digest) {
      throw new Error('Preexisting campaign rows changed; transaction rolled back.');
    }
    await client.query('COMMIT');
    return { existingCampaignRowsVerified: after.count, existingCampaignRowsUnchanged: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export async function main(args = process.argv.slice(2)) {
  const parsed = validateArgs(args);
  const sql = await readFile(new URL(`../migrations/${MIGRATION}`, import.meta.url), 'utf8');
  const sha256 = createHash('sha256').update(sql).digest('hex');
  assertReviewHash(args, sha256);
  if (!parsed.apply) {
    console.log(JSON.stringify({ dryRun: true, migration: MIGRATION, sha256,
      destinationProject: PROJECT, writesPerformed: false }));
    return;
  }

  // Independent REST and SQL destination pins; connectDestination enforces
  // the pinned SQL project and trusted CA with certificate verification.
  destinationTarget(process.env);
  const client = await connectDestination();
  try {
    const verification = await applyMigration(client, sql);
    console.log(JSON.stringify({ applied: true, migration: MIGRATION, sha256,
      destinationProject: PROJECT, verification }));
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(JSON.stringify({ applied: false, errorCode: error.code || 'VALIDATION_FAILED',
      message: error.message || 'Migration failed; no success confirmed. Check destination pins and reviewed SQL.' }));
    process.exitCode = 1;
  });
}