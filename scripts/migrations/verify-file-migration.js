#!/usr/bin/env node

/**
 * Verify File Migration Script
 * 
 * Checks the destination database for any records that still contain
 * URLs pointing to the source Supabase storage.
 * 
 * Usage:
 *   node scripts/migrations/verify-file-migration.js --tenant-id=<tenant-id>
 *   node scripts/migrations/verify-file-migration.js --tenant-id=<tenant-id> --tables=member,organization
 *   node scripts/migrations/verify-file-migration.js --tenant-id=<tenant-id> --verbose
 * 
 * Required Environment Variables:
 *   SOURCE_SUPABASE_URL - The source Supabase project URL (to identify source URLs)
 *   DEST_SUPABASE_URL   - The destination Supabase project URL
 *   DEST_SUPABASE_KEY   - The destination Supabase service role key
 */

import { createClient } from '@supabase/supabase-js';

const SOURCE_SUPABASE_URL = process.env.SOURCE_SUPABASE_URL;
const DEST_SUPABASE_URL = process.env.DEST_SUPABASE_URL;
const DEST_SUPABASE_KEY = process.env.DEST_SUPABASE_KEY;

function showHelp() {
  console.log(`
Verify File Migration Script
=============================

Checks the destination database for any records that still contain
URLs pointing to the source Supabase storage.

Usage:
  node scripts/migrations/verify-file-migration.js --tenant-id=<tenant-id> [options]

Options:
  --tenant-id=<id>    Required. The tenant ID to verify
  --tables=<list>     Optional. Comma-separated list of tables to check
  --verbose           Optional. Show detailed information about each found URL
  --help, -h          Show this help message

Supported Tables:
  file_repository, form_submission, system_settings, member, organization,
  tenant, news_post, i_edit_page, resource, event, job_posting,
  form_draft_submission, blog_post, page_banner, speaker, card_deck,
  navigation_item, i_edit_page_element, wall_of_fame

Required Environment Variables:
  SOURCE_SUPABASE_URL - The source Supabase project URL
  DEST_SUPABASE_URL   - The destination Supabase project URL
  DEST_SUPABASE_KEY   - The destination Supabase service role key
`);
}

function parseArgs() {
  const args = {
    tenantId: null,
    tables: null,
    verbose: false,
    help: false
  };

  for (const arg of process.argv.slice(2)) {
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg.startsWith('--tenant-id=')) {
      args.tenantId = arg.split('=')[1];
    } else if (arg.startsWith('--tables=')) {
      args.tables = arg.split('=')[1].split(',').map(t => t.trim());
    } else if (arg === '--verbose') {
      args.verbose = true;
    }
  }

  return args;
}

function isSourceStorageUrl(url, sourceSupabaseUrl) {
  if (!url || typeof url !== 'string') return false;
  
  try {
    const sourceHost = new URL(sourceSupabaseUrl).host;
    return url.includes(sourceHost) && url.includes('/storage/');
  } catch {
    return false;
  }
}

function findUrlsInValue(value, sourceUrl, results = [], path = '') {
  if (!value) return results;
  
  if (typeof value === 'string') {
    if (isSourceStorageUrl(value, sourceUrl)) {
      results.push({ path, url: value });
    }
    return results;
  }
  
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      findUrlsInValue(item, sourceUrl, results, `${path}[${index}]`);
    });
    return results;
  }
  
  if (typeof value === 'object') {
    for (const [key, val] of Object.entries(value)) {
      const fieldPath = path ? `${path}.${key}` : key;
      if (key.includes('url') || key.includes('image') || key.includes('file') || key.includes('src')) {
        if (typeof val === 'string' && isSourceStorageUrl(val, sourceUrl)) {
          results.push({ path: fieldPath, url: val });
        }
      }
      findUrlsInValue(val, sourceUrl, results, fieldPath);
    }
    return results;
  }
  
  return results;
}

