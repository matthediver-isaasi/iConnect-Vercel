import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { parse } from 'csv-parse/sync';
import pg from 'pg';

const TENANT_ID = '21296ad6-1350-483a-a90c-1b06ece70501';
const CSV_PATH = './attached_assets/GSF_Organisations_2026_02_01_1769932343188.csv';

const databaseUrl = process.env.DATABASE_URL;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!databaseUrl) {
  console.error('Missing DATABASE_URL environment variable');
  process.exit(1);
}

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  db: { schema: 'public' },
  auth: { persistSession: false }
});

async function findOrganisationTypeField() {
  const { data, error } = await supabase
    .from('preference_field')
    .select('id, name, label')
    .eq('entity_scope', 'organization')
    .eq('is_active', true);

  if (error) {
    console.error('Error fetching preference fields:', error);
    return null;
  }

  const orgTypeField = data.find(f => {
    const nameMatch = f.name?.toLowerCase() === 'organisation type' || 
      f.name?.toLowerCase() === 'organization type' ||
      f.name?.toLowerCase() === 'organisation_type' ||
      f.name?.toLowerCase() === 'organization_type' ||
      f.name?.toLowerCase() === 'org_type';
    const labelMatch = f.label?.toLowerCase() === 'organisation type' ||
      f.label?.toLowerCase() === 'organization type';
    return nameMatch || labelMatch;
  });

  return orgTypeField;
}

async function importOrganisations() {
  console.log('Starting GSF Organisations import...');
  console.log('Tenant ID:', TENANT_ID);

  const orgTypeField = await findOrganisationTypeField();
  
  if (!orgTypeField) {
    console.error('Could not find "Organisation type" preference field for this tenant.');
    console.log('Available preference fields for organization scope:');
    const { data } = await supabase
      .from('preference_field')
      .select('id, name, label')
      .eq('entity_scope', 'organization')
      .eq('is_active', true);
    console.log(data);
    process.exit(1);
  }

  console.log('Found Organisation type field:', orgTypeField);

  const csvContent = readFileSync(CSV_PATH, 'utf-8');
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  });

  console.log(`Found ${records.length} records to import`);

  const pool = new pg.Pool({ connectionString: databaseUrl });
  
  let successCount = 0;
  let errorCount = 0;

  try {
    for (const record of records) {
      const name = record['GSF Organisation Name'];
      const memberType = record['Member type'];
      const createdTime = record['Created Time'];

      if (!name) {
        console.log('Skipping record with no name');
        errorCount++;
        continue;
      }

      const createdAt = createdTime ? new Date(createdTime).toISOString() : new Date().toISOString();

      try {
        const insertOrgResult = await pool.query(
          `INSERT INTO organization (name, tenant_id, created_at) 
           VALUES ($1, $2, $3) 
           RETURNING id`,
          [name, TENANT_ID, createdAt]
        );

        const orgId = insertOrgResult.rows[0].id;

        if (memberType && memberType.trim()) {
          await pool.query(
            `INSERT INTO organization_preference_value (organization_id, field_id, value) 
             VALUES ($1, $2, $3)`,
            [orgId, orgTypeField.id, JSON.stringify(memberType.trim())]
          );
        }

        successCount++;
        if (successCount % 50 === 0) {
          console.log(`Imported ${successCount} organisations...`);
        }
      } catch (err) {
        console.error(`Error inserting org "${name}":`, err.message);
        errorCount++;
      }
    }
  } finally {
    await pool.end();
  }

  console.log('\n--- Import Complete ---');
  console.log(`Successfully imported: ${successCount}`);
  console.log(`Errors: ${errorCount}`);
}

importOrganisations().catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});
