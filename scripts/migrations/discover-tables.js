#!/usr/bin/env node

/**
 * Database Discovery Script
 * Compares tables between source (single-tenant) and destination (multi-tenant) databases
 * 
 * Usage: node scripts/migrations/discover-tables.js
 */

import pg from 'pg';

const { Client } = pg;

const SOURCE_DATABASE_URL = process.env.SOURCE_DATABASE_URL;
const DEST_DATABASE_URL = process.env.DEST_DATABASE_URL;

if (!SOURCE_DATABASE_URL || !DEST_DATABASE_URL) {
  console.error('Error: SOURCE_DATABASE_URL and DEST_DATABASE_URL must be set');
  process.exit(1);
}

const SSL_CONFIG = { rejectUnauthorized: false };

async function getTableInfo(client, dbName) {
  const tablesResult = await client.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  
  const tables = {};
  
  for (const row of tablesResult.rows) {
    const tableName = row.table_name;
    
    const countResult = await client.query(`SELECT COUNT(*) as count FROM "${tableName}"`);
    const count = parseInt(countResult.rows[0].count, 10);
    
    const columnsResult = await client.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `, [tableName]);
    
    tables[tableName] = {
      count,
      columns: columnsResult.rows.map(c => c.column_name),
      hasTenantId: columnsResult.rows.some(c => c.column_name === 'tenant_id')
    };
  }
  
  return tables;
}

async function main() {
  console.log('='.repeat(80));
  console.log('DATABASE DISCOVERY - Comparing Source and Destination');
  console.log('='.repeat(80));
  console.log();

  const sourceClient = new Client({ connectionString: SOURCE_DATABASE_URL, ssl: SSL_CONFIG });
  const destClient = new Client({ connectionString: DEST_DATABASE_URL, ssl: SSL_CONFIG });

  try {
    console.log('Connecting to source database (single-tenant)...');
    await sourceClient.connect();
    console.log('Connecting to destination database (multi-tenant)...');
    await destClient.connect();
    console.log();

    console.log('Fetching table information from source...');
    const sourceTables = await getTableInfo(sourceClient, 'source');
    console.log(`Found ${Object.keys(sourceTables).length} tables in source`);
    
    console.log('Fetching table information from destination...');
    const destTables = await getTableInfo(destClient, 'destination');
    console.log(`Found ${Object.keys(destTables).length} tables in destination`);
    console.log();

    const sourceTableNames = new Set(Object.keys(sourceTables));
    const destTableNames = new Set(Object.keys(destTables));
    
    const sharedTables = [...sourceTableNames].filter(t => destTableNames.has(t));
    const sourceOnly = [...sourceTableNames].filter(t => !destTableNames.has(t));
    const destOnly = [...destTableNames].filter(t => !sourceTableNames.has(t));

    console.log('='.repeat(80));
    console.log('TABLES THAT NEED MIGRATION (exist in both databases)');
    console.log('='.repeat(80));
    console.log();
    console.log(String('Table Name').padEnd(40) + String('Source Count').padEnd(15) + String('Dest Count').padEnd(15) + 'Has tenant_id');
    console.log('-'.repeat(80));
    
    for (const table of sharedTables.sort()) {
      const sourceCount = sourceTables[table].count;
      const destCount = destTables[table].count;
      const hasTenantId = destTables[table].hasTenantId ? 'Yes' : 'No';
      console.log(
        String(table).padEnd(40) + 
        String(sourceCount).padEnd(15) + 
        String(destCount).padEnd(15) + 
        hasTenantId
      );
    }
    console.log();

    if (sourceOnly.length > 0) {
      console.log('='.repeat(80));
      console.log('TABLES ONLY IN SOURCE (may need migration or are deprecated)');
      console.log('='.repeat(80));
      console.log();
      for (const table of sourceOnly.sort()) {
        console.log(`  ${table} (${sourceTables[table].count} rows)`);
      }
      console.log();
    }

    if (destOnly.length > 0) {
      console.log('='.repeat(80));
      console.log('TABLES ONLY IN DESTINATION (new multi-tenant features)');
      console.log('='.repeat(80));
      console.log();
      for (const table of destOnly.sort()) {
        console.log(`  ${table} (${destTables[table].count} rows)`);
      }
      console.log();
    }

    console.log('='.repeat(80));
    console.log('SUMMARY');
    console.log('='.repeat(80));
    console.log(`Shared tables (need migration): ${sharedTables.length}`);
    console.log(`Source-only tables: ${sourceOnly.length}`);
    console.log(`Destination-only tables: ${destOnly.length}`);
    
    const totalSourceRecords = sharedTables.reduce((sum, t) => sum + sourceTables[t].count, 0);
    console.log(`Total records to migrate: ${totalSourceRecords}`);
    console.log();

    const tablesWithoutTenantId = sharedTables.filter(t => !destTables[t].hasTenantId);
    if (tablesWithoutTenantId.length > 0) {
      console.log('NOTE: These shared tables do NOT have tenant_id in destination:');
      tablesWithoutTenantId.forEach(t => console.log(`  - ${t}`));
      console.log('These tables will be migrated without adding tenant_id.');
      console.log();
    }

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  } finally {
    await sourceClient.end();
    await destClient.end();
  }
}

main();
