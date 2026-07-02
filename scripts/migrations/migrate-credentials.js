#!/usr/bin/env node

/**
 * Credential Migration Script
 * Migrates member_credentials to the new multi-tenant auth system:
 * - Creates tenant_identity records for members
 * - Creates tenant_membership_credentials for tenant-specific passwords
 * - Links member.identity_id to tenant_identity
 * 
 * Usage: node scripts/migrations/migrate-credentials.js --tenant-id=YOUR_TENANT_ID [--dry-run]
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import pg from 'pg';
import { randomUUID } from 'crypto';

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
Credential Migration Script

Migrates member_credentials to the new multi-tenant authentication system.

Usage: node scripts/migrations/migrate-credentials.js --tenant-id=YOUR_TENANT_ID [options]

Options:
  --tenant-id=ID    Required. The tenant ID to migrate credentials for
  --dry-run         Show what would be migrated without making changes
  --dest=URL        Override DEST_DATABASE_URL environment variable
  --help, -h        Show this help message

What it does:
  1. Creates tenant_identity records for members with credentials
  2. Creates tenant_membership_credentials linking identity to tenant
  3. Updates member.identity_id to link to the new identity

Examples:
  node scripts/migrations/migrate-credentials.js --tenant-id=abc123
  node scripts/migrations/migrate-credentials.js --tenant-id=abc123 --dry-run
`);
}

async function migrateCredentials(client, tenantId, dryRun) {
  console.log('\n=== Credential Migration ===');
  console.log('Tenant ID:', tenantId);
  console.log('Dry Run:', dryRun);
  console.log('');

  // Step 1: Get all member_credentials for this tenant that need migration
  const credentialsResult = await client.query(`
    SELECT 
      mc.id as credential_id,
      mc.member_id,
      mc.email,
      mc.password_hash,
      mc.is_temp_password,
      mc.password_set_at,
      mc.reset_token,
      mc.reset_token_expires,
      mc.failed_login_attempts,
      mc.locked_until,
      m.first_name,
      m.last_name,
      m.identity_id as existing_identity_id
    FROM member_credentials mc
    JOIN member m ON mc.member_id = m.id
    WHERE mc.tenant_id = $1
    ORDER BY mc.email
  `, [tenantId]);

  console.log(`Found ${credentialsResult.rows.length} member credentials to process`);

  let identitiesCreated = 0;
  let identitiesExisting = 0;
  let tmcCreated = 0;
  let tmcExisting = 0;
  let membersLinked = 0;
  let errors = 0;

  for (const cred of credentialsResult.rows) {
    const email = cred.email?.toLowerCase()?.trim();
    if (!email) {
      console.log(`  Skipping credential ${cred.credential_id}: no email`);
      continue;
    }

    try {
      // Step 2: Check if tenant_identity exists for this email
      let identityId = null;
      const existingIdentity = await client.query(
        'SELECT id FROM tenant_identity WHERE LOWER(email) = $1',
        [email]
      );

      if (existingIdentity.rows.length > 0) {
        identityId = existingIdentity.rows[0].id;
        identitiesExisting++;
      } else {
        // Create new tenant_identity
        identityId = randomUUID();
        
        if (!dryRun) {
          await client.query(`
            INSERT INTO tenant_identity (
              id, email, first_name, last_name, password_hash,
              is_temporary, reset_token, reset_token_expires,
              failed_attempts, locked_until, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
          `, [
            identityId,
            email,
            cred.first_name || '',
            cred.last_name || '',
            cred.password_hash,
            cred.is_temp_password || false,
            cred.reset_token,
            cred.reset_token_expires,
            cred.failed_login_attempts || 0,
            cred.locked_until
          ]);
        }
        identitiesCreated++;
        console.log(`  Created tenant_identity for ${email}`);
      }

      // Step 3: Check if tenant_membership_credentials exists
      const existingTMC = await client.query(
        'SELECT id FROM tenant_membership_credentials WHERE identity_id = $1 AND tenant_id = $2',
        [identityId, tenantId]
      );

      if (existingTMC.rows.length > 0) {
        tmcExisting++;
      } else {
        // Create tenant_membership_credentials
        const tmcId = randomUUID();
        
        if (!dryRun) {
          await client.query(`
            INSERT INTO tenant_membership_credentials (
              id, identity_id, tenant_id, password_hash,
              reset_token, reset_token_expires, failed_attempts,
              locked_until, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
          `, [
            tmcId,
            identityId,
            tenantId,
            cred.password_hash,
            cred.reset_token,
            cred.reset_token_expires,
            cred.failed_login_attempts || 0,
            cred.locked_until
          ]);
        }
        tmcCreated++;
        console.log(`  Created tenant_membership_credentials for ${email}`);
      }

      // Step 4: Link member to identity if not already linked
      if (!cred.existing_identity_id) {
        if (!dryRun) {
          await client.query(
            'UPDATE member SET identity_id = $1 WHERE id = $2',
            [identityId, cred.member_id]
          );
        }
        membersLinked++;
      }

    } catch (error) {
      console.error(`  Error processing ${email}: ${error.message}`);
      errors++;
    }
  }

  console.log('\n=== Migration Summary ===');
  console.log(`Tenant Identities: ${identitiesCreated} created, ${identitiesExisting} existing`);
  console.log(`Membership Credentials: ${tmcCreated} created, ${tmcExisting} existing`);
  console.log(`Members Linked: ${membersLinked}`);
  console.log(`Errors: ${errors}`);

  if (dryRun) {
    console.log('\n[DRY RUN] No changes were made');
  }

  return {
    identitiesCreated,
    identitiesExisting,
    tmcCreated,
    tmcExisting,
    membersLinked,
    errors
  };
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
    console.error('Error: DEST_DATABASE_URL environment variable or --dest option is required');
    process.exit(1);
  }

  const client = new Client({
    connectionString: DEST_DATABASE_URL,
    ssl: true
  });

  try {
    await client.connect();
    console.log('Connected to destination database');

    await migrateCredentials(client, args.tenantId, args.dryRun);

  } catch (error) {
    console.error('Migration failed:', error.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
