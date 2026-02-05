#!/usr/bin/env node
/**
 * Migration Script: Move Logo Files from Private to Public Bucket
 * 
 * This script finds all submission_document records for logo uploads stored in the 
 * private-uploads bucket and migrates them to the public-assets bucket.
 * 
 * The submission_document table is the source of truth for document display in the
 * Due Diligence workflow, supporting versioning and approval status.
 * 
 * Usage:
 *   node scripts/migrate-logos-to-public.mjs --dry-run    # Preview changes
 *   node scripts/migrate-logos-to-public.mjs              # Execute migration
 *   node scripts/migrate-logos-to-public.mjs --limit=10   # Limit to first 10 files
 * 
 * Environment Variables Required:
 *   DEST_SUPABASE_KEY - Supabase service role key
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://lvmzliemqnieeoruhkik.supabase.co';
const supabaseKey = process.env.DEST_SUPABASE_KEY;

if (!supabaseKey) {
  console.error('ERROR: DEST_SUPABASE_KEY environment variable is required');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const PRIVATE_BUCKET = 'private-uploads';
const PUBLIC_BUCKET = 'public-assets';

// Organisation Logo form field ID (from ESO Long form, Partner Long form, SO Long form)
const LOGO_FIELD_ID = 'field_1768830324467';

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const limitArg = args.find(a => a.startsWith('--limit='));
const globalLimit = limitArg ? parseInt(limitArg.split('=')[1]) : null;

console.log('='.repeat(60));
console.log('Logo Files Migration: Private -> Public Bucket');
console.log('='.repeat(60));
console.log(`Mode: ${isDryRun ? 'DRY RUN (no changes will be made)' : 'EXECUTE'}`);
console.log(`Target: submission_document records for field ${LOGO_FIELD_ID}`);
if (globalLimit) console.log(`Limit: ${globalLimit} files`);
console.log('');

/**
 * Extract bucket name from file_url
 */
