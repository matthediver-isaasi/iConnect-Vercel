import { createClient } from '@supabase/supabase-js';
import { parse } from 'csv-parse/sync';
import fs from 'fs';
import path from 'path';

const TENANT_ID = '21296ad6-1350-483a-a90c-1b06ece70501';

const supabaseUrl = process.env.DEV_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.DEV_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function importFormSubmissions() {
  console.log('Starting form submissions import...');
  
  const csvPath = path.join(process.cwd(), 'attached_assets/cleanA_1769949056777.csv');
  
  if (!fs.existsSync(csvPath)) {
    console.error(`CSV file not found: ${csvPath}`);
    process.exit(1);
  }
  
  const csvContent = fs.readFileSync(csvPath, 'utf-8');
  
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    bom: true
  });
  
  console.log(`Found ${records.length} records to import`);
  
  let successCount = 0;
  let errorCount = 0;
  const errors = [];
  
  for (const record of records) {
    try {
      const formId = record.form_config_id;
      const applicantName = record.applicant_name;
      const applicantEmail = record.applicant_email;
      const originalFormData = record.original_form_data;
      const createdDate = record.created_date;
      
      let submissionData = {};
      if (originalFormData && originalFormData.trim() !== '' && originalFormData !== '{}') {
        try {
          submissionData = JSON.parse(originalFormData);
        } catch (parseErr) {
          console.warn(`Warning: Could not parse JSON for ${applicantEmail}: ${parseErr.message}`);
          submissionData = {};
        }
      }
      
      const submissionRecord = {
        form_id: formId,
        submitted_by_name: applicantName || null,
        submitted_by_email: applicantEmail || null,
        submission_data: submissionData,
        created_date: createdDate || new Date().toISOString(),
        tenant_id: TENANT_ID
      };
      
      const { data, error } = await supabase
        .from('form_submission')
        .insert(submissionRecord)
        .select('id')
        .single();
      
      if (error) {
        console.error(`Error inserting record for ${applicantEmail}:`, error.message);
        errors.push({ email: applicantEmail, error: error.message });
        errorCount++;
      } else {
        console.log(`Inserted: ${applicantEmail} -> ${data.id}`);
        successCount++;
      }
    } catch (err) {
      console.error(`Exception processing record:`, err.message);
      errors.push({ email: record.applicant_email, error: err.message });
      errorCount++;
    }
  }
  
  console.log('\n=== Import Summary ===');
  console.log(`Total records: ${records.length}`);
  console.log(`Successful: ${successCount}`);
  console.log(`Errors: ${errorCount}`);
  
  if (errors.length > 0) {
    console.log('\nErrors:');
    errors.forEach(e => console.log(`  - ${e.email}: ${e.error}`));
  }
}

importFormSubmissions().catch(console.error);
