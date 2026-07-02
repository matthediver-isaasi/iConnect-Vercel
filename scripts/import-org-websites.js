import fs from 'fs';
import { parse } from 'csv-parse/sync';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.DEST_SUPABASE_URL;
const supabaseServiceKey = process.env.DEST_SUPABASE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing DEST_SUPABASE_URL or DEST_SUPABASE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function importWebsites() {
  const csvPath = 'attached_assets/website_1775724332236.csv';

  const csvContent = fs.readFileSync(csvPath, 'utf-8');

  const records = parse(csvContent, {
    delimiter: ',',
    columns: true,
    skip_empty_lines: true,
    bom: true
  });

  console.log(`Parsed ${records.length} records from CSV`);

  let successCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  const errors = [];

  for (const record of records) {
    const organizationId = (record['Iconnect unique id'] || '').trim();
    const websiteUrl = (record['Website'] || '').trim();

    if (!organizationId) {
      skippedCount++;
      console.log('Skipping row - missing organization ID');
      continue;
    }

    if (!websiteUrl) {
      skippedCount++;
      console.log(`Skipping row - empty website for org ${organizationId}`);
      continue;
    }

    try {
      const { data, error } = await supabase
        .from('organization')
        .update({ website_url: websiteUrl })
        .eq('id', organizationId)
        .select('id');

      if (error) throw error;

      if (!data || data.length === 0) {
        errorCount++;
        errors.push({ organizationId, error: 'UUID not found in database' });
        console.error(`Not found: ${organizationId}`);
      } else {
        successCount++;
        console.log(`Updated: ${organizationId} -> ${websiteUrl}`);
      }
    } catch (err) {
      errorCount++;
      errors.push({ organizationId, error: err.message });
      console.error(`Error for ${organizationId}: ${err.message}`);
    }
  }

  console.log('\n--- Import Summary ---');
  console.log(`Total records: ${records.length}`);
  console.log(`Skipped (missing ID or empty website): ${skippedCount}`);
  console.log(`Successful updates: ${successCount}`);
  console.log(`Errors: ${errorCount}`);

  if (errors.length > 0) {
    console.log('\nErrors:');
    errors.forEach(e => console.log(`  - ${e.organizationId}: ${e.error}`));
  }
}

importWebsites().catch(console.error);
