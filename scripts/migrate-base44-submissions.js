/**
 * Base44 to Supabase Migration Script
 * 
 * Migrates Due Diligence submissions from Base44 CSV export to Supabase.
 * Uses the destination multi-tenant Supabase database as documented in replit.md.
 * 
 * Usage:
 *   DRY_RUN=true node scripts/migrate-base44-submissions.js   # Preview only
 *   node scripts/migrate-base44-submissions.js                 # Execute migration
 * 
 * Required secrets (stored in Replit Secrets):
 *   DEST_SUPABASE_KEY - Supabase service role key for destination database
 * 
 * Optional: Manual form ID mapping (use if auto-matching fails)
 *   FORM_ESO_ID - Supabase UUID for ESO form
 *   FORM_SO_ID - Supabase UUID for SO form
 *   FORM_PARTNER_ID - Supabase UUID for Partner form
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const TENANT_ID = '21296ad6-1350-483a-a90c-1b06ece70501';
const DRY_RUN = process.env.DRY_RUN === 'true';

// Manual form ID overrides (optional - use these if auto-matching fails)
const MANUAL_FORM_IDS = {
  ESO: process.env.FORM_ESO_ID || null,
  SO: process.env.FORM_SO_ID || null,
  Partner: process.env.FORM_PARTNER_ID || null
};

// Base44 form_config_id to form type mapping (extracted from FormConfiguration CSV)
// We'll query Supabase to find forms with these keywords in their names
const BASE44_FORM_MAPPING = {
  '691337d08d01bd0427f927e7': { name: 'isaasiLongFormESO', searchTerm: 'ESO', count: 30 },
  '6907b1e12f7725fee16e28b4': { name: 'isaasiLongFormSO', searchTerm: 'SO', count: 29 },
  '695d0e0ca53944fa6588de4b': { name: 'isaasiLongFormPartner', searchTerm: 'Partner', count: 2 }
};

function loadSupabaseClient() {
  // Destination multi-tenant Supabase database (as per replit.md)
  const supabaseUrl = 'https://lvmzliemqnieeoruhkik.supabase.co';
  const supabaseKey = process.env.DEST_SUPABASE_KEY;
  
  if (!supabaseKey) {
    throw new Error('Missing DEST_SUPABASE_KEY secret. Add it to Replit Secrets.');
  }
  
  return createClient(supabaseUrl, supabaseKey);
}

function parseCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true
  });
}

function safeParseJSON(str, defaultValue = {}) {
  if (!str || str === '""' || str === '') return defaultValue;
  try {
    return JSON.parse(str);
  } catch (e) {
    console.warn('Failed to parse JSON:', str.substring(0, 100));
    return defaultValue;
  }
}

async function findExistingForms(supabase) {
  console.log('\n📋 Finding existing forms in Supabase...');
  
  // Check for manual overrides first
  const hasManualOverrides = Object.values(MANUAL_FORM_IDS).some(id => id);
  if (hasManualOverrides) {
    console.log('  Using manual form ID overrides from environment variables');
  }
  
  const { data: forms, error } = await supabase
    .from('form')
    .select('id, name, slug, is_due_diligence_enabled')
    .eq('tenant_id', TENANT_ID)
    .eq('is_due_diligence_enabled', true);
  
  if (error) {
    throw new Error(`Failed to query forms: ${error.message}`);
  }
  
  console.log(`Found ${forms.length} DD-enabled forms:`);
  forms.forEach(f => console.log(`  - ${f.name} (${f.id})`));
  
  // Map Base44 form IDs to Supabase form IDs
  const formMapping = {};
  
  for (const [base44Id, formInfo] of Object.entries(BASE44_FORM_MAPPING)) {
    const searchTerm = formInfo.searchTerm;
    
    // Check manual override first
    if (MANUAL_FORM_IDS[searchTerm]) {
      formMapping[base44Id] = MANUAL_FORM_IDS[searchTerm];
      console.log(`  ✓ Manual: ${formInfo.name} (${formInfo.count} submissions) → ${MANUAL_FORM_IDS[searchTerm]}`);
      continue;
    }
    
    // Auto-match by name/slug using word boundary matching to avoid SO matching ESO
    const searchRegex = new RegExp(`\\b${searchTerm}\\b`, 'i');
    const matchingForm = forms.find(f => 
      searchRegex.test(f.name || '') || searchRegex.test(f.slug || '')
    );
    
    if (matchingForm) {
      formMapping[base44Id] = matchingForm.id;
      console.log(`  ✓ Auto: ${formInfo.name} (${formInfo.count} submissions) → ${matchingForm.name} (${matchingForm.id})`);
    } else {
      console.warn(`  ⚠ No form found matching: ${searchTerm} (${formInfo.name})`);
      console.warn(`    Set FORM_${searchTerm.toUpperCase()}_ID environment variable to manually specify`);
    }
  }
  
  return formMapping;
}

async function migrateSubmissions(supabase, formMapping, submissions) {
  console.log(`\n📦 Migrating ${submissions.length} submissions...`);
  
  const results = {
    success: 0,
    skipped: 0,
    failed: 0,
    errors: []
  };
  
  for (const submission of submissions) {
    const base44FormId = submission.form_config_id;
    const supabaseFormId = formMapping[base44FormId];
    
    if (!supabaseFormId) {
      console.warn(`  ⚠ Skipping submission for unmapped form: ${base44FormId}`);
      results.skipped++;
      continue;
    }
    
    // Extract applicant info
    const applicantName = submission.applicant_name || 'Unknown';
    const applicantEmail = submission.applicant_email || '';
    
    // Parse JSON fields
    const originalFormData = safeParseJSON(submission.original_form_data, {});
    const formData = safeParseJSON(submission.form_data, {});
    const fieldNotes = safeParseJSON(submission.field_notes, {});
    const staticQuestionResponses = safeParseJSON(submission.static_question_responses, {});
    const staticQuestionNotes = safeParseJSON(submission.static_question_notes, {});
    const agreementsStatus = safeParseJSON(submission.agreements_status, []);
    const crmAttachmentsStatus = safeParseJSON(submission.crm_attachments_status, []);
    const statusWebhookRemindersStatus = safeParseJSON(submission.status_webhook_reminders_status, []);
    const sentWebhookMessages = safeParseJSON(submission.sent_webhook_messages, []);
    const historyLog = safeParseJSON(submission.history_log, []);
    
    // Prepare form_submission record
    const formSubmissionData = {
      form_id: supabaseFormId,
      tenant_id: TENANT_ID,
      data: formData,
      applicant_name: applicantName,
      applicant_email: applicantEmail,
      status: 'submitted',
      created_at: submission.created_date || new Date().toISOString(),
      updated_at: submission.updated_date || new Date().toISOString()
    };
    
    // Add migration history log entry
    const migrationLogEntry = {
      timestamp: new Date().toISOString(),
      event_type: 'migrated_from_base44',
      user_email: 'System',
      details: {
        source: 'Base44',
        original_application_uid: submission.application_uid,
        original_form_config_id: base44FormId,
        migrated_at: new Date().toISOString()
      }
    };
    
    // Combine existing history with migration entry
    const combinedHistoryLog = [...historyLog, migrationLogEntry];
    
    // Use original application_uid from CSV, or generate new one if missing
    const applicationUid = submission.application_uid || crypto.randomUUID();
    
    // Prepare form_submission_due_diligence record
    const ddData = {
      tenant_id: TENANT_ID,
      application_uid: applicationUid,
      original_form_values: originalFormData,
      reviewed_form_values: formData,
      field_notes: fieldNotes,
      static_question_responses: staticQuestionResponses,
      static_question_notes: staticQuestionNotes,
      workflow_status: submission.status || 'new',
      due_diligence_score: submission.due_diligence_score ? parseInt(submission.due_diligence_score) : null,
      risk_level: submission.risk_level || null,
      dd_call_date: submission.dd_call_date || null,
      notes: submission.notes || null,
      agreements_status: agreementsStatus,
      crm_attachments_status: crmAttachmentsStatus,
      status_webhook_reminders_status: statusWebhookRemindersStatus,
      sent_webhook_messages: sentWebhookMessages,
      history_log: combinedHistoryLog,
      reviewed_by: submission.reviewed_by || null,
      reviewed_date: submission.reviewed_date || null,
      created_at: submission.created_date || new Date().toISOString(),
      updated_at: submission.updated_date || new Date().toISOString()
    };
    
    if (DRY_RUN) {
      console.log(`  [DRY RUN] Would insert: ${applicantName} (${applicantEmail}) → form ${supabaseFormId}`);
      results.success++;
      continue;
    }
    
    try {
      // Insert form_submission
      const { data: newSubmission, error: submissionError } = await supabase
        .from('form_submission')
        .insert(formSubmissionData)
        .select('id')
        .single();
      
      if (submissionError) {
        throw new Error(`form_submission insert failed: ${submissionError.message}`);
      }
      
      // Insert form_submission_due_diligence with link to form_submission
      const { error: ddError } = await supabase
        .from('form_submission_due_diligence')
        .insert({
          ...ddData,
          form_submission_id: newSubmission.id
        });
      
      if (ddError) {
        // Rollback: delete the orphaned form_submission
        console.warn(`    Rolling back form_submission ${newSubmission.id} due to DD insert failure`);
        await supabase
          .from('form_submission')
          .delete()
          .eq('id', newSubmission.id);
        throw new Error(`form_submission_due_diligence insert failed: ${ddError.message}`);
      }
      
      console.log(`  ✓ Migrated: ${applicantName} (${applicantEmail}) [${applicationUid}]`);
      results.success++;
      
    } catch (error) {
      console.error(`  ✗ Failed: ${applicantName} - ${error.message}`);
      results.failed++;
      results.errors.push({ applicantName, applicantEmail, error: error.message });
    }
  }
  
  return results;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Base44 → Supabase Due Diligence Migration');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Mode: ${DRY_RUN ? '🔍 DRY RUN (no changes will be made)' : '🚀 LIVE MIGRATION'}`);
  console.log(`Target tenant: ${TENANT_ID}`);
  
  // Load CSV files
  const submissionsPath = path.join(__dirname, '../attached_assets/Submission_export_1769416598722.csv');
  const formConfigPath = path.join(__dirname, '../attached_assets/FormConfiguration_export_1769416916949.csv');
  
  if (!fs.existsSync(submissionsPath)) {
    throw new Error(`Submissions CSV not found: ${submissionsPath}`);
  }
  
  console.log('\n📂 Loading CSV files...');
  const submissions = parseCSV(submissionsPath);
  console.log(`  Loaded ${submissions.length} submissions`);
  
  if (fs.existsSync(formConfigPath)) {
    const formConfigs = parseCSV(formConfigPath);
    console.log(`  Loaded ${formConfigs.length} form configurations`);
  }
  
  // Initialize Supabase client
  const supabase = await loadSupabaseClient();
  
  // Find and map forms
  const formMapping = await findExistingForms(supabase);
  
  if (Object.keys(formMapping).length === 0) {
    throw new Error('No forms could be mapped. Please ensure DD-enabled forms with ESO, SO, Partner in their names exist.');
  }
  
  // Migrate submissions
  const results = await migrateSubmissions(supabase, formMapping, submissions);
  
  // Summary
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Migration Summary');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  ✓ Successful: ${results.success}`);
  console.log(`  ⚠ Skipped:    ${results.skipped}`);
  console.log(`  ✗ Failed:     ${results.failed}`);
  
  if (results.errors.length > 0) {
    console.log('\nErrors:');
    results.errors.forEach(e => console.log(`  - ${e.applicantName}: ${e.error}`));
  }
  
  if (DRY_RUN) {
    console.log('\n💡 This was a dry run. Run without DRY_RUN=true to execute the migration.');
  }
}

main().catch(error => {
  console.error('\n❌ Migration failed:', error.message);
  process.exit(1);
});
