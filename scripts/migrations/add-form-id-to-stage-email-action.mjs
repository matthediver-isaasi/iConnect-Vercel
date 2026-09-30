import pg from 'pg';
const { Client } = pg;

async function runMigration() {
  const destUrl = process.env.DEST_DATABASE_URL;
  
  if (!destUrl) {
    console.error('DEST_DATABASE_URL environment variable is not set');
    process.exit(1);
  }
  
  const client = new Client({
    connectionString: destUrl,
    ssl: { rejectUnauthorized: false }
  });
  
  try {
    console.log('Connecting to destination database...');
    await client.connect();
    console.log('Connected successfully');
    
    // Check if column already exists
    const checkResult = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'stage_email_action' 
      AND column_name = 'form_id'
    `);
    
    if (checkResult.rows.length > 0) {
      console.log('Column form_id already exists in stage_email_action table');
    } else {
      console.log('Adding form_id column to stage_email_action table...');
      
      await client.query(`
        ALTER TABLE stage_email_action 
        ADD COLUMN form_id UUID REFERENCES form(id) ON DELETE CASCADE
      `);
      
      console.log('Column added successfully');
    }
    
    // Create indexes
    console.log('Creating indexes...');
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_stage_email_action_form 
      ON stage_email_action(form_id)
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_stage_email_action_stage_form 
      ON stage_email_action(due_diligence_stage_id, form_id)
    `);
    
    console.log('Indexes created successfully');
    
    // Verify
    const verifyResult = await client.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns 
      WHERE table_name = 'stage_email_action' 
      AND column_name = 'form_id'
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
