#!/usr/bin/env node
/**
 * Migration Script: Move Logo Files from Private to Public Bucket
 * 
 * This script finds all form submissions with logo file uploads stored in the 
 * private-uploads bucket and migrates them to the public-assets bucket.
 * 
 * It targets the "Organisation Logo" custom field (ID: c574e948-a555-4d09-aca4-4b9a14c55374)
 * used in Due Diligence forms.
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
// The field is type "custom_field" referencing c574e948-a555-4d09-aca4-4b9a14c55374
// but stored in submission_data under the form field ID
const LOGO_FIELD_ID = 'field_1768830324467';

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const limitArg = args.find(a => a.startsWith('--limit='));
const globalLimit = limitArg ? parseInt(limitArg.split('=')[1]) : null;

console.log('='.repeat(60));
console.log('Logo Files Migration: Private -> Public Bucket');
console.log('='.repeat(60));
console.log(`Mode: ${isDryRun ? 'DRY RUN (no changes will be made)' : 'EXECUTE'}`);
console.log(`Target field: Organisation Logo (${LOGO_FIELD_ID})`);
if (globalLimit) console.log(`Limit: ${globalLimit} files`);
console.log('');

/**
 * Parse a file field value into a normalized structure
 */
function parseFileValue(rawValue) {
  if (!rawValue) return null;
  
  let parsedValue = rawValue;
  let isJsonString = false;
  
  if (typeof rawValue === 'string') {
    if (rawValue.startsWith('{') || rawValue.startsWith('[')) {
      try {
        parsedValue = JSON.parse(rawValue);
        isJsonString = true;
      } catch (e) {
        return null;
      }
    } else {
      return null;
    }
  }
  
  if (Array.isArray(parsedValue)) {
    return {
      isArray: true,
      isJsonString,
      files: parsedValue.filter(f => f && typeof f === 'object')
    };
  }
  
  if (typeof parsedValue === 'object' && parsedValue !== null) {
    return {
      isArray: false,
      isJsonString,
      files: [parsedValue]
    };
  }
  
  return null;
}

/**
 * Extract bucket name from file object
 * The bucket can be stored as a field or embedded in the file_url
 */
function extractBucket(file) {
  if (!file) return null;
  
  // Check explicit bucket field
  if (file.bucket) return file.bucket;
  
  // Extract from file_url query parameter
  if (file.file_url) {
    const match = file.file_url.match(/bucket=([^&]+)/);
    if (match) return decodeURIComponent(match[1]);
  }
  
  return null;
}

/**
 * Extract storage path from file object
 * The path can be stored as a field or embedded in the file_url
 */
function extractStoragePath(file) {
  if (!file) return null;
  
  // Check explicit storage_path field
  if (file.storage_path) return file.storage_path;
  
  // Extract from file_url query parameter
  if (file.file_url) {
    const match = file.file_url.match(/path=([^&]+)/);
    if (match) return decodeURIComponent(match[1]);
  }
  
  return null;
}

/**
 * Check if a file needs migration (in private bucket)
 */
function needsMigration(file) {
  const bucket = extractBucket(file);
  const storagePath = extractStoragePath(file);
  
  if (!storagePath) return false;
  
  return bucket === PRIVATE_BUCKET;
}

async function findSubmissionsToMigrate() {
  console.log('Step 1: Finding form submissions with logos in private bucket...');
  
  // Get all form submissions that have the logo field
  const { data: submissions, error } = await supabase
    .from('form_submission')
    .select('id, form_id, form_name, submission_data, tenant_id')
    .not('submission_data', 'is', null);
  
  if (error) {
    console.error('Error fetching submissions:', error.message);
    return [];
  }
  
  const toMigrate = [];
  
  for (const sub of submissions || []) {
    if (!sub.submission_data) continue;
    
    const logoValue = sub.submission_data[LOGO_FIELD_ID];
    if (!logoValue) continue;
    
    const fileInfo = parseFileValue(logoValue);
    if (!fileInfo) continue;
    
    // Find files that need migration
    const filesToMigrate = fileInfo.files
      .map((file, index) => ({ file, index, needsMigration: needsMigration(file) }))
      .filter(item => item.needsMigration);
    
    if (filesToMigrate.length > 0) {
      toMigrate.push({
        submissionId: sub.id,
        formId: sub.form_id,
        formName: sub.form_name,
        tenantId: sub.tenant_id,
        fileInfo,
        filesToMigrate
      });
    }
  }
  
  console.log(`Found ${toMigrate.length} submissions with ${toMigrate.reduce((sum, s) => sum + s.filesToMigrate.length, 0)} logo files to migrate`);
  console.log('');
  
  return toMigrate;
}

