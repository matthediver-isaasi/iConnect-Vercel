import fs from 'fs';
import { parse } from 'csv-parse/sync';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function importDomains() {
  const csvPath = 'attached_assets/domains_06.01.26_1767722119150.csv';
  
  const csvContent = fs.readFileSync(csvPath, 'utf-8');
  
  const records = parse(csvContent, {
    delimiter: ';',
    columns: true,
    skip_empty_lines: true,
    bom: true
  });

  console.log(`Parsed ${records.length} records from CSV`);
  
  let successCount = 0;
  let errorCount = 0;
  const errors = [];

  for (const record of records) {
    const organizationId = record['organization.uuid'];
    const fieldId = record['organization_preference_value.field_id'];
    const orgName = record['organization.name'];
    const domainsRaw = record['Domains'];

    if (!organizationId || !fieldId || !domainsRaw) {
      console.log(`Skipping row - missing data: ${orgName}`);
      continue;
    }

    const domainsArray = domainsRaw
      .split(',')
      .map(d => d.trim().toLowerCase())
      .filter(d => d.length > 0);

    const valueJson = JSON.stringify(domainsArray);

    try {
      const { data: existing, error: selectError } = await supabase
        .from('organization_preference_value')
        .select('id')
        .eq('organization_id', organizationId)
        .eq('field_id', fieldId)
        .maybeSingle();

      if (selectError) {
        throw selectError;
      }

      if (existing) {
        const { error: updateError } = await supabase
          .from('organization_preference_value')
          .update({ value: valueJson })
          .eq('id', existing.id);

        if (updateError) throw updateError;
        console.log(`Updated: ${orgName} -> ${domainsArray.join(', ')}`);
      } else {
        const { error: insertError } = await supabase
          .from('organization_preference_value')
          .insert({
            organization_id: organizationId,
            field_id: fieldId,
            value: valueJson
          });

        if (insertError) throw insertError;
        console.log(`Inserted: ${orgName} -> ${domainsArray.join(', ')}`);
      }

      successCount++;
    } catch (err) {
      errorCount++;
      errors.push({ orgName, error: err.message });
      console.error(`Error for ${orgName}: ${err.message}`);
    }
  }

  console.log('\n--- Import Summary ---');
  console.log(`Total records: ${records.length}`);
  console.log(`Successful: ${successCount}`);
  console.log(`Errors: ${errorCount}`);
  
  if (errors.length > 0) {
    console.log('\nErrors:');
    errors.forEach(e => console.log(`  - ${e.orgName}: ${e.error}`));
  }
}

importDomains().catch(console.error);
