import pg from 'pg';
const { Client } = pg;

async function runMigration() {
  const destUrl = process.env.DEST_DATABASE_URL || process.env.DATABASE_URL;
  
  if (!destUrl) {
    console.error('DEST_DATABASE_URL or DATABASE_URL environment variable is not set');
    process.exit(1);
  }
  
  const client = new Client({
    connectionString: destUrl,
    ssl: { rejectUnauthorized: false }
  });
  
  try {
    console.log('Connecting to database...');
    await client.connect();
    console.log('Connected successfully');
    
    // Find button_style records with NULL tenant_id
    const nullRecords = await client.query(`
      SELECT id, name FROM button_style WHERE tenant_id IS NULL
    `);
    
    if (nullRecords.rows.length === 0) {
      console.log('No button_style records with NULL tenant_id found. Nothing to backfill.');
      return;
    }
    
    console.log(`Found ${nullRecords.rows.length} button_style records with NULL tenant_id:`);
    nullRecords.rows.forEach(r => console.log(`  - ${r.id}: ${r.name}`));
    
    // Get all active tenants
    const tenantsResult = await client.query(`
      SELECT id, name, slug FROM tenant WHERE status = 'active' ORDER BY name
    `);
    
    if (tenantsResult.rows.length === 0) {
      console.log('No active tenants found. Cannot backfill.');
      return;
    }
    
    console.log(`\nFound ${tenantsResult.rows.length} active tenant(s):`);
    tenantsResult.rows.forEach(t => console.log(`  - ${t.id}: ${t.name} (${t.slug})`));
    
    // Strategy: Create a copy of each global button_style for each tenant
    // This ensures all tenants have access to the button styles
    console.log('\nBackfilling: Creating tenant-specific copies for each tenant...');
    
    for (const tenant of tenantsResult.rows) {
      console.log(`\nProcessing tenant: ${tenant.name}`);
      
      for (const style of nullRecords.rows) {
        // Check if this tenant already has a button style with this name
        const existingCheck = await client.query(`
          SELECT id FROM button_style 
          WHERE tenant_id = $1 AND name = $2
        `, [tenant.id, style.name]);
        
        if (existingCheck.rows.length > 0) {
          console.log(`  - Skipping "${style.name}" (already exists for this tenant)`);
          continue;
        }
        
        // Copy the global style to this tenant
        await client.query(`
          INSERT INTO button_style (
            name, card_type, resource_type, button_type, button_text, 
            icon_name, description, is_active, tenant_id
          )
          SELECT 
            name, card_type, resource_type, button_type, button_text,
            icon_name, description, is_active, $1
          FROM button_style
          WHERE id = $2
        `, [tenant.id, style.id]);
        
        console.log(`  - Created "${style.name}" for tenant ${tenant.name}`);
      }
    }
    
    // Now delete the original global records (NULL tenant_id)
    console.log('\nRemoving original global button_style records...');
    const deleteResult = await client.query(`
      DELETE FROM button_style WHERE tenant_id IS NULL
    `);
    console.log(`Deleted ${deleteResult.rowCount} global record(s)`);
    
    // Verify
    const verifyResult = await client.query(`
      SELECT tenant_id, COUNT(*) as count 
      FROM button_style 
      GROUP BY tenant_id
    `);
    
    console.log('\nVerification - Button styles per tenant:');
    verifyResult.rows.forEach(r => {
      console.log(`  - Tenant ${r.tenant_id || 'NULL'}: ${r.count} style(s)`);
    });
    
    console.log('\nBackfill completed successfully!');
    
  } catch (err) {
    console.error('Migration error:', err);
    throw err;
  } finally {
    await client.end();
  }
}

runMigration().catch(console.error);
