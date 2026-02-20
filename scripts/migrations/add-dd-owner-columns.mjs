#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://lvmzliemqnieeoruhkik.supabase.co';
const supabaseKey = process.env.DEST_SUPABASE_KEY;

if (!supabaseKey) {
  console.error('DEST_SUPABASE_KEY is required');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkColumnExists(table, column) {
  const { error } = await supabase.from(table).select(column).limit(1);
  if (!error) return true;
  if (error.message.includes('does not exist')) return false;
  throw new Error(`Unexpected error checking ${table}.${column}: ${error.message}`);
}

async function main() {
  console.log('Adding DD owner columns...');
  console.log('');

  const migrations = [
    {
      table: 'form_due_diligence_config',
      column: 'owner_role_ids',
      sql: `ALTER TABLE form_due_diligence_config ADD COLUMN IF NOT EXISTS owner_role_ids JSONB DEFAULT '[]';`
    },
    {
      table: 'form_submission_due_diligence',
      column: 'owner_member_id',
      sql: `ALTER TABLE form_submission_due_diligence ADD COLUMN IF NOT EXISTS owner_member_id UUID;`
    },
    {
      table: 'form_submission_due_diligence',
      column: 'owner_name',
      sql: `ALTER TABLE form_submission_due_diligence ADD COLUMN IF NOT EXISTS owner_name TEXT;`
    }
  ];

  const sqlToRun = [];

  for (const m of migrations) {
    try {
      const exists = await checkColumnExists(m.table, m.column);
      if (exists) {
        console.log(`Already exists: ${m.table}.${m.column}`);
      } else {
        console.log(`Needs adding:   ${m.table}.${m.column}`);
        sqlToRun.push(m.sql);
      }
    } catch (err) {
      console.error(err.message);
    }
  }

  if (sqlToRun.length === 0) {
    console.log('\nAll columns already exist. No migration needed.');
    return;
  }

  console.log('\n' + '='.repeat(60));
  console.log('Run the following SQL in Supabase SQL Editor:');
  console.log('='.repeat(60));
  console.log('');
  console.log(sqlToRun.join('\n'));
  console.log('');
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
