#!/usr/bin/env node

/**
 * Fix Duplicate Members Script
 * 
 * After migration, there may be duplicate member records:
 * - Original members that existed in the destination database
 * - Migrated members from the source database
 * 
 * This script identifies duplicates by identity_id and removes the
 * non-migrated duplicates (keeping the ones with migrated data).
 * 
 * Usage: node scripts/migrations/fix-duplicate-members.mjs --tenant-id=YOUR_TENANT_ID [--dry-run]
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import pg from 'pg';
const { Client } = pg;

let DEST_DATABASE_URL = process.env.DEST_DATABASE_URL;

function parseArgs() {
  const args = {
    tenantId: null,
    dryRun: false,
    help: false,
    destUrl: null
  };

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--tenant-id=')) {
      args.tenantId = arg.split('=')[1];
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg.startsWith('--dest=')) {
      args.destUrl = arg.split('=').slice(1).join('=');
    }
  }

  if (args.destUrl) DEST_DATABASE_URL = args.destUrl;

  return args;
}

function showHelp() {
  console.log(`
Fix Duplicate Members Script

Identifies and removes duplicate member records that share the same identity_id.

Usage: node scripts/migrations/fix-duplicate-members.mjs --tenant-id=YOUR_TENANT_ID [options]

Options:
  --tenant-id=ID    Required. The tenant ID to fix duplicates for
  --dry-run         Show what would be deleted without making changes
  --dest=URL        Override DEST_DATABASE_URL environment variable
  --help, -h        Show this help message

Example:
  node scripts/migrations/fix-duplicate-members.mjs \\
    --tenant-id=fd82da65-aab7-4a5c-85b8-b2febeb2003d \\
    --dest="postgresql://..." \\
    --dry-run
`);
}

async function main() {
  const args = parseArgs();

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  if (!args.tenantId) {
    console.error('Error: --tenant-id is required');
    showHelp();
    process.exit(1);
  }

  if (!DEST_DATABASE_URL) {
    console.error('Error: DEST_DATABASE_URL environment variable or --dest argument is required');
    process.exit(1);
  }

  const client = new Client({ connectionString: DEST_DATABASE_URL, ssl: true });
  await client.connect();

  console.log('=== Fix Duplicate Members ===');
  console.log(`Tenant ID: ${args.tenantId}`);
  console.log(`Mode: ${args.dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log('');

  try {
    // Find all duplicate members (same identity_id, multiple records)
    const duplicatesQuery = await client.query(`
      SELECT 
        identity_id, 
        COUNT(*) as cnt,
        array_agg(id ORDER BY created_on DESC) as member_ids,
        array_agg(email ORDER BY created_on DESC) as emails,
        array_agg(created_on ORDER BY created_on DESC) as created_dates
      FROM member 
      WHERE tenant_id = $1
        AND identity_id IS NOT NULL
      GROUP BY identity_id 
      HAVING COUNT(*) > 1
    `, [args.tenantId]);

    console.log(`Found ${duplicatesQuery.rowCount} groups of duplicate members`);

    if (duplicatesQuery.rowCount === 0) {
      console.log('No duplicates to fix!');
      await client.end();
      return;
    }

    let totalRemoved = 0;
    let totalKept = 0;

    for (const dup of duplicatesQuery.rows) {
      const memberIds = dup.member_ids;
      const emails = dup.emails;
      
      // Keep the first member (most recently created), remove the rest
      const keepId = memberIds[0];
      const removeIds = memberIds.slice(1);
      
      console.log(`\nIdentity: ${dup.identity_id}`);
      console.log(`  Keeping: ${keepId} (${emails[0]})`);
      console.log(`  Removing: ${removeIds.length} duplicate(s)`);

      for (let i = 0; i < removeIds.length; i++) {
        const removeId = removeIds[i];
        console.log(`    - ${removeId} (${emails[i + 1]})`);
        
        if (!args.dryRun) {
          // First, check for and handle any dependent records
          // Set identity_id to NULL for the duplicate before deletion
          // This prevents FK issues if other tables reference the member
          
          // Delete member_credentials for this member
          await client.query(
            'DELETE FROM member_credentials WHERE member_id = $1',
            [removeId]
          );
          
          // Delete the duplicate member
          await client.query(
            'DELETE FROM member WHERE id = $1',
            [removeId]
          );
        }
        totalRemoved++;
      }
      totalKept++;
    }

    console.log('\n=== Summary ===');
    console.log(`Groups processed: ${duplicatesQuery.rowCount}`);
    console.log(`Members kept: ${totalKept}`);
    console.log(`Duplicates ${args.dryRun ? 'would be removed' : 'removed'}: ${totalRemoved}`);

    if (args.dryRun) {
      console.log('\n[DRY RUN] No changes were made. Run without --dry-run to apply changes.');
    }

  } catch (error) {
    console.error('Error:', error.message);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
