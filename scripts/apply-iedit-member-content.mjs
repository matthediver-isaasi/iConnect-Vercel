// Explicitly approved, hash-pinned DEST application. Never uses workspace SOURCE.
// Dry-run is the default; opt-in changes only the named GFI tenant's source list.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { connectDestination, PROJECT } from './lib/member-index-destination.mjs';
import { preflightIEdit } from './preflight-iedit-member-content.mjs';

const file = new URL('../supabase/migrations/202612310007_iedit_member_content.sql', import.meta.url);
const sql = await readFile(file, 'utf8');
const sha256 = createHash('sha256').update(sql).digest('hex');
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const enableGfi = args.includes('--enable-gfi');
const suppliedHash = args.find(arg => arg.startsWith('--review-sha256='))?.slice('--review-sha256='.length);
if (args.some(arg => !['--apply', '--enable-gfi', '--preflight'].includes(arg) && !arg.startsWith('--review-sha256='))) {
  throw new Error('Expected --preflight or --apply --review-sha256=<hash> [--enable-gfi]');
}
if (apply && suppliedHash !== sha256) throw new Error('Reviewed migration SHA-256 is required and must match');
const GFI = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';
const client = await connectDestination();
let committed = false;
try {
  await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
  await client.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s'");
  const preflight = await preflightIEdit(client);
  if (!apply) {
    console.log(JSON.stringify({ ...preflight, sha256, gfiOptInRequested: enableGfi }, null, 2));
  } else {
    // Use one transaction for DDL and the approved opt-in, and verify before
    // committing. The checked-in migration remains independently runnable.
    if (!/BEGIN;/.test(sql) || !/COMMIT;\s*$/.test(sql)) throw new Error('Unexpected migration transaction wrapper');
    const body = sql.replace(/\bBEGIN;/, '').replace(/COMMIT;\s*$/, '');
    await client.query(body);
    const verified = await preflightIEdit(client);
    const triggers = await client.query(`SELECT c.relname
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND t.tgname='iedit_member_content_change' AND NOT t.tgisinternal`);
    for (const table of ['i_edit_page', 'i_edit_page_element', 'wall_of_fame_section', 'wall_of_fame_category', 'wall_of_fame_person']) {
      if (!triggers.rows.some(row => row.relname === table)) throw new Error(`Missing verified trigger: ${table}`);
    }
    let optedIn = false;
    if (enableGfi) {
      const tenant = await client.query("SELECT id FROM public.tenant WHERE id=$1 AND status='active'", [GFI]);
      if (tenant.rowCount !== 1) throw new Error('Approved active GFI tenant not found');
      const { rows: before } = await client.query(
        'SELECT allowed_content_types FROM public.member_ai_settings WHERE tenant_id=$1 FOR UPDATE', [GFI]);
      if (before.length !== 1 || !Array.isArray(before[0].allowed_content_types)) {
        throw new Error('Expected existing GFI source choices; refusing to replace unknown settings');
      }
      const original = before[0].allowed_content_types;
      if (!original.includes('iedit_page')) {
        const changed = await client.query(`UPDATE public.member_ai_settings
          SET allowed_content_types=array_append(allowed_content_types,'iedit_page'),updated_at=now()
          WHERE tenant_id=$1 RETURNING allowed_content_types`, [GFI]);
        if (changed.rowCount !== 1 ||
            JSON.stringify(changed.rows[0].allowed_content_types) !== JSON.stringify([...original, 'iedit_page'])) {
          throw new Error('GFI opt-in failed preservation check');
        }
      }
      optedIn = true;
    }
    await client.query('COMMIT');
    committed = true;
    console.log(JSON.stringify({
      project: PROJECT, applied: true, migration: '202612310007_iedit_member_content.sql',
      sha256, exactFunctionGuards: verified.exactFunctionGuards,
      authority: verified.authority, triggerCount: triggers.rowCount,
      gfiIEditEnabled: optedIn, otherSavedSourceChoices: 'unchanged',
      sourceDatabaseTouched: false, backfillPerformed: false,
    }, null, 2));
  }
} finally {
  if (!committed) await client.query('ROLLBACK').catch(() => {});
  await client.end();
}
