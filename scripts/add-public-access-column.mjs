#!/usr/bin/env node
/**
 * Migration Script: Add public_access column to preference_field table
 * 
 * This column indicates whether files uploaded to file-type custom fields
 * should be stored in the public bucket (accessible without authentication).
 * 
 * Usage:
 *   node scripts/add-public-access-column.mjs
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://lvmzliemqnieeoruhkik.supabase.co';
const supabaseKey = process.env.DEST_SUPABASE_KEY;

if (!supabaseKey) {
  console.error('Missing DEST_SUPABASE_KEY environment variable');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function addColumn() {
  console.log('Adding public_access column to preference_field table...');
  
  // Check if column exists first
  const { data, error: checkError } = await supabase
    .from('preference_field')
    .select('id, public_access')
    .limit(1);
  
  if (!checkError) {
    console.log('Column already exists!');
    return;
  }
  
  if (checkError.message.includes('does not exist')) {
    console.log('Column does not exist. Please run the following SQL in Supabase SQL Editor:');
    console.log('');
    console.log('='.repeat(60));
    console.log(`
ALTER TABLE preference_field 
ADD COLUMN IF NOT EXISTS public_access BOOLEAN DEFAULT false;
`);
    console.log('='.repeat(60));
    console.log('');
    console.log('After running the SQL, you can enable public_access on the Organisation Logo field.');
    process.exit(1);
  }
  
  console.error('Unexpected error:', checkError);
  process.exit(1);
}

addColumn().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
