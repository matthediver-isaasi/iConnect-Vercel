#!/usr/bin/env node
// Explicitly opted-in, read-only DEST check. Never run in the isolated suite.
import assert from 'node:assert/strict';
import { connectDestination, PROJECT } from './lib/member-index-destination.mjs';
import { isApprovedDestinationSupabaseTarget } from './lib/destinationSupabaseTarget.mjs';
import { MEMBER_AI_RPC_ARGUMENTS, memberAiRetrievalArguments } from '../api/_lib/memberAiRetrieval.js';

if (process.env.ICONNECT_PRODUCTION_READ_ONLY_VERIFY !== 'member-ai-retrieval') {
  throw new Error('Set ICONNECT_PRODUCTION_READ_ONLY_VERIFY=member-ai-retrieval to authorize read-only verification.');
}
if (!isApprovedDestinationSupabaseTarget(process.env.DEST_DATABASE_URL, process.env.DEST_SUPABASE_URL)) {
  throw new Error('Destination SQL/REST project identity mismatch');
}
if (!process.env.DEST_SUPABASE_KEY) throw new Error('DEST_SUPABASE_KEY is required');
const client = await connectDestination();
try {
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout = '15s'");
  const { rows } = await client.query(`
    SELECT p.proargnames[1:p.pronargs] AS args,
      pg_get_functiondef(p.oid) AS definition,
      has_function_privilege('service_role', p.oid, 'EXECUTE') AS service,
      has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='match_member_content_chunks'`);
  assert.equal(rows.length, 1, 'Expected one unambiguous retrieval overload');
  assert.deepEqual(rows[0].args, MEMBER_AI_RPC_ARGUMENTS);
  assert.equal(rows[0].service, true);
  assert.equal(rows[0].anon, false);
  assert.equal(rows[0].authenticated, false);
  for (const invariant of ['s.active_generation = c.source_generation', 'c.is_active IS TRUE',
    'c.tenant_id = p_tenant_id', 'p_eligible_pdf_chunk_ids', 'p_allowed_feature_keys']) {
    assert.ok(rows[0].definition.includes(invariant), `Missing publication/security invariant: ${invariant}`);
  }
  const vector = await client.query(`SELECT format_type(atttypid,atttypmod) AS type
    FROM pg_attribute WHERE attrelid='public.member_content_chunk'::regclass AND attname='embedding'`);
  assert.equal(vector.rows[0]?.type, 'vector(1536)');
  // NULL tenant + no permissions can never select a tenant's real content.
  const params = memberAiRetrievalArguments({
    p_tenant_id: null, p_is_authenticated: false, p_is_admin: false,
    p_role_id: null, p_group_ids: [], p_accessible_event_ids: [],
    p_accessible_session_ids: [], p_hidden_subcategories: [],
    p_allowed_feature_keys: [], p_eligible_pdf_chunk_ids: [],
    p_allowed_content_types: [],
  }, Array(1536).fill(0), '', 1);
  const sql = `SELECT count(*)::int AS count FROM public.match_member_content_chunks(
    $1::vector,$2::uuid,$3::integer,$4::boolean,$5::boolean,$6::uuid,
    $7::uuid[],$8::uuid[],$9::uuid[],$10::text[],$11::text[],$12::uuid[],$13::text,$14::text[])`;
  const values = MEMBER_AI_RPC_ARGUMENTS.map(key => key === 'query_embedding'
    ? JSON.stringify(params[key]) : params[key]);
  await client.query('SET LOCAL ROLE service_role');
  assert.equal((await client.query(sql, values)).rows[0].count, 0);
  await client.query('ROLLBACK');
  const response = await fetch(`${process.env.DEST_SUPABASE_URL}/rest/v1/rpc/match_member_content_chunks`, {
    method: 'POST',
    headers: { apikey: process.env.DEST_SUPABASE_KEY,
      Authorization: `Bearer ${process.env.DEST_SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(params), signal: AbortSignal.timeout(20000),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`REST contract failed: HTTP ${response.status}, code ${body.code || 'unknown'}`);
  assert.deepEqual(body, []);
  console.log(JSON.stringify({ project: PROJECT, readOnly: true, catalogContract: 'passed',
    serverOnlyGrants: 'passed', generationAndTenantGates: 'passed', embedding1536: 'passed',
    serviceRoleSql: 'passed', serviceRoleRest: 'passed', restStatus: response.status,
    returnedRows: body.length, productionWrites: 0 }));
} finally {
  await client.query('ROLLBACK').catch(() => {});
  await client.end();
}