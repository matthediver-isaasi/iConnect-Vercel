#!/usr/bin/env node

/**
 * Fix Base44 Field Mapping Script
 * 
 * This script fixes the field key mismatch in migrated Due Diligence submissions.
 * The issue: Base44 data uses field names like "Name_First", "Email", but Supabase
 * forms use field IDs like "field_1699999999999".
 * 
 * The fix: Map Base44 field names to Supabase field IDs using field labels as
 * the common reference point.
 * 
 * Usage:
 *   DRY_RUN=true node scripts/fix-base44-field-mapping.js   # Preview only
 *   node scripts/fix-base44-field-mapping.js                 # Execute fix
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TENANT_ID = '21296ad6-1350-483a-a90c-1b06ece70501';
const DRY_RUN = process.env.DRY_RUN === 'true';
const SUPABASE_URL = process.env.DEV_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.DEV_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;

// Base44 form IDs to form type mapping
const BASE44_FORM_TYPES = {
  '691337d08d01bd0427f927e7': 'ESO',
  '6907b1e12f7725fee16e28b4': 'SO',
  '695d0e0ca53944fa6588de4b': 'Partner'
};

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
    return defaultValue;
  }
}

function normalizeLabel(label) {
  if (!label) return '';
  return label
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s-]/g, '')
    .trim();
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Base44 Field Mapping Fix');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Mode: ${DRY_RUN ? '🔍 DRY RUN (no changes will be made)' : '🚀 LIVE UPDATE'}`);

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Step 1: Load Base44 form configurations
  console.log('\n📂 Loading Base44 form configurations...');
  const formConfigPath = path.join(__dirname, '../attached_assets/FormConfiguration_export_1769416916949.csv');
  const formConfigs = parseCSV(formConfigPath);
  
  // Build Base44 field mappings: { formType: { base44FieldName: label } }
  const base44FieldMappings = {};
  
  for (const config of formConfigs) {
    const formType = BASE44_FORM_TYPES[config.id];
    if (!formType) continue;
    
    const structure = safeParseJSON(config.form_structure, {});
    const fields = structure.fields || [];
    
    base44FieldMappings[formType] = {};
    for (const field of fields) {
      if (field.name && field.label) {
        base44FieldMappings[formType][field.name] = {
          label: field.label,
          normalizedLabel: normalizeLabel(field.label)
        };
      }
    }
    
    console.log(`  ${formType}: ${Object.keys(base44FieldMappings[formType]).length} fields`);
  }

  // Step 2: Get Supabase forms with DD enabled
  console.log('\n📋 Finding Supabase forms with DD enabled...');
  
  const { data: ddConfigs, error: ddError } = await supabase
    .from('form_due_diligence_config')
    .select('form_id')
    .eq('tenant_id', TENANT_ID)
    .eq('is_active', true);
  
  if (ddError) throw new Error(`Failed to query DD configs: ${ddError.message}`);
  
  const ddFormIds = ddConfigs.map(c => c.form_id);
  
  const { data: supabaseForms, error: formsError } = await supabase
    .from('form')
    .select('id, name, slug, fields')
    .eq('tenant_id', TENANT_ID)
    .in('id', ddFormIds);
  
  if (formsError) throw new Error(`Failed to query forms: ${formsError.message}`);
  
  console.log(`  Found ${supabaseForms.length} DD-enabled forms`);
  supabaseForms.forEach(f => console.log(`    - ${f.name} (${f.id})`));

  // Step 3: Build mappings from Base44 field names to Supabase field IDs
  console.log('\n🔗 Building field mappings...');
  
  // Map each Supabase form to a Base44 form type
  const formMappings = {}; // { supabaseFormId: { base44FieldName: supabaseFieldId } }
  
  for (const form of supabaseForms) {
    // Determine which Base44 form type this corresponds to
    let formType = null;
    const nameUpper = (form.name || '').toUpperCase();
    const slugUpper = (form.slug || '').toUpperCase();
    
    // Use word boundary matching to avoid SO matching ESO
    if (/\bESO\b/.test(nameUpper) || /\bESO\b/.test(slugUpper)) {
      formType = 'ESO';
    } else if (/\bSO\b/.test(nameUpper) || /\bSO\b/.test(slugUpper)) {
      formType = 'SO';
    } else if (/\bPARTNER\b/.test(nameUpper) || /\bPARTNER\b/.test(slugUpper)) {
      formType = 'Partner';
    }
    
    if (!formType) {
      console.warn(`  ⚠ Could not determine form type for: ${form.name}`);
      continue;
    }
    
    console.log(`\n  Mapping: ${form.name} → ${formType}`);
    
    const base44Fields = base44FieldMappings[formType] || {};
    const supabaseFields = form.fields || [];
    
    // Build Supabase field lookup by normalized label
    const supabaseByLabel = {};
    for (const field of supabaseFields) {
      const label = field.label || field.name;
      const normalized = normalizeLabel(label);
      supabaseByLabel[normalized] = field.id || field.name;
    }
    
    // Also map by exact name match (in case names were preserved)
    const supabaseByName = {};
    for (const field of supabaseFields) {
      supabaseByName[field.name] = field.id || field.name;
    }
    
    formMappings[form.id] = {};
    let matchCount = 0;
    let nameMatchCount = 0;
    
    for (const [base44Name, info] of Object.entries(base44Fields)) {
      // First try exact name match
      if (supabaseByName[base44Name]) {
        formMappings[form.id][base44Name] = supabaseByName[base44Name];
        nameMatchCount++;
        continue;
      }
      
      // Then try label match
      const supabaseId = supabaseByLabel[info.normalizedLabel];
      if (supabaseId) {
        formMappings[form.id][base44Name] = supabaseId;
        matchCount++;
      }
    }
    
    console.log(`    Name matches: ${nameMatchCount}, Label matches: ${matchCount}, Total: ${Object.keys(formMappings[form.id]).length}`);
    
    // Show some sample mappings
    const samples = Object.entries(formMappings[form.id]).slice(0, 5);
    samples.forEach(([b44, sup]) => console.log(`      ${b44} → ${sup}`));
    if (Object.keys(formMappings[form.id]).length > 5) {
      console.log(`      ... and ${Object.keys(formMappings[form.id]).length - 5} more`);
    }
  }

  // Step 4: Update DD submissions
  console.log('\n📦 Updating DD submissions...');
  
  const { data: submissions, error: subError } = await supabase
    .from('form_submission_due_diligence')
    .select(`
      id,
      original_form_values,
      reviewed_form_values,
      field_review_status,
      field_notes,
      form_submission:form_submission_id(form_id)
    `)
    .eq('tenant_id', TENANT_ID);
  
  if (subError) throw new Error(`Failed to query submissions: ${subError.message}`);
  
  console.log(`  Found ${submissions.length} submissions to check`);
  
  const results = { updated: 0, skipped: 0, noMapping: 0, failed: 0 };
  
  for (const submission of submissions) {
    const formId = submission.form_submission?.form_id;
    const mapping = formMappings[formId];
    
    if (!mapping || Object.keys(mapping).length === 0) {
      results.noMapping++;
      continue;
    }
    
    const original = submission.original_form_values || {};
    const reviewed = submission.reviewed_form_values || {};
    const reviewStatus = submission.field_review_status || {};
    const notes = submission.field_notes || {};
    
    // Check if mapping is needed (if original has Base44 keys)
    const base44Keys = Object.keys(mapping);
    const hasBase44Keys = base44Keys.some(k => k in original);
    
    if (!hasBase44Keys) {
      results.skipped++;
      continue;
    }
    
    // Remap the values
    const newOriginal = {};
    const newReviewed = {};
    const newReviewStatus = {};
    const newNotes = {};
    
    // First, copy any keys that don't need mapping (might already be Supabase keys)
    for (const [key, value] of Object.entries(original)) {
      if (!mapping[key]) {
        // Key not in mapping - might already be a Supabase key, keep it
        newOriginal[key] = value;
      } else {
        // Map to Supabase key
        newOriginal[mapping[key]] = value;
      }
    }
    
    for (const [key, value] of Object.entries(reviewed)) {
      if (!mapping[key]) {
        newReviewed[key] = value;
      } else {
        newReviewed[mapping[key]] = value;
      }
    }
    
    for (const [key, value] of Object.entries(reviewStatus)) {
      if (!mapping[key]) {
        newReviewStatus[key] = value;
      } else {
        newReviewStatus[mapping[key]] = value;
      }
    }
    
    for (const [key, value] of Object.entries(notes)) {
      if (!mapping[key]) {
        newNotes[key] = value;
      } else {
        newNotes[mapping[key]] = value;
      }
    }
    
    if (DRY_RUN) {
      console.log(`  [DRY RUN] Would update submission ${submission.id}`);
      console.log(`    Original keys: ${Object.keys(original).length} → ${Object.keys(newOriginal).length}`);
      results.updated++;
      continue;
    }
    
    // Update the submission
    const { error: updateError } = await supabase
      .from('form_submission_due_diligence')
      .update({
        original_form_values: newOriginal,
        reviewed_form_values: newReviewed,
        field_review_status: newReviewStatus,
        field_notes: newNotes
      })
      .eq('id', submission.id);
    
    if (updateError) {
      console.error(`  ✗ Failed to update ${submission.id}: ${updateError.message}`);
      results.failed++;
    } else {
      console.log(`  ✓ Updated submission ${submission.id}`);
      results.updated++;
    }
  }

  // Summary
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Summary');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Updated:     ${results.updated}`);
  console.log(`  Skipped:     ${results.skipped} (already using correct keys)`);
  console.log(`  No mapping:  ${results.noMapping} (form not mapped)`);
  console.log(`  Failed:      ${results.failed}`);
  
  if (DRY_RUN) {
    console.log('\n💡 This was a dry run. Run without DRY_RUN=true to apply changes.');
  }
}

main().catch(error => {
  console.error('\n❌ Script failed:', error.message);
  process.exit(1);
});