function extractBucket(fileUrl) {
  if (!fileUrl) return null;
  
  // Check for secure-url pattern with bucket param
  const match = fileUrl.match(/bucket=([^&]+)/);
  if (match) return decodeURIComponent(match[1]);
  
  // Check for direct Supabase storage URL pattern
  if (fileUrl.includes('/storage/v1/object/public/')) {
    const urlMatch = fileUrl.match(/\/storage\/v1\/object\/public\/([^\/]+)\//);
    if (urlMatch) return urlMatch[1];
  }
  
  return null;
}

/**
 * Extract storage path from file_url
 */
function extractStoragePath(fileUrl) {
  if (!fileUrl) return null;
  
  // Check for secure-url pattern with path param
  const match = fileUrl.match(/path=([^&]+)/);
  if (match) return decodeURIComponent(match[1]);
  
  // Check for direct Supabase storage URL pattern
  if (fileUrl.includes('/storage/v1/object/public/')) {
    const urlMatch = fileUrl.match(/\/storage\/v1\/object\/public\/[^\/]+\/(.+)$/);
    if (urlMatch) return urlMatch[1];
  }
  
  return null;
}

/**
 * Check if a document needs migration (in private bucket)
 */
function needsMigration(doc) {
  const bucket = extractBucket(doc.file_url);
  const storagePath = extractStoragePath(doc.file_url);
  
  if (!storagePath) return false;
  
  return bucket === PRIVATE_BUCKET;
}

async function findDocumentsToMigrate() {
  console.log('Step 1: Finding submission_document records for logos in private bucket...');
  
  // Get all submission_document records for the logo field
  const { data: documents, error } = await supabase
    .from('submission_document')
    .select('id, form_submission_id, field_name, original_file_name, file_url, file_name, file_size, mime_type, version, is_current_version, status, tenant_id')
    .eq('field_name', LOGO_FIELD_ID);
  
  if (error) {
    console.error('Error fetching documents:', error.message);
    return [];
  }
  
  // Filter to those in private bucket
  const toMigrate = (documents || []).filter(doc => needsMigration(doc));
  
  console.log(`Found ${documents?.length || 0} logo documents, ${toMigrate.length} need migration`);
  console.log('');
  
  return toMigrate;
}

async function migrateDocument(doc) {
  const storagePath = extractStoragePath(doc.file_url);
  
  if (!storagePath) {
    return { success: false, error: 'No storage path found in file_url' };
  }
  
  try {
    // Step 1: Download file from private bucket
    const { data: fileData, error: downloadError } = await supabase.storage
      .from(PRIVATE_BUCKET)
      .download(storagePath);
    
    if (downloadError) {
      return { success: false, error: `Download failed: ${downloadError.message}` };
    }
    
    // Step 2: Upload to public bucket (same path)
    const { error: uploadError } = await supabase.storage
      .from(PUBLIC_BUCKET)
      .upload(storagePath, fileData, {
        contentType: doc.mime_type || 'application/octet-stream',
        upsert: true
      });
    
    if (uploadError) {
      return { success: false, error: `Upload failed: ${uploadError.message}` };
    }
    
    // Step 3: Get public URL
    const { data: publicUrlData } = supabase.storage
      .from(PUBLIC_BUCKET)
      .getPublicUrl(storagePath);
    
    // Step 4: Update submission_document record
    const { error: updateError } = await supabase
      .from('submission_document')
      .update({ 
        file_url: publicUrlData.publicUrl,
        updated_at: new Date().toISOString()
      })
      .eq('id', doc.id);
    
    if (updateError) {
      return { success: false, error: `DB update failed: ${updateError.message}` };
    }
    
    return { success: true, newUrl: publicUrlData.publicUrl };
    
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function main() {
  let documentsToMigrate = await findDocumentsToMigrate();
  
  if (documentsToMigrate.length === 0) {
    console.log('No documents need migration.');
    return;
  }
  
  // Apply limit if specified
  if (globalLimit && documentsToMigrate.length > globalLimit) {
    console.log(`Limiting to first ${globalLimit} documents`);
    documentsToMigrate = documentsToMigrate.slice(0, globalLimit);
  }
  
  console.log('Step 2: Migrating files...');
  console.log('');
  
  let successCount = 0;
  let errorCount = 0;
  const errors = [];
  
  for (const doc of documentsToMigrate) {
    const storagePath = extractStoragePath(doc.file_url);
    const displayName = doc.original_file_name || doc.file_name || storagePath;
    
    if (isDryRun) {
      console.log(`  [DRY RUN] Would migrate: ${displayName}`);
      console.log(`    Document ID: ${doc.id}`);
      console.log(`    Version: ${doc.version} (current: ${doc.is_current_version})`);
      console.log(`    Status: ${doc.status}`);
      console.log(`    From: ${PRIVATE_BUCKET}/${storagePath}`);
      console.log(`    To: ${PUBLIC_BUCKET}/${storagePath}`);
      console.log('');
      successCount++;
    } else {
      console.log(`  Migrating: ${displayName}`);
      
      const result = await migrateDocument(doc);
      
      if (result.success) {
        console.log(`    Success: ${result.newUrl}`);
        successCount++;
      } else {
        console.log(`    ERROR: ${result.error}`);
        errorCount++;
        errors.push({ doc, error: result.error });
      }
    }
  }
  
  console.log('');
  console.log('='.repeat(60));
  console.log('Migration Summary');
  console.log('='.repeat(60));
  console.log(`Files migrated: ${successCount}`);
  console.log(`Errors: ${errorCount}`);
  
  if (errors.length > 0) {
    console.log('');
    console.log('Error details:');
    errors.forEach(({ doc, error }) => {
      console.log(`  - ${doc.original_file_name || doc.id}: ${error}`);
    });
  }
  
  if (isDryRun) {
    console.log('');
    console.log('This was a DRY RUN. No changes were made.');
    console.log('Run without --dry-run to execute the migration.');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
