/**
 * Migration Script: Move existing files to tenant-scoped storage paths
 * 
 * This script migrates files from the legacy 'file-repository' bucket
 * to the new tenant-scoped storage buckets.
 * 
 * IMPORTANT: Run this script manually after setting up the new buckets.
 * 
 * Usage:
 *   node scripts/migrations/migrate-existing-files-to-tenant-scope.js [--dry-run]
 * 
 * Options:
 *   --dry-run    Show what would be migrated without making changes
 */

import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const OLD_BUCKET = 'file-repository';
const NEW_BUCKETS = {
  PUBLIC: 'public-assets',
  PRIVATE: 'private-uploads'
};

const BATCH_SIZE = 20;
const PROGRESS_FILE = path.join(__dirname, 'tenant-migration-progress.json');

const isDryRun = process.argv.includes('--dry-run');

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing required environment variables: SUPABASE_URL, SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

/**
 * Migration Progress Tracking
 */
function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
    }
  } catch (e) {
    console.log('Could not load progress file, starting fresh');
  }
  return { migratedFiles: [], failedFiles: [], lastRunAt: '' };
}

function saveProgress(progress) {
  progress.lastRunAt = new Date().toISOString();
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

/**
 * Get all file records that need migration
 */
async function getFilesToMigrate() {
  console.log('Fetching file records from database...');
  
  // Get files from file_repository table (main file storage)
  const { data: repoFiles, error: repoError } = await supabase
    .from('file_repository')
    .select('id, file_name, file_url, file_type, mime_type, folder_id, tenant_id')
    .limit(10000);
  
  if (repoError) {
    console.error('Error fetching file_repository:', repoError);
    return [];
  }
  
  console.log(`Found ${repoFiles?.length || 0} files in file_repository`);
  
  // Get attachments from form submissions
  const { data: submissions, error: subError } = await supabase
    .from('form_submission')
    .select('id, form_id, data, form:form_id(tenant_id)')
    .not('data', 'is', null)
    .limit(5000);
  
  if (subError) {
    console.error('Error fetching form_submission:', subError);
  }
  
  // Extract file URLs from form submission data
  const submissionFiles = [];
  if (submissions) {
    for (const sub of submissions) {
      const tenantId = sub.form?.tenant_id;
      if (!tenantId) continue;
      
      const data = typeof sub.data === 'string' ? JSON.parse(sub.data) : sub.data;
      for (const [key, value] of Object.entries(data || {})) {
        if (typeof value === 'string' && value.includes('file-repository')) {
          submissionFiles.push({
            id: `submission-${sub.id}-${key}`,
            file_url: value,
            tenant_id: tenantId,
            source: 'form_submission',
            submission_id: sub.id,
            field_key: key,
            is_private: true
          });
        }
      }
    }
  }
  
  console.log(`Found ${submissionFiles.length} files in form submissions`);
  
  return [...(repoFiles || []).map(f => ({ ...f, source: 'file_repository', is_private: false })), ...submissionFiles];
}

/**
 * Determine the new path for a file based on tenant and type
 */
function getNewPath(file) {
  const tenantId = file.tenant_id;
  if (!tenantId) {
    return null;
  }
  
  // Extract filename from URL
  const urlParts = file.file_url.split('/');
  const filename = urlParts[urlParts.length - 1];
  
  if (file.source === 'form_submission') {
    return `${tenantId}/form-submissions/${file.submission_id || 'legacy'}/${filename}`;
  }
  
  // For file_repository files, determine if they're branding or general
  const isBranding = file.file_type === 'branding' || 
    filename.toLowerCase().includes('logo') || 
    filename.toLowerCase().includes('favicon');
  
  if (isBranding) {
    return `${tenantId}/branding/${filename}`;
  }
  
  return `${tenantId}/uploads/${filename}`;
}

/**
 * Copy a file from old bucket to new bucket
 */
async function migrateFile(file) {
  const newPath = getNewPath(file);
  if (!newPath) {
    return { success: false, error: 'No tenant_id found' };
  }
  
  const newBucket = file.is_private ? NEW_BUCKETS.PRIVATE : NEW_BUCKETS.PUBLIC;
  
  try {
    // Extract storage path from URL
    const url = new URL(file.file_url);
    const pathMatch = url.pathname.match(/\/storage\/v1\/object\/public\/([^/]+)\/(.+)/);
    if (!pathMatch) {
      return { success: false, error: 'Could not parse storage path from URL' };
    }
    
    const oldPath = pathMatch[2];
    
    if (isDryRun) {
      console.log(`[DRY RUN] Would copy: ${OLD_BUCKET}/${oldPath} -> ${newBucket}/${newPath}`);
      return { success: true, newPath, newBucket };
    }
    
    // Download from old bucket
    const { data: fileData, error: downloadError } = await supabase.storage
      .from(OLD_BUCKET)
      .download(oldPath);
    
    if (downloadError) {
      return { success: false, error: `Download failed: ${downloadError.message}` };
    }
    
    // Upload to new bucket with tenant-scoped path
    const { error: uploadError } = await supabase.storage
      .from(newBucket)
      .upload(newPath, fileData, {
        contentType: file.mime_type || 'application/octet-stream',
        upsert: true
      });
    
    if (uploadError) {
      return { success: false, error: `Upload failed: ${uploadError.message}` };
    }
    
    return { success: true, newPath, newBucket };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Update database records with new file URLs
 */
async function updateDatabaseRecords(migratedFiles) {
  console.log(`\nUpdating ${migratedFiles.length} database records...`);
  
  for (const file of migratedFiles) {
    if (!file.result?.success) continue;
    
    const { newPath, newBucket } = file.result;
    
    // Get new public URL
    const { data: urlData } = supabase.storage
      .from(newBucket)
      .getPublicUrl(newPath);
    
    const newUrl = file.is_private 
      ? `/api/storage/secure-url?bucket=${newBucket}&path=${encodeURIComponent(newPath)}`
      : urlData.publicUrl;
    
    if (isDryRun) {
      console.log(`[DRY RUN] Would update ${file.source}/${file.id}: ${file.file_url} -> ${newUrl}`);
      continue;
    }
    
    try {
      if (file.source === 'file_repository') {
        await supabase
          .from('file_repository')
          .update({ 
            file_url: newUrl,
            storage_path: newPath,
            bucket: newBucket
          })
          .eq('id', file.id);
      } else if (file.source === 'form_submission') {
        // Update form submission data field
        const { data: sub } = await supabase
          .from('form_submission')
          .select('data')
          .eq('id', file.submission_id)
          .single();
        
        if (sub) {
          const data = typeof sub.data === 'string' ? JSON.parse(sub.data) : sub.data;
          data[file.field_key] = JSON.stringify({
            file_url: newUrl,
            storage_path: newPath,
            bucket: newBucket,
            is_private: true
          });
          
          await supabase
            .from('form_submission')
            .update({ data })
            .eq('id', file.submission_id);
        }
      }
      
      console.log(`Updated: ${file.id}`);
    } catch (err) {
      console.error(`Failed to update ${file.id}:`, err.message);
    }
  }
}

/**
 * Main migration function
 */
async function main() {
  console.log('='.repeat(60));
  console.log('Tenant-Scoped Storage Migration');
  console.log(isDryRun ? '*** DRY RUN MODE - No changes will be made ***' : '');
  console.log('='.repeat(60));
  
  // Check if new buckets exist
  const { data: buckets } = await supabase.storage.listBuckets();
  const bucketNames = buckets?.map(b => b.name) || [];
  
  if (!bucketNames.includes(NEW_BUCKETS.PUBLIC) || !bucketNames.includes(NEW_BUCKETS.PRIVATE)) {
    console.error('\nERROR: New buckets must be created first!');
    console.error(`Required buckets: ${NEW_BUCKETS.PUBLIC}, ${NEW_BUCKETS.PRIVATE}`);
    console.error('\nPlease run the SQL migration script first:');
    console.error('  scripts/migrations/create-tenant-scoped-storage-buckets.sql');
    console.error('\nAnd create the buckets in the Supabase Dashboard.');
    process.exit(1);
  }
  
  console.log('\nNew buckets verified: ');
  console.log(`  - ${NEW_BUCKETS.PUBLIC}`);
  console.log(`  - ${NEW_BUCKETS.PRIVATE}`);
  
  // Load progress
  const progress = loadProgress();
  console.log(`\nPreviously migrated: ${progress.migratedFiles.length} files`);
  console.log(`Previously failed: ${progress.failedFiles.length} files`);
  
  // Get files to migrate
  const files = await getFilesToMigrate();
  
  // Filter out already migrated files
  const toMigrate = files.filter(f => !progress.migratedFiles.includes(f.id));
  console.log(`\nFiles to migrate: ${toMigrate.length}`);
  
  if (toMigrate.length === 0) {
    console.log('No files to migrate!');
    return;
  }
  
  // Migrate in batches
  const migratedThisRun = [];
  
  for (let i = 0; i < toMigrate.length; i += BATCH_SIZE) {
    const batch = toMigrate.slice(i, i + BATCH_SIZE);
    console.log(`\nProcessing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(toMigrate.length / BATCH_SIZE)}...`);
    
    for (const file of batch) {
      const result = await migrateFile(file);
      
      if (result.success) {
        progress.migratedFiles.push(file.id);
        migratedThisRun.push({ ...file, result });
        console.log(`  OK: ${file.file_name || file.id}`);
      } else {
        progress.failedFiles.push({ id: file.id, error: result.error });
        console.log(`  FAIL: ${file.file_name || file.id} - ${result.error}`);
      }
    }
    
    if (!isDryRun) {
      saveProgress(progress);
    }
  }
  
  // Update database records
  await updateDatabaseRecords(migratedThisRun);
  
  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('MIGRATION SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total migrated this run: ${migratedThisRun.filter(f => f.result?.success).length}`);
  console.log(`Total failed this run: ${migratedThisRun.filter(f => !f.result?.success).length}`);
  console.log(`Total migrated overall: ${progress.migratedFiles.length}`);
  console.log(`Total failed overall: ${progress.failedFiles.length}`);
  
  if (!isDryRun) {
    saveProgress(progress);
  }
  
  console.log('\nDone!');
}

main().catch(console.error);
