// Read-only DEST inspection. Never prints source text, embeddings, or credentials.
import { connectDestination, PROJECT } from './lib/member-index-destination.mjs';

const client = await connectDestination();
try {
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout = '15s'");
  const queries = {
    indexes: `SELECT c.relname, i.indisunique, i.indisvalid, i.indisready,
      pg_get_indexdef(i.indexrelid) AS definition
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = 'public.member_content_chunk'::regclass`,
    columns: `SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'member_content_chunk'
      ORDER BY ordinal_position`,
    duplicates: `SELECT count(*) AS duplicate_groups_capped_at_10 FROM (
      SELECT 1 FROM public.member_content_chunk
      GROUP BY content_type, source_id, chunk_index
      HAVING count(*) > 1 LIMIT 10
    ) d`,
    chunks: 'SELECT count(*) AS chunks FROM public.member_content_chunk',
  };
  console.log(JSON.stringify({ project: PROJECT, inspectedAt: new Date().toISOString() }));
  for (const [name, sql] of Object.entries(queries)) {
    console.log(JSON.stringify({ [name]: (await client.query(sql)).rows }));
  }
  await client.query('ROLLBACK');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(JSON.stringify({ failed: true, code: error.code || 'inspection_failed' }));
  process.exitCode = 1;
} finally {
  await client.end();
}