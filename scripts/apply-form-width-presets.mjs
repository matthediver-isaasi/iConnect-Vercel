/**
 * Apply the form width preset migration to the verified destination database.
 *
 * Usage:
 *   DEST_DATABASE_URL=... DEST_SUPABASE_URL=https://... node scripts/apply-form-width-presets.mjs
 *
 * The runner intentionally requires both destination values and refuses the
 * source project or an unverified database URL. It is idempotent and can be
 * re-run after a failed deployment.
 */
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { isApprovedDestinationSupabaseTarget } from './lib/destinationSupabaseTarget.mjs';

const FORM_WIDTH_PRESETS = ['narrow', 'medium', 'wide'];

function quoteIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

/**
 * Exercise the migrated column against the real form table without leaving a
 * fixture behind. The source row supplies every other required form column
 * (including a valid tenant and any installation-specific columns), while the
 * outer transaction is always rolled back.
 */
async function verifyFormWidthRoundTrip(client) {
  const { rows: columnRows } = await client.query(`
    SELECT column_name, is_generated, is_identity
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'form'
      AND column_name <> 'form_width'
    ORDER BY ordinal_position
  `);
  const insertColumns = columnRows
    .filter((column) => column.is_generated === 'NEVER' && column.is_identity === 'NO')
    .map((column) => column.column_name);
  if (!insertColumns.includes('id')) {
    throw new Error('Cannot create a rollback-only form fixture: form.id is not insertable.');
  }

  const { rows: sourceRows } = await client.query(`
    SELECT to_jsonb(f) AS payload
    FROM public.form AS f
    LIMIT 1
  `);
  if (sourceRows.length === 0) {
    throw new Error('Cannot verify form_width persistence: public.form has no fixture source row.');
  }

  const fixturePayload = {
    ...sourceRows[0].payload,
    form_width: undefined,
  };
  if (insertColumns.includes('id')) {
    fixturePayload.id = randomUUID();
  }
  if (Object.prototype.hasOwnProperty.call(fixturePayload, 'slug')) {
    fixturePayload.slug = `__form_width_roundtrip_${randomUUID()}`;
  }
  if (Object.prototype.hasOwnProperty.call(fixturePayload, 'name')) {
    fixturePayload.name = `Form width roundtrip ${randomUUID()}`;
  }
  // An omitted form_width is intentional: this first insert proves the
  // database default, rather than merely writing an explicit 'narrow' value.
  delete fixturePayload.form_width;

  const columnList = insertColumns.map(quoteIdentifier).join(', ');
  const valueList = insertColumns.map((column) => `(r).${quoteIdentifier(column)}`).join(', ');
  const insertResult = await client.query(`
    WITH source AS (
      SELECT jsonb_populate_record(NULL::public.form, $1::jsonb) AS r
    )
    INSERT INTO public.form (${columnList})
    SELECT ${valueList}
    FROM source
    RETURNING id, form_width
  `, [JSON.stringify(fixturePayload)]);

  const fixtureId = insertResult.rows[0]?.id;
  if (!fixtureId || insertResult.rows[0].form_width !== 'narrow') {
    throw new Error(`Form width default roundtrip failed: ${JSON.stringify(insertResult.rows[0])}`);
  }

  for (const preset of FORM_WIDTH_PRESETS) {
    const updateResult = await client.query(
      'UPDATE public.form SET form_width = $1 WHERE id = $2 RETURNING form_width',
      [preset, fixtureId],
    );
    const selectResult = await client.query(
      'SELECT form_width FROM public.form WHERE id = $1',
      [fixtureId],
    );
    if (updateResult.rows[0]?.form_width !== preset
      || selectResult.rows[0]?.form_width !== preset) {
      throw new Error(`Form width ${preset} update/select roundtrip failed.`);
    }
  }

  // A failed statement aborts a PostgreSQL transaction unless isolated by a
  // savepoint. Prove that the database check rejects invalid writes, then
  // continue and verify the last valid value remains persisted.
  await client.query('SAVEPOINT form_width_invalid_write');
  let invalidWriteRejected = false;
  try {
    await client.query(
      'UPDATE public.form SET form_width = $1 WHERE id = $2',
      ['invalid', fixtureId],
    );
  } catch (error) {
    if (error?.code !== '23514') throw error;
    invalidWriteRejected = true;
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT form_width_invalid_write');
    await client.query('RELEASE SAVEPOINT form_width_invalid_write');
  }
  if (!invalidWriteRejected) {
    throw new Error('Form width check constraint accepted an invalid value.');
  }

  const { rows: finalRows } = await client.query(
    'SELECT form_width FROM public.form WHERE id = $1',
    [fixtureId],
  );
  if (finalRows[0]?.form_width !== FORM_WIDTH_PRESETS.at(-1)) {
    throw new Error('Form width value did not survive invalid-write rollback.');
  }
}

const connectionString = process.env.DEST_DATABASE_URL;
const destinationSupabaseUrl = process.env.DEST_SUPABASE_URL;

if (!connectionString) {
  throw new Error('DEST_DATABASE_URL is required; refusing to use SOURCE or generic DATABASE_URL.');
}
if (!destinationSupabaseUrl
    || !isApprovedDestinationSupabaseTarget(connectionString, destinationSupabaseUrl)) {
  throw new Error('DEST_DATABASE_URL does not match the verified destination Supabase project.');
}

const client = new pg.Client({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

await client.connect();
try {
  const sql = await fs.readFile(
    new URL('../supabase/migrations/20261024_form_width_presets.sql', import.meta.url),
    'utf8',
  );
  await client.query('BEGIN');
  await client.query(sql);
  await client.query('COMMIT');

  const verification = await client.query(`
    SELECT column_name, column_default, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'form'
      AND column_name = 'form_width'
  `);
  const constraint = await client.query(`
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.form'::regclass
      AND conname = 'form_form_width_check'
  `);
  if (verification.rows.length !== 1 || constraint.rows.length !== 1) {
    throw new Error('Migration verification failed.');
  }

  await client.query('BEGIN');
  try {
    await verifyFormWidthRoundTrip(client);
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }

  console.log('Form width preset migration applied and verified on DEST.');
} catch (error) {
  try { await client.query('ROLLBACK'); } catch {}
  throw error;
} finally {
  await client.end();
}