async function migrateFile(file) {
  const storagePath = extractStoragePath(file);
  
  if (!storagePath) {
    return { success: false, error: 'No storage path found' };
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
        contentType: file.mime_type || 'application/octet-stream',
        upsert: true
      });
    
    if (uploadError) {
      return { success: false, error: `Upload failed: ${uploadError.message}` };
    }
    
    // Step 3: Get public URL
    const { data: publicUrlData } = supabase.storage
      .from(PUBLIC_BUCKET)
      .getPublicUrl(storagePath);
    
    // Return updated file object
    const updatedFile = {
      ...file,
      bucket: PUBLIC_BUCKET,
      file_url: publicUrlData.publicUrl,
      is_private: false,
      migrated_at: new Date().toISOString()
    };
    
    return { success: true, updatedFile, newUrl: publicUrlData.publicUrl };
    
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function migrateSubmission(item) {
  const { submissionId, formName, fileInfo, filesToMigrate } = item;
  
  console.log(`  Submission ${submissionId} (${formName || 'Unknown form'}):`);
  
  if (isDryRun) {
    for (const { file } of filesToMigrate) {
      const storagePath = extractStoragePath(file);
      console.log(`    [DRY RUN] Would migrate: ${file.file_name || storagePath}`);
      console.log(`      From: ${PRIVATE_BUCKET}/${storagePath}`);
      console.log(`      To: ${PUBLIC_BUCKET}/${storagePath}`);
    }
    return { success: true, migratedCount: filesToMigrate.length, dryRun: true };
  }
  
  // Create a copy of the files array to update
  const updatedFiles = [...fileInfo.files];
  let migratedCount = 0;
  const errors = [];
  
  for (const { file, index } of filesToMigrate) {
    console.log(`    Migrating: ${file.file_name || file.storage_path}`);
    
    const result = await migrateFile(file);
    
    if (result.success) {
      updatedFiles[index] = result.updatedFile;
      migratedCount++;
      console.log(`      SUCCESS: ${result.newUrl.substring(0, 70)}...`);
    } else {
      errors.push(result.error);
      console.log(`      ERROR: ${result.error}`);
    }
  }
  
  if (migratedCount === 0) {
    return { success: false, migratedCount: 0, errors };
  }
  
  // Reconstruct the value in its original format
  let newValue;
  if (fileInfo.isArray) {
    newValue = fileInfo.isJsonString ? JSON.stringify(updatedFiles) : updatedFiles;
  } else {
    newValue = fileInfo.isJsonString ? JSON.stringify(updatedFiles[0]) : updatedFiles[0];
  }
  
  // Update the form submission
  const { data: currentSubmission, error: fetchError } = await supabase
    .from('form_submission')
    .select('submission_data')
    .eq('id', submissionId)
    .single();
  
  if (fetchError) {
    return { success: false, migratedCount, errors: [...errors, `Fetch error: ${fetchError.message}`] };
  }
  
  const updatedSubmissionData = { ...currentSubmission.submission_data };
  updatedSubmissionData[LOGO_FIELD_ID] = newValue;
  
  const { error: updateError } = await supabase
    .from('form_submission')
    .update({ submission_data: updatedSubmissionData })
    .eq('id', submissionId);
  
  if (updateError) {
    return { success: false, migratedCount, errors: [...errors, `Update error: ${updateError.message}`] };
  }
  
  return { success: true, migratedCount, errors };
}

async function run() {
  try {
    // Find submissions to migrate
    let submissionsToMigrate = await findSubmissionsToMigrate();
    
    if (submissionsToMigrate.length === 0) {
      console.log('No logo files found in private bucket. Nothing to migrate.');
      return;
    }
    
    // Apply global limit if specified
    if (globalLimit) {
      let totalFiles = 0;
      const limitedSubmissions = [];
      
      for (const submission of submissionsToMigrate) {
        if (totalFiles >= globalLimit) break;
        
        const remainingSlots = globalLimit - totalFiles;
        if (submission.filesToMigrate.length <= remainingSlots) {
          limitedSubmissions.push(submission);
          totalFiles += submission.filesToMigrate.length;
        } else {
          const partialSubmission = {
            ...submission,
            filesToMigrate: submission.filesToMigrate.slice(0, remainingSlots)
          };
          limitedSubmissions.push(partialSubmission);
          totalFiles += remainingSlots;
        }
      }
      
      submissionsToMigrate = limitedSubmissions;
      console.log(`Applied limit: processing ${totalFiles} files`);
      console.log('');
    }
    
    // Migrate each submission
    console.log('Step 2: Migrating files...');
    console.log('');
    
    let totalMigrated = 0;
    let totalErrors = 0;
    
    for (const item of submissionsToMigrate) {
      const result = await migrateSubmission(item);
      
      totalMigrated += result.migratedCount;
      if (result.errors?.length) {
        totalErrors += result.errors.length;
      }
      console.log('');
    }
    
    // Summary
    console.log('='.repeat(60));
    console.log('Migration Summary');
    console.log('='.repeat(60));
    console.log(`Files migrated: ${totalMigrated}`);
    console.log(`Errors: ${totalErrors}`);
    
    if (isDryRun) {
      console.log('');
      console.log('This was a DRY RUN. No changes were made.');
      console.log('Run without --dry-run to execute the migration.');
    }
    
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

run();
