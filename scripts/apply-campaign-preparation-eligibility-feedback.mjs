#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { assertReviewHash, applyMigration } from './apply-campaign-preparation.mjs';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
import { connectDestination, PROJECT } from './lib/member-index-destination.mjs';

const migration = '20261016_campaign_preparation_eligibility_feedback.sql';
const sql = await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8');
const sha256 = createHash('sha256').update(sql).digest('hex');
const { apply } = assertReviewHash(process.argv.slice(2), sha256);
if (!apply) console.log(JSON.stringify({ dryRun: true, migration, sha256, destinationProject: PROJECT }));
else {
  destinationTarget(process.env);
  const client = await connectDestination();
  try {
    const verification = await applyMigration(client, sql);
    console.log(JSON.stringify({ applied: true, migration, sha256, destinationProject: PROJECT, verification }));
  } finally { await client.end(); }
}