async function checkTable(destClient, tableName, tenantId, sourceUrl, verbose) {
  const results = {
    table: tableName,
    recordsWithSourceUrls: 0,
    totalSourceUrls: 0,
    details: []
  };

  try {
    let query = destClient.from(tableName).select('*');
    
    if (tableName === 'tenant') {
      query = query.eq('id', tenantId);
    } else {
      query = query.eq('tenant_id', tenantId);
    }
    
    const { data, error } = await query;
    
    if (error) {
      if (error.code === '42703') {
        return { ...results, error: 'No tenant_id column' };
      }
      return { ...results, error: error.message };
    }

    for (const record of data || []) {
      const foundUrls = findUrlsInValue(record, sourceUrl, [], '');
      
      if (foundUrls.length > 0) {
        results.recordsWithSourceUrls++;
        results.totalSourceUrls += foundUrls.length;
        
        if (verbose) {
          results.details.push({
            id: record.id,
            urls: foundUrls.map(f => ({ field: f.path, url: f.url }))
          });
        }
      }
    }
  } catch (err) {
    results.error = err.message;
  }

  return results;
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

  if (!SOURCE_SUPABASE_URL || !DEST_SUPABASE_URL || !DEST_SUPABASE_KEY) {
    console.error('Error: Missing required environment variables');
    console.error('Required: SOURCE_SUPABASE_URL, DEST_SUPABASE_URL, DEST_SUPABASE_KEY');
    process.exit(1);
  }

  const destClient = createClient(DEST_SUPABASE_URL, DEST_SUPABASE_KEY);

  console.log('='.repeat(60));
  console.log('Verify File Migration');
  console.log('='.repeat(60));
  console.log(`Tenant ID: ${args.tenantId}`);
  console.log(`Source URL pattern: ${SOURCE_SUPABASE_URL}`);
  console.log(`Verbose: ${args.verbose}`);
  console.log('='.repeat(60));
  console.log('');

  const allTables = [
    'file_repository',
    'form_submission',
    'system_settings',
    'member',
    'organization',
    'tenant',
    'news_post',
    'i_edit_page',
    'resource',
    'event',
    'job_posting',
    'form_draft_submission',
    'blog_post',
    'page_banner',
    'speaker',
    'card_deck',
    'navigation_item',
    'i_edit_page_element',
  ];

  const tablesToCheck = args.tables || allTables;
  const allResults = [];
  let totalRecords = 0;
  let totalUrls = 0;

  for (const table of tablesToCheck) {
    process.stdout.write(`Checking ${table}... `);
    const result = await checkTable(destClient, table, args.tenantId, SOURCE_SUPABASE_URL, args.verbose);
    allResults.push(result);
    
    if (result.error) {
      console.log(`Error: ${result.error}`);
    } else if (result.recordsWithSourceUrls > 0) {
      console.log(`Found ${result.recordsWithSourceUrls} records with ${result.totalSourceUrls} source URLs`);
      totalRecords += result.recordsWithSourceUrls;
      totalUrls += result.totalSourceUrls;
    } else {
      console.log('OK');
    }
  }

  console.log('');
  console.log('='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  
  const tablesWithIssues = allResults.filter(r => r.recordsWithSourceUrls > 0);
  
  if (tablesWithIssues.length === 0) {
    console.log('');
    console.log('All checked tables are clean - no source URLs found!');
    console.log('');
  } else {
    console.log('');
    console.log(`Found ${totalUrls} source URLs in ${totalRecords} records across ${tablesWithIssues.length} tables:`);
    console.log('');
    
    for (const result of tablesWithIssues) {
      console.log(`  ${result.table}: ${result.recordsWithSourceUrls} records, ${result.totalSourceUrls} URLs`);
      
      if (args.verbose && result.details.length > 0) {
        for (const detail of result.details) {
          console.log(`    Record ID: ${detail.id}`);
          for (const urlInfo of detail.urls) {
            console.log(`      - ${urlInfo.field}: ${urlInfo.url.substring(0, 80)}...`);
          }
        }
      }
    }
    console.log('');
  }

  const tablesWithErrors = allResults.filter(r => r.error);
  if (tablesWithErrors.length > 0) {
    console.log('Tables with errors (skipped):');
    for (const result of tablesWithErrors) {
      console.log(`  ${result.table}: ${result.error}`);
    }
    console.log('');
  }

  console.log('='.repeat(60));
  
  process.exit(tablesWithIssues.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
