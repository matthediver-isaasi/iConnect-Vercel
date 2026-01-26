#!/usr/bin/env node

/**
 * Migration: Add viewed_at timestamp to article_view table
 * 
 * This adds a timestamp column to track when articles are viewed,
 * enabling time-based analytics for article engagement.
 * 
 * Usage:
 *   node scripts/migrations/add-article-view-timestamp.mjs
 * 
 * The script will:
 * 1. Add viewed_at column with default NOW() for new records
 * 2. Backfill existing records with the current timestamp
 */

import pg from 'pg';
const { Client } = pg;

async function main() {
  const connectionString = process.env.DEST_DATABASE_URL;
  
  if (!connectionString) {
    console.error('Error: DEST_DATABASE_URL environment variable is required');
    console.log('Set it to your Supabase database connection string');
    process.exit(1);
  }

  const client = new Client({ connectionString });

  try {
    await client.connect();
    console.log('Connected to database');

    // Check if column already exists
    const checkResult = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'article_view' AND column_name = 'viewed_at'
    `);

    if (checkResult.rows.length > 0) {
      console.log('Column viewed_at already exists in article_view table');
      return;
    }

    // Add the viewed_at column with default value
    console.log('Adding viewed_at column to article_view table...');
    await client.query(`
      ALTER TABLE article_view 
      ADD COLUMN viewed_at TIMESTAMPTZ DEFAULT NOW()
    `);
    console.log('Column added successfully');

    // Backfill existing records with current timestamp
    const updateResult = await client.query(`
      UPDATE article_view 
      SET viewed_at = NOW() 
      WHERE viewed_at IS NULL
    `);
    console.log(`Backfilled ${updateResult.rowCount} existing records with current timestamp`);

    // Create index for time-based queries
    console.log('Creating index on viewed_at column...');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_article_view_viewed_at 
      ON article_view (viewed_at)
    `);
    console.log('Index created successfully');

    // Create composite index for tenant + time queries
    console.log('Creating composite index for tenant + time queries...');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_article_view_tenant_viewed_at 
      ON article_view (tenant_id, viewed_at)
    `);
    console.log('Composite index created successfully');

    console.log('\nMigration completed successfully!');
    console.log('The article_view table now has a viewed_at timestamp column.');

  } catch (error) {
    console.error('Migration failed:', error.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
