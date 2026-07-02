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
    
    // Check if column already exists
    const checkResult = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'button_style' 
      AND column_name = 'tenant_id'
    `);
    
    if (checkResult.rows.length > 0) {
      console.log('Column tenant_id already exists in button_style table');
    } else {
      console.log('Adding tenant_id column to button_style table...');
      
      await client.query(`
        ALTER TABLE button_style 
        ADD COLUMN tenant_id UUID REFERENCES tenant(id) ON DELETE CASCADE
      `);
      
      console.log('Column added successfully');
    }
    
    // Create index for tenant-based queries
    console.log('Creating index on tenant_id column...');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_button_style_tenant 
      ON button_style(tenant_id)
    `);
    console.log('Index created successfully');
    
    // Verify
    const verifyResult = await client.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns 
      WHERE table_name = 'button_style' 
      AND column_name = 'tenant_id'
    `);
    
    console.log('Verification:', verifyResult.rows);
    console.log('Migration completed successfully!');
    
  } catch (err) {
    console.error('Migration error:', err);
    throw err;
  } finally {
    await client.end();
  }
}

runMigration().catch(console.error);
