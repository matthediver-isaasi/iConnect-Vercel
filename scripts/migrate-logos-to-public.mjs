#!/usr/bin/env node
/**
 * Migration Script: Move Logo Files from Private to Public Bucket
 * 
 * This script finds all form submissions with logo file fields that are stored
 * in the private-uploads bucket and migrates them to the public-assets bucket.
 * 
 * Usage:
 *   node scripts/migrate-logos-to-public.mjs --dry-run    # Preview changes
 *   node scripts/migrate-logos-to-public.mjs              # Execute migration
 *   node scripts/migrate-logos-to-public.mjs --limit=10   # Limit to first 10 total files
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

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const limitArg = args.find(a => a.startsWith('--limit='));
const globalLimit = limitArg ? parseInt(limitArg.split('=')[1]) : null;

console.log('='.repeat(60));
console.log('Logo Files Migration: Private -> Public Bucket');
console.log('='.repeat(60));
console.log(`Mode: ${isDryRun ? 'DRY RUN (no changes will be made)' : 'EXECUTE'}`);
if (globalLimit) console.log(`Limit: ${globalLimit} files total`);
console.log('');

/**
 * Parse a file field value into a normalized structure
 * Returns: { isArray, isJsonString, files: [...], originalValue }
 */
function parseFileValue(rawValue) {
  if (!rawValue) return null;
  
  let parsedValue = rawValue;
  let isJsonString = false;
  
  // Parse JSON string if needed
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
  
  // Handle array of files
  if (Array.isArray(parsedValue)) {
    return {
      isArray: true,
      isJsonString,
      files: parsedValue.filter(f => f && typeof f === 'object'),
      originalValue: rawValue
    };
  }
  
  // Handle single file object
  if (typeof parsedValue === 'object' && parsedValue !== null) {
    return {
      isArray: false,
      isJsonString,
      files: [parsedValue],
      originalValue: rawValue
    };
  }
  
  return null;
}

/**
 * Find files that need migration (in private bucket)
 */
function findFilesToMigrate(fileInfo) {
  if (!fileInfo) return [];
  
  return fileInfo.files
    .map((file, index) => ({
      file,
      index,
      needsMigration: file.bucket === PRIVATE_BUCKET && !!file.storage_path
    }))
    .filter(item => item.needsMigration);
}

async function findLogoFields() {
  console.log('Step 1: Finding forms with logo file fields...');
  
  const { data: forms, error } = await supabase
    .from('form')
    .select('id, name, fields, tenant_id');
  
  if (error) {
    console.error('Error fetching forms:', error.message);
    return [];
  }
  
  const logoFieldsByForm = [];
  
  for (const form of forms || []) {
    if (!form.fields || !Array.isArray(form.fields)) continue;
    
    const logoFields = form.fields.filter(field => 
      field.type === 'file' && 
      field.label && 
      field.label.toLowerCase().includes('logo')
    );
    
    if (logoFields.length > 0) {
      logoFieldsByForm.push({
        formId: form.id,
        formName: form.name,
        tenantId: form.tenant_id,
        logoFields: logoFields.map(f => ({ id: f.id, label: f.label }))
      });
    }
  }
  
  console.log(`Found ${logoFieldsByForm.length} forms with logo fields:`);
  logoFieldsByForm.forEach(f => {
    console.log(`  - ${f.formName} (${f.formId}): ${f.logoFields.map(lf => lf.label).join(', ')}`);
  });
  console.log('');
  
  return logoFieldsByForm;
}

async function findSubmissionsToMigrate(logoFieldsByForm) {
  console.log('Step 2: Finding form submissions with logos in private bucket...');
  
  const submissionsToMigrate = [];
  
  for (const formInfo of logoFieldsByForm) {
    const { data: submissions, error } = await supabase
      .from('form_submission')
      .select('id, form_id, custom_fields, created_at')
      .eq('form_id', formInfo.formId);
    
    if (error) {
      console.error(`Error fetching submissions for form ${formInfo.formId}:`, error.message);
      continue;
    }
    
    for (const submission of submissions || []) {
      if (!submission.custom_fields) continue;
      
      for (const logoField of formInfo.logoFields) {
        const fieldKey = logoField.id;
        const actualKey = submission.custom_fields[fieldKey] !== undefined 
          ? fieldKey 
          : (submission.custom_fields[`field_${fieldKey}`] !== undefined ? `field_${fieldKey}` : null);
        
        if (!actualKey) continue;
        
        const rawValue = submission.custom_fields[actualKey];
        const fileInfo = parseFileValue(rawValue);
        const filesToMigrate = findFilesToMigrate(fileInfo);
        
        if (filesToMigrate.length > 0) {
          submissionsToMigrate.push({
            submissionId: submission.id,
            formId: formInfo.formId,
            formName: formInfo.formName,
            tenantId: formInfo.tenantId,
            fieldKey: actualKey,
            fieldLabel: logoField.label,
            fileInfo,
            filesToMigrate,
            createdAt: submission.created_at
          });
        }
      }
    }
  }
  
  const totalFiles = submissionsToMigrate.reduce((sum, s) => sum + s.filesToMigrate.length, 0);
  console.log(`Found ${totalFiles} logo files across ${submissionsToMigrate.length} submissions to migrate`);
  console.log('');
  
  return submissionsToMigrate;
}

async function migrateFile(file) {
  const storagePath = file.storage_path;
  
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
  const { submissionId, fieldKey, fileInfo, filesToMigrate } = item;
  
  console.log(`  Submission ${submissionId}:`);
  
  if (isDryRun) {
    for (const { file, index } of filesToMigrate) {
      console.log(`    [DRY RUN] Would migrate: ${file.file_name || file.storage_path}`);
      console.log(`      From: ${PRIVATE_BUCKET}/${file.storage_path}`);
      console.log(`      To: ${PUBLIC_BUCKET}/${file.storage_path}`);
    }
    return { success: true, migratedCount: filesToMigrate.length, dryRun: true };
  }
  
  // Create a copy of the files array to update
  const updatedFiles = [...fileInfo.files];
  let migratedCount = 0;
  let errors = [];
  
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
    .select('custom_fields')
    .eq('id', submissionId)
    .single();
  
  if (fetchError) {
    return { success: false, migratedCount, errors: [...errors, `Fetch error: ${fetchError.message}`] };
  }
  
  const updatedCustomFields = { ...currentSubmission.custom_fields };
  updatedCustomFields[fieldKey] = newValue;
  
  const { error: updateError } = await supabase
    .from('form_submission')
    .update({ custom_fields: updatedCustomFields })
    .eq('id', submissionId);
  
  if (updateError) {
    return { success: false, migratedCount, errors: [...errors, `Update error: ${updateError.message}`] };
  }
  
  return { success: true, migratedCount, errors };
}

async function run() {
  try {
    // Find forms with logo fields
    const logoFieldsByForm = await findLogoFields();
    
    if (logoFieldsByForm.length === 0) {
      console.log('No forms with logo fields found. Nothing to migrate.');
      return;
    }
    
    // Find submissions to migrate
    let submissionsToMigrate = await findSubmissionsToMigrate(logoFieldsByForm);
    
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
          // Partial - take only what we can
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
    console.log('Step 3: Migrating files...');
    console.log('');
    
    let totalMigrated = 0;
    let totalErrors = 0;
    
    for (const item of submissionsToMigrate) {
      console.log(`Form: ${item.formName}, Field: ${item.fieldLabel}`);
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
