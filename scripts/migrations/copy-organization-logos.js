#!/usr/bin/env node

/**
 * Organization Logo Migration Script
 * Copies logo_url from source database organizations to destination database
 * 
 * Usage: node scripts/migrations/copy-organization-logos.js [--dry-run] [--tenant-id=ID]
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import pg from 'pg';

const { Client } = pg;

let SOURCE_DATABASE_URL = process.env.SOURCE_DATABASE_URL;
let DEST_DATABASE_URL = process.env.DEST_DATABASE_URL;

const SSL_CONFIG = true;

function parseArgs() {
  const args = {
    dryRun: false,
    tenantId: null,
    help: false,
    sourceUrl: null,
    destUrl: null
  };

  for (const arg of process.argv.slice(2)) {
    if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg.startsWith('--tenant-id=')) {
      args.tenantId = arg.split('=')[1];
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg.startsWith('--source=')) {
      args.sourceUrl = arg.split('=').slice(1).join('=');
    } else if (arg.startsWith('--dest=')) {
      args.destUrl = arg.split('=').slice(1).join('=');
    }
  }

  if (args.sourceUrl) SOURCE_DATABASE_URL = args.sourceUrl;
  if (args.destUrl) DEST_DATABASE_URL = args.destUrl;

  return args;
}

function showHelp() {
  console.log(`
Organization Logo Migration Script

Copies logo_url from source database organizations to destination database.
Matches organizations by ID (preserved from original migration).

Usage: node scripts/migrations/copy-organization-logos.js [options]

Options:
  --dry-run         Show what would be updated without making changes
  --tenant-id=ID    Only update organizations for a specific tenant in destination
  --source=URL      Override SOURCE_DATABASE_URL environment variable
  --dest=URL        Override DEST_DATABASE_URL environment variable
  --help, -h        Show this help message

Examples:
  node scripts/migrations/copy-organization-logos.js --dry-run
  node scripts/migrations/copy-organization-logos.js
  node scripts/migrations/copy-organization-logos.js --tenant-id=abc123
`);
}

async function main() {
  const args = parseArgs();

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  if (!SOURCE_DATABASE_URL || !DEST_DATABASE_URL) {
    console.error('Error: SOURCE_DATABASE_URL and DEST_DATABASE_URL must be set');
    console.error('Use --source=URL and --dest=URL or set environment variables');
    process.exit(1);
  }

  console.log('='.repeat(80));
  console.log('ORGANIZATION LOGO MIGRATION');
  console.log('='.repeat(80));
  console.log();
  console.log(`Dry Run: ${args.dryRun}`);
  if (args.tenantId) {
    console.log(`Tenant ID filter: ${args.tenantId}`);
  }
  console.log();

  const sourceClient = new Client({ connectionString: SOURCE_DATABASE_URL, ssl: SSL_CONFIG });
  const destClient = new Client({ connectionString: DEST_DATABASE_URL, ssl: SSL_CONFIG });

  try {
    // Show connection info (masked) for debugging
    const maskUrl = (url) => {
      try {
        const parsed = new URL(url);
        return `${parsed.protocol}//${parsed.username}:****@${parsed.host}${parsed.pathname}`;
      } catch {
        return '(invalid URL format)';
      }
    };
    
    console.log('Connecting to databases...');
    console.log(`  Source: ${maskUrl(SOURCE_DATABASE_URL)}`);
    console.log(`  Dest: ${maskUrl(DEST_DATABASE_URL)}`);
    
    await sourceClient.connect();
    console.log('  Connected to source database');
    await destClient.connect();
    console.log('  Connected to destination database');

    // Fetch organizations with logos from source
    console.log('\nFetching organizations with logos from source...');
    const sourceResult = await sourceClient.query(`
      SELECT id, name, logo_url
      FROM organization
      WHERE logo_url IS NOT NULL AND logo_url != ''
    `);
    
    console.log(`Found ${sourceResult.rows.length} organizations with logos in source`);

    if (sourceResult.rows.length === 0) {
      console.log('\nNo organizations with logos found in source database.');
      return;
    }

    // Show source organizations
    console.log('\nSource organizations with logos:');
    for (const org of sourceResult.rows) {
      console.log(`  - ${org.name} (${org.id}): ${org.logo_url?.substring(0, 60)}...`);
    }

    // Build maps for matching: by ID and by name
    const logoByIdMap = new Map();
    const logoByNameMap = new Map();
    for (const org of sourceResult.rows) {
      logoByIdMap.set(org.id, org.logo_url);
      // Use lowercase name for case-insensitive matching
      logoByNameMap.set(org.name.toLowerCase().trim(), { logo_url: org.logo_url, name: org.name });
    }

    // Fetch ALL organizations from destination (we'll match by ID or name)
    console.log('\nFetching organizations from destination...');
    let destQuery = `
      SELECT id, name, logo_url, tenant_id
      FROM organization
    `;
    const destParams = [];

    if (args.tenantId) {
      destQuery = `
        SELECT id, name, logo_url, tenant_id
        FROM organization
        WHERE tenant_id = $1
      `;
      destParams.push(args.tenantId);
    }

    const destResult = await destClient.query(destQuery, destParams);
    console.log(`Found ${destResult.rows.length} organizations in destination`);

    if (destResult.rows.length === 0) {
      console.log('\nNo organizations found in destination database.');
      return;
    }

    // Find matching organizations (by ID first, then by name as fallback)
    const matchedOrgs = [];
    let matchedById = 0;
    let matchedByName = 0;

    for (const destOrg of destResult.rows) {
      // Try ID match first
      if (logoByIdMap.has(destOrg.id)) {
        matchedOrgs.push({
          destOrg,
          newLogoUrl: logoByIdMap.get(destOrg.id),
          matchType: 'id'
        });
        matchedById++;
      } 
      // Fallback to name match
      else if (logoByNameMap.has(destOrg.name.toLowerCase().trim())) {
        const sourceMatch = logoByNameMap.get(destOrg.name.toLowerCase().trim());
        matchedOrgs.push({
          destOrg,
          newLogoUrl: sourceMatch.logo_url,
          matchType: 'name'
        });
        matchedByName++;
      }
    }

    console.log(`\nMatching results:`);
    console.log(`  Matched by ID: ${matchedById}`);
    console.log(`  Matched by name: ${matchedByName}`);
    console.log(`  Total matches: ${matchedOrgs.length}`);

    if (matchedOrgs.length === 0) {
      console.log('\nNo matching organizations found.');
      console.log('Source org names:');
      for (const org of sourceResult.rows) {
        console.log(`  - "${org.name}"`);
      }
      return;
    }

    // Update organizations in destination
    console.log('\n' + '-'.repeat(80));
    console.log('UPDATING LOGOS');
    console.log('-'.repeat(80));

    let updated = 0;
    let skipped = 0;
    let errors = 0;

    if (!args.dryRun) {
      await destClient.query('BEGIN');
    }

    for (const match of matchedOrgs) {
      const { destOrg, newLogoUrl, matchType } = match;

      if (destOrg.logo_url === newLogoUrl) {
        console.log(`  [SKIP] ${destOrg.name}: Logo already matches (matched by ${matchType})`);
        skipped++;
        continue;
      }

      if (args.dryRun) {
        console.log(`  [DRY RUN] Would update ${destOrg.name} (matched by ${matchType}):`);
        console.log(`    Old: ${destOrg.logo_url || '(none)'}`);
        console.log(`    New: ${newLogoUrl}`);
        updated++;
      } else {
        try {
          await destClient.query(
            'UPDATE organization SET logo_url = $1 WHERE id = $2',
            [newLogoUrl, destOrg.id]
          );
          console.log(`  [UPDATED] ${destOrg.name} (matched by ${matchType}): ${newLogoUrl.substring(0, 50)}...`);
          updated++;
        } catch (error) {
          console.error(`  [ERROR] ${destOrg.name}: ${error.message}`);
          errors++;
        }
      }
    }

    if (!args.dryRun) {
      if (errors > 0) {
        console.log('\nRolling back due to errors...');
        await destClient.query('ROLLBACK');
      } else {
        await destClient.query('COMMIT');
      }
    }

    // Summary
    console.log('\n' + '='.repeat(80));
    console.log('SUMMARY');
    console.log('='.repeat(80));
    console.log(`  Organizations in source with logos: ${sourceResult.rows.length}`);
    console.log(`  Matched by ID: ${matchedById}`);
    console.log(`  Matched by name: ${matchedByName}`);
    console.log(`  Total matches: ${matchedOrgs.length}`);
    console.log(`  ${args.dryRun ? 'Would update' : 'Updated'}: ${updated}`);
    console.log(`  Skipped: ${skipped}`);
    if (errors > 0) {
      console.log(`  Errors: ${errors}`);
    }

    if (args.dryRun) {
      console.log('\n[DRY RUN] No changes were made. Remove --dry-run to execute migration.');
    } else if (errors === 0 && updated > 0) {
      console.log('\nLogo migration complete!');
    }

  } catch (error) {
    console.error('\nMigration failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await sourceClient.end();
    await destClient.end();
  }
}

main();
