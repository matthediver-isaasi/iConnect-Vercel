#!/usr/bin/env node
// Destination-only, idempotent role catalogue seed. Never modifies role grants
// or portal menus. Dry run rolls back; --apply commits the catalogue changes.
import pg from 'pg';
import { pathToFileURL } from 'node:url';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

export async function seedMemberCpdRoleAccess(client) {
  // Serialize catalogue seeds; this also handles installations without a
  // unique item_key index. Existing roles/exclusions remain byte-for-byte intact.
  await client.query('LOCK TABLE public.role_access_item IN SHARE ROW EXCLUSIVE MODE');
  const { rows: modules } = await client.query(
    "SELECT id,item_type FROM public.role_access_item WHERE item_key='cpd'",
  );
  if (modules.length > 1 || (modules[0] && modules[0].item_type !== 'module')) {
    throw new Error('CPD module identity is ambiguous');
  }
  let moduleId = modules[0]?.id;
  if (!moduleId) {
    const { rows } = await client.query(`
      INSERT INTO public.role_access_item(item_type,item_key,label,icon,parent_id,display_order,is_active)
      SELECT 'module','cpd','CPD','Award',NULL,COALESCE(MAX(display_order),-1)+1,true
      FROM public.role_access_item WHERE item_type='module' RETURNING id
    `);
    moduleId = rows[0].id;
  }
  const { rows: pages } = await client.query(
    "SELECT id,item_type FROM public.role_access_item WHERE item_key='cpd.member_cpd'",
  );
  if (pages.length > 1 || (pages[0] && pages[0].item_type !== 'page')) {
    throw new Error('Member CPD page identity is ambiguous');
  }
  if (pages[0]) {
    await client.query(`
      UPDATE public.role_access_item SET label='Member CPD',parent_id=$1,is_active=true
      WHERE id=$2 AND (label IS DISTINCT FROM 'Member CPD' OR parent_id IS DISTINCT FROM $1 OR is_active IS DISTINCT FROM true)
    `, [moduleId, pages[0].id]);
  } else {
    await client.query(`
      INSERT INTO public.role_access_item(item_type,item_key,label,parent_id,display_order,is_active)
      SELECT 'page','cpd.member_cpd','Member CPD',$1,COALESCE(MAX(display_order),-1)+1,true
      FROM public.role_access_item WHERE parent_id=$1
    `, [moduleId]);
  }
  const { rows } = await client.query(`
    SELECT p.item_key,p.label,p.is_active,m.item_key AS parent_key
    FROM public.role_access_item p JOIN public.role_access_item m ON m.id=p.parent_id
    WHERE p.item_key='cpd.member_cpd'
  `);
  if (rows.length !== 1 || rows[0].parent_key !== 'cpd' || !rows[0].is_active) {
    throw new Error('Member CPD catalogue verification failed');
  }
  return rows[0];
}

export async function main(args = process.argv.slice(2)) {
  if (args.some(arg => arg !== '--apply')) throw new Error('Supported argument: --apply');
  const target = destinationTarget(process.env);
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  if (!response.ok) throw new Error('Destination TLS certificate unavailable');
  const client = new pg.Client({ connectionString: target.toString(),
    ssl: { rejectUnauthorized: true, ca: await response.text(), servername: target.hostname } });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='30s'");
    const page = await seedMemberCpdRoleAccess(client);
    await client.query(args.includes('--apply') ? 'COMMIT' : 'ROLLBACK');
    console.log(JSON.stringify({ applied: args.includes('--apply'), target: 'verified DEST Supabase',
      page, rolesChanged: false, portalMenusChanged: false }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}