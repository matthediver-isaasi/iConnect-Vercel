#!/usr/bin/env node

/**
 * Tenant Data Migration Script
 * Migrates data from single-tenant source to multi-tenant destination
 * 
 * Usage: node scripts/migrations/migrate-tenant.js --tenant-id=YOUR_TENANT_ID [--dry-run] [--tables=table1,table2]
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import pg from 'pg';

const { Client } = pg;

let SOURCE_DATABASE_URL = process.env.SOURCE_DATABASE_URL;
let DEST_DATABASE_URL = process.env.DEST_DATABASE_URL;

const SSL_CONFIG = true;

function parseArgs() {
  const args = {
    tenantId: null,
    dryRun: false,
    tables: null,
    help: false,
    sourceUrl: null,
    destUrl: null
  };

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--tenant-id=')) {
      args.tenantId = arg.split('=')[1];
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg.startsWith('--tables=')) {
      args.tables = arg.split('=')[1].split(',').map(t => t.trim());
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
Tenant Data Migration Script

Usage: node scripts/migrations/migrate-tenant.js --tenant-id=YOUR_TENANT_ID [options]

Options:
  --tenant-id=ID    Required. The tenant ID to assign to migrated records
  --dry-run         Show what would be migrated without making changes
  --tables=t1,t2    Only migrate specific tables (comma-separated)
  --source=URL      Override SOURCE_DATABASE_URL environment variable
  --dest=URL        Override DEST_DATABASE_URL environment variable
  --help, -h        Show this help message

Examples:
  node scripts/migrations/migrate-tenant.js --tenant-id=abc123
  node scripts/migrations/migrate-tenant.js --tenant-id=abc123 --dry-run
  node scripts/migrations/migrate-tenant.js --tenant-id=abc123 --tables=member,organization
  node scripts/migrations/migrate-tenant.js --tenant-id=abc123 --source=postgresql://... --dest=postgresql://...
`);
}

async function getTableColumns(client, tableName) {
  const result = await client.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `, [tableName]);
  return result.rows;
}

async function getPrimaryKey(client, tableName) {
  const result = await client.query(`
    SELECT a.attname as column_name
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = $1::regclass
    AND i.indisprimary
  `, [tableName]);
  return result.rows.length > 0 ? result.rows[0].column_name : 'id';
}

function parseSupabaseStorageUrl(url) {
  if (!url) return { bucket: null, storagePath: null };
  
  try {
    const match = url.match(/\/storage\/v1\/object\/public\/([^\/]+)\/(.+)$/);
    if (match) {
      return {
        bucket: match[1],
        storagePath: match[2]
      };
    }
  } catch (e) {
    // URL parsing failed
  }
  return { bucket: null, storagePath: null };
}

function applyTableTransformations(tableName, row, destColumnNames) {
  const transformedRow = { ...row };
  
  if (tableName === 'file_repository') {
    const needsBucket = destColumnNames.includes('bucket') && !row.bucket;
    const needsStoragePath = destColumnNames.includes('storage_path') && !row.storage_path;
    
    if (needsBucket || needsStoragePath) {
      const { bucket, storagePath } = parseSupabaseStorageUrl(row.file_url);
      
      if (needsBucket) {
        transformedRow.bucket = bucket;
        if (!bucket && row.file_url) {
          console.warn(`  Warning: Could not parse bucket from URL for file ${row.id}`);
        }
      }
      
      if (needsStoragePath) {
        transformedRow.storage_path = storagePath;
        if (!storagePath && row.file_url) {
          console.warn(`  Warning: Could not parse storage_path from URL for file ${row.id}`);
        }
      }
    }
  }
  
  return transformedRow;
}

async function migrateTable(sourceClient, destClient, tableName, tenantId, dryRun) {
  console.log(`\nMigrating table: ${tableName}`);
  console.log('-'.repeat(50));

  const sourceColumns = await getTableColumns(sourceClient, tableName);
  const destColumns = await getTableColumns(destClient, tableName);
  const destColumnNames = destColumns.map(c => c.column_name);
  const sourceColumnNames = sourceColumns.map(c => c.column_name);

  const hasTenantId = destColumnNames.includes('tenant_id');
  const sourceHasTenantId = sourceColumnNames.includes('tenant_id');

  const primaryKey = await getPrimaryKey(destClient, tableName);
  console.log(`Primary key: ${primaryKey}`);
  console.log(`Destination has tenant_id: ${hasTenantId}`);

  const countResult = await sourceClient.query(`SELECT COUNT(*) as count FROM "${tableName}"`);
  const totalRows = parseInt(countResult.rows[0].count, 10);
  console.log(`Source rows: ${totalRows}`);

  if (totalRows === 0) {
    console.log('No rows to migrate.');
    return { table: tableName, migrated: 0, inserted: 0, updated: 0 };
  }

  const selectColumns = sourceColumnNames.filter(c => destColumnNames.includes(c));
  
  const sourceData = await sourceClient.query(`SELECT * FROM "${tableName}"`);
  
  let inserted = 0;
  let updated = 0;

  for (const row of sourceData.rows) {
    const transformedRow = applyTableTransformations(tableName, row, destColumnNames);
    
    const destRow = {};
    for (const col of selectColumns) {
      destRow[col] = transformedRow[col];
    }
    
    if (hasTenantId && !sourceHasTenantId) {
      destRow['tenant_id'] = tenantId;
    }
    
    if (tableName === 'file_repository') {
      if (destColumnNames.includes('bucket') && transformedRow.bucket) {
        destRow['bucket'] = transformedRow.bucket;
      }
      if (destColumnNames.includes('storage_path') && transformedRow.storage_path) {
        destRow['storage_path'] = transformedRow.storage_path;
      }
    }

    const columns = Object.keys(destRow);
    const values = Object.values(destRow);
    const placeholders = columns.map((_, i) => `$${i + 1}`);

    const updateCols = columns.filter(c => c !== primaryKey);
    const updateSet = updateCols.map((col, i) => {
      const idx = columns.indexOf(col);
      return `"${col}" = $${idx + 1}`;
    }).join(', ');

    const sql = `
      INSERT INTO "${tableName}" (${columns.map(c => `"${c}"`).join(', ')})
      VALUES (${placeholders.join(', ')})
      ON CONFLICT ("${primaryKey}") 
      DO UPDATE SET ${updateSet}
      RETURNING (xmax = 0) AS inserted
    `;

    if (dryRun) {
      console.log(`  [DRY RUN] Would upsert row with ${primaryKey}=${row[primaryKey]}`);
    } else {
      try {
        const result = await destClient.query(sql, values);
        if (result.rows[0].inserted) {
          inserted++;
        } else {
          updated++;
        }
      } catch (error) {
        console.error(`  Error upserting row ${row[primaryKey]}: ${error.message}`);
      }
    }
  }

  if (!dryRun) {
    console.log(`Migrated: ${inserted} inserted, ${updated} updated`);
  } else {
    console.log(`[DRY RUN] Would migrate ${totalRows} rows`);
  }

  return { table: tableName, migrated: totalRows, inserted, updated };
}

async function getSharedTables(sourceClient, destClient) {
  const sourceResult = await sourceClient.query(`
    SELECT table_name FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);
  const destResult = await destClient.query(`
    SELECT table_name FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);

  const sourceSet = new Set(sourceResult.rows.map(r => r.table_name));
  const destSet = new Set(destResult.rows.map(r => r.table_name));

  return [...sourceSet].filter(t => destSet.has(t)).sort();
}

async function getMigrationOrder(sourceClient, destClient, tables) {
  const order = [];
  const visited = new Set();
  
  const fkResult = await destClient.query(`
    SELECT
      tc.table_name,
      ccu.table_name AS foreign_table_name
    FROM information_schema.table_constraints AS tc
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
  `);

  const dependencies = {};
  for (const table of tables) {
    dependencies[table] = [];
  }
  
  for (const row of fkResult.rows) {
    if (tables.includes(row.table_name) && tables.includes(row.foreign_table_name)) {
      dependencies[row.table_name].push(row.foreign_table_name);
    }
  }

  function visit(table) {
    if (visited.has(table)) return;
    visited.add(table);
    for (const dep of dependencies[table] || []) {
      visit(dep);
    }
    order.push(table);
  }

  for (const table of tables) {
    visit(table);
  }

  return order;
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

  if (!SOURCE_DATABASE_URL || !DEST_DATABASE_URL) {
    console.error('Error: SOURCE_DATABASE_URL and DEST_DATABASE_URL must be set');
    console.error('Use --source=URL and --dest=URL or set environment variables');
    process.exit(1);
  }

  console.log('='.repeat(80));
  console.log('TENANT DATA MIGRATION');
  console.log('='.repeat(80));
  console.log();
  console.log(`Tenant ID: ${args.tenantId}`);
  console.log(`Dry Run: ${args.dryRun}`);
  if (args.tables) {
    console.log(`Tables: ${args.tables.join(', ')}`);
  }
  console.log();

  const sourceClient = new Client({ connectionString: SOURCE_DATABASE_URL, ssl: SSL_CONFIG });
  const destClient = new Client({ connectionString: DEST_DATABASE_URL, ssl: SSL_CONFIG });

  try {
    console.log('Connecting to databases...');
    await sourceClient.connect();
    await destClient.connect();

    let tablesToMigrate = args.tables || await getSharedTables(sourceClient, destClient);
    
    const skipTables = ['tenant', 'platform_owner', 'platform_owner_session', 'platform_preferences'];
    tablesToMigrate = tablesToMigrate.filter(t => !skipTables.includes(t));

    console.log(`\nTables to migrate: ${tablesToMigrate.length}`);
    
    const orderedTables = await getMigrationOrder(sourceClient, destClient, tablesToMigrate);
    console.log('Migration order (respecting foreign keys):');
    orderedTables.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));

    if (!args.dryRun) {
      await destClient.query('BEGIN');
    }

    const results = [];
    const failedTables = [];
    
    for (const table of orderedTables) {
      try {
        if (!args.dryRun) {
          await destClient.query(`SAVEPOINT sp_${table.replace(/[^a-z0-9]/gi, '_')}`);
        }
        const result = await migrateTable(sourceClient, destClient, table, args.tenantId, args.dryRun);
        results.push(result);
        if (!args.dryRun) {
          await destClient.query(`RELEASE SAVEPOINT sp_${table.replace(/[^a-z0-9]/gi, '_')}`);
        }
      } catch (tableError) {
        console.error(`\nError migrating table ${table}: ${tableError.message}`);
        failedTables.push({ table, error: tableError.message });
        if (!args.dryRun) {
          await destClient.query(`ROLLBACK TO SAVEPOINT sp_${table.replace(/[^a-z0-9]/gi, '_')}`);
        }
        results.push({ table, migrated: 0, inserted: 0, updated: 0, error: tableError.message });
      }
    }

    if (!args.dryRun) {
      if (failedTables.length > 0) {
        console.log('\nSome tables failed. Rolling back entire migration...');
        await destClient.query('ROLLBACK');
      } else {
        await destClient.query('COMMIT');
      }
    }

    console.log('\n' + '='.repeat(80));
    console.log('MIGRATION SUMMARY');
    console.log('='.repeat(80));
    console.log();
    console.log(String('Table').padEnd(35) + String('Rows').padEnd(10) + String('Inserted').padEnd(12) + 'Updated');
    console.log('-'.repeat(80));
    
    let totalInserted = 0;
    let totalUpdated = 0;
    
    for (const r of results) {
      console.log(
        String(r.table).padEnd(35) + 
        String(r.migrated).padEnd(10) + 
        String(r.inserted).padEnd(12) + 
        String(r.updated)
      );
      totalInserted += r.inserted;
      totalUpdated += r.updated;
    }
    
    console.log('-'.repeat(80));
    console.log(`Total: ${totalInserted} inserted, ${totalUpdated} updated`);

    if (failedTables.length > 0) {
      console.log('\n' + '='.repeat(80));
      console.log('FAILED TABLES');
      console.log('='.repeat(80));
      for (const f of failedTables) {
        console.log(`  ${f.table}: ${f.error}`);
      }
      if (!args.dryRun) {
        console.log('\nAll changes have been rolled back due to errors.');
      }
    }

    if (args.dryRun) {
      console.log('\n[DRY RUN] No changes were made. Remove --dry-run to execute migration.');
    } else if (failedTables.length === 0) {
      console.log('\nMigration complete!');
    }

  } catch (error) {
    if (!args.dryRun) {
      await destClient.query('ROLLBACK');
    }
    console.error('Migration failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await sourceClient.end();
    await destClient.end();
  }
}

main();
