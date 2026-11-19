import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const migrationPath = 'supabase/migrations/202701220001_simple_event_total_capacity.sql';
export const reviewedHash = '9cf03ac9d3c76c44db45be64b6d7cdf558c3d61299af718bb71c93fcda92f102';
export const project = 'lvmzliemqnieeoruhkik';
export const newFunctions = [
  'simple_event_capacity', 'simple_event_capacity_contract', 'lock_simple_event_capacity',
  'verify_simple_event_capacity', 'insert_simple_total_booking_batch',
];
export const patchFunctions = [
  'sales_capacity_state', 'check_oneoff_ticket_capacity', 'insert_public_ticket_booking_batch',
  'move_sales_commercial_allocation', 'reconcile_sales_commercial_booking',
  'unreconcile_sales_commercial_booking', 'cancel_event_booking_with_allocation',
  'reserve_sales_allocation_invitation', 'claim_sales_allocation_invitation',
  'release_sales_allocation_invitation', 'confirm_sales_quote_sale', 'confirm_sales_quote_ticket_sale',
];
export const sha = value => createHash('sha256').update(value).digest('hex');
const requiredSignatures = [
  'sales_capacity_state(text,uuid,text)',
  'check_oneoff_ticket_capacity(uuid,text,integer,uuid[])',
  'insert_public_ticket_booking_batch(uuid,jsonb)',
  'move_sales_commercial_allocation(uuid,uuid,text,integer,text,text,text,uuid)',
  'reconcile_sales_commercial_booking(uuid,uuid,text,uuid,text,integer,text,text,uuid)',
  'unreconcile_sales_commercial_booking(uuid,text,uuid,text,text,uuid)',
  'cancel_event_booking_with_allocation(uuid,text,uuid,text,text,uuid)',
  'reserve_sales_allocation_invitation(uuid,uuid,text,text,text,text,timestamp with time zone,text,text,uuid)',
  'claim_sales_allocation_invitation(text,text,uuid)',
  'release_sales_allocation_invitation(uuid,uuid,text,uuid)',
  'confirm_sales_quote_sale(uuid,uuid,integer,text,text,uuid)',
  'confirm_sales_quote_ticket_sale(uuid,uuid,integer,text,text,uuid)',
];

function verifySignatures(rows) {
  for (const name of patchFunctions) assert.equal(rows.filter(f => f.name === name).length, 1, `Unexpected missing/overloaded function: ${name}`);
  for (const signature of requiredSignatures) {
    assert.ok(rows.some(f => f.signature.replace(/^public\./,'') === signature), `Missing ${signature}`);
  }
}

// Remove ONLY the reviewed outer transaction. The inner PL/pgSQL BEGIN/END
// blocks remain byte-for-byte intact; a hash change requires a new review.
export function migrationBody(sql) {
  assert.equal(sha(sql), reviewedHash, 'Reviewed migration changed');
  assert.equal((sql.match(/^BEGIN;$/gm) || []).length, 1);
  assert.equal((sql.match(/^COMMIT;$/gm) || []).length, 1);
  assert.match(sql, /COMMIT;\s*$/);
  return sql.replace(/^BEGIN;\n/m, '').replace(/COMMIT;\s*$/, '');
}

export async function functions(db) {
  return (await db.query(`SELECT p.proname name,p.oid::regprocedure::text signature,
    pg_get_functiondef(p.oid) definition,p.prosrc source,p.proargnames args,
    p.prosecdef security_definer,p.proconfig config,p.proacl::text acl,
    pg_get_userbyid(p.proowner) owner,
    has_function_privilege('service_role',p.oid,'EXECUTE') service,
    has_function_privilege('anon',p.oid,'EXECUTE') anon,
    has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=ANY($1)
    ORDER BY p.proname,p.oid`, [[...newFunctions, ...patchFunctions]])).rows;
}

export async function state(db) {
  const cols = (await db.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='event'
      AND column_name IN ('capacity_mode','total_capacity')`)).rows;
  const fns = await functions(db);
  const triggers = (await db.query(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal
    AND tgname IN ('simple_event_capacity_contract','simple_event_capacity_lock',
      'simple_event_commercial_capacity_lock','simple_event_capacity_verify',
      'simple_event_commercial_capacity_verify')`)).rows;
  const patches = fns.filter(f => patchFunctions.includes(f.name));
  const markers = patches.some(f => /capacity_event|simple_event_capacity\(|capacity_mode='total'/.test(f.source));
  if (!cols.length && !triggers.length && !fns.some(f => newFunctions.includes(f.name)) && !markers) return 'absent';
  if (cols.length === 2 && triggers.length === 5 && fns.filter(f => newFunctions.includes(f.name)).length === 5) return 'present';
  throw new Error('Partial capacity migration detected; no replay or repair is authorized');
}

function once(text, anchor, replacement) {
  assert.equal(text.split(anchor).length, 2, `Patch anchor must occur exactly once: ${anchor}`);
  return text.replace(anchor, replacement);
}

// Derive exact expected changes from the hash-pinned migration itself, not
// permissive substring checks. This also catches missing/different overloads.
export function expectedPatches(sql, originals) {
  const replacements = [...sql.matchAll(/patched:=replace\(def, ?'([^']+)', \$insert\$([\s\S]*?)\$insert\$\);/g)];
  assert.equal(replacements.length, 4);
  const basic = new Map([
    ['sales_capacity_state', replacements[0]],
    ['check_oneoff_ticket_capacity', replacements[1]],
    ['insert_public_ticket_booking_batch', replacements[2]],
  ]);
  const kinds = new Map([
    ['move_sales_commercial_allocation','allocation'], ['reconcile_sales_commercial_booking','allocation'],
    ['unreconcile_sales_commercial_booking','booking'], ['cancel_event_booking_with_allocation','booking'],
    ['reserve_sales_allocation_invitation','allocation'], ['claim_sales_allocation_invitation','token'],
    ['release_sales_allocation_invitation','invitation'],
  ]);
  const requiredArgs = {
    allocation: ['p_allocation_id','p_tenant_id'], booking: ['p_booking_id','p_tenant_id','p_booking_kind'],
    token: ['p_token_hash'], invitation: ['p_invitation_id','p_tenant_id'],
  };
  verifySignatures(originals);
  let salePatches = 0;
  return originals.filter(f => patchFunctions.includes(f.name)).map(f => {
    let definition = f.definition;
    if (basic.has(f.name)) {
      const [, anchor, replacement] = basic.get(f.name);
      definition = once(definition, anchor, replacement);
    } else if (kinds.has(f.name)) {
      const kind = kinds.get(f.name);
      for (const arg of requiredArgs[kind]) assert.ok(f.args.includes(arg), `Missing ${arg} in ${f.name}`);
      const prefix = sql.match(new RegExp(`WHEN '${kind}' THEN '((?:''|[^'])*)'`))?.[1]?.replaceAll("''", "'");
      assert.ok(prefix);
      // regexp_replace in the migration replaces the first top-level BEGIN.
      assert.ok(definition.includes('BEGIN\n'), `Missing BEGIN in ${f.name}`);
      definition = definition.replace('BEGIN\n', `BEGIN\n  ${prefix}\n`);
    } else if (f.source.includes('pg_temp.sale_candidates')) {
      const [, anchor, replacement] = replacements[3];
      definition = once(definition, anchor, replacement);
      salePatches++;
    }
    return { ...f, definition };
  }).map((f, i, rows) => {
    if (i === rows.length - 1) assert.ok(salePatches >= 1, 'Commercial ticket-sale candidate patch missing');
    return f;
  });
}

export async function snapshot(db) {
  const result = await db.query(`SELECT id,tenant_id,available_seats,is_unlimited_registration,
    is_complex,pricing_config,to_jsonb(e)->'capacity_mode' capacity_mode,
    to_jsonb(e)->'total_capacity' total_capacity,e.xmin::text row_version
    FROM public.event e ORDER BY id LIMIT 10001`);
  assert.ok(result.rowCount > 0 && result.rowCount <= 10000, 'Unexpected event count; bounded review required');
  return result.rows;
}

export function preservation(before, after, wasAbsent) {
  const expected = before.map(r => wasAbsent ? { ...r, capacity_mode:'legacy', total_capacity:null } : r);
  assert.deepEqual(after, expected, 'Existing event settings or row versions changed');
  return { events: before.length, unchanged: true, sha256: sha(JSON.stringify(after)) };
}

export async function verifySchema(db, sql, expected) {
  const actual = await functions(db);
  verifySignatures(actual);
  for (const name of newFunctions) {
    const fn = actual.filter(f => f.name === name);
    assert.equal(fn.length, 1, `Missing/overloaded new function: ${name}`);
    const source = sql.split(`FUNCTION public.${name}(`)[1]?.split('AS $$')[1]?.split('$$;')[0];
    assert.equal(fn[0].source, source, `Function body mismatch: ${name}`);
    assert.equal(fn[0].security_definer, name !== 'simple_event_capacity_contract');
    assert.deepEqual(fn[0].config, ['search_path=pg_catalog, public']);
    assert.ok(!fn[0].anon && !fn[0].authenticated && !fn[0].public, `Function exposed: ${name}`);
    if (['simple_event_capacity','insert_simple_total_booking_batch'].includes(name)) assert.ok(fn[0].service);
  }
  if (expected) for (const fn of expected) {
    const found = actual.find(f => f.signature === fn.signature);
    assert.ok(found, `Missing patched function: ${fn.signature}`);
    assert.equal(found.definition, fn.definition, `Unexpected patch: ${fn.signature}`);
    for (const key of ['acl','owner','security_definer','config']) assert.deepEqual(found[key], fn[key], `Changed ${key}: ${fn.signature}`);
  }
  // On a later --verify, require the complete exact inserted fragments and
  // event-before-class ordering even without the original pre-apply catalog.
  const fragments = [...sql.matchAll(/patched:=replace\(def, ?'([^']+)', \$insert\$([\s\S]*?)\$insert\$\);/g)];
  for (const [name,index] of [['sales_capacity_state',0],['check_oneoff_ticket_capacity',1],
    ['insert_public_ticket_booking_batch',2],['confirm_sales_quote_ticket_sale',3]]) {
    assert.ok(actual.find(f => f.name === name)?.definition.includes(fragments[index][2]), `Incomplete capacity patch: ${name}`);
  }
  for (const [name,kind] of [
    ['move_sales_commercial_allocation','allocation'], ['reconcile_sales_commercial_booking','allocation'],
    ['unreconcile_sales_commercial_booking','booking'], ['cancel_event_booking_with_allocation','booking'],
    ['reserve_sales_allocation_invitation','allocation'], ['claim_sales_allocation_invitation','token'],
    ['release_sales_allocation_invitation','invitation'],
  ]) {
    const prefix = sql.match(new RegExp(`WHEN '${kind}' THEN '((?:''|[^'])*)'`))[1].replaceAll("''", "'");
    assert.ok(actual.find(f => f.name === name)?.source.includes(`BEGIN\n  ${prefix}\n`), `Incomplete event-lock prefix: ${name}`);
  }
  for (const fn of actual.filter(f => patchFunctions.includes(f.name))) {
    if (fn.name.startsWith('confirm_sales_quote')) {
      if (!fn.source.includes('pg_temp.sale_candidates')) continue;
      assert.match(fn.source, /ORDER BY e.id FOR UPDATE;/);
      assert.ok(fn.source.indexOf('ORDER BY e.id FOR UPDATE;') < fn.source.indexOf('-- Every transaction takes all ticket locks'));
    } else if (fn.name === 'sales_capacity_state') {
      assert.ok(fn.source.indexOf("IF p_event_kind='simple'") < fn.source.indexOf('  PERFORM pg_advisory_xact_lock'));
      assert.match(fn.source, /WHERE id=p_event_id FOR UPDATE;/);
    } else if (fn.name === 'check_oneoff_ticket_capacity') {
      assert.match(fn.source, /p_booking_ids IS NULL AND EXISTS/);
      assert.match(fn.source, /s:=public.simple_event_capacity\(p_event_id\)/);
    } else if (fn.name === 'insert_public_ticket_booking_batch') {
      assert.match(fn.source, /last_error_code='capacity_refund_pending'/);
      assert.ok(fn.source.indexOf("IF purchase.event_kind='simple'") < fn.source.indexOf('  FOR ticket IN SELECT'));
    } else {
      assert.match(fn.source, /BEGIN\n  PERFORM capacity_event.id[\s\S]+FOR UPDATE OF capacity_event;/);
    }
  }
  for (const name of patchFunctions) assert.equal(actual.filter(f => f.name === name).length, 1, `Missing/overloaded ${name}`);
  const columns = (await db.query(`SELECT column_name,data_type,is_nullable,column_default
    FROM information_schema.columns WHERE table_schema='public' AND table_name='event'
      AND column_name IN ('capacity_mode','total_capacity') ORDER BY column_name`)).rows;
  assert.deepEqual(columns, [
    { column_name:'capacity_mode',data_type:'text',is_nullable:'NO',column_default:"'legacy'::text" },
    { column_name:'total_capacity',data_type:'integer',is_nullable:'YES',column_default:null },
  ]);
  const checks = (await db.query(`SELECT pg_get_constraintdef(oid) definition,convalidated
    FROM pg_constraint WHERE conrelid='public.event'::regclass AND contype='c'`)).rows;
  assert.ok(checks.some(c => c.convalidated && c.definition === "CHECK ((capacity_mode = ANY (ARRAY['legacy'::text, 'total'::text])))"));
  assert.ok(checks.some(c => c.convalidated && c.definition === 'CHECK ((total_capacity >= 0))'));
  const triggers = (await db.query(`SELECT tgname name,tgrelid::regclass::text relation,
    tgfoid::regprocedure::text fn,tgtype::integer type,tgenabled enabled,
    tgdeferrable deferrable,tginitdeferred deferred FROM pg_trigger WHERE NOT tgisinternal
    AND tgname=ANY($1) ORDER BY tgname`, [[
    'simple_event_capacity_contract','simple_event_capacity_lock','simple_event_capacity_verify',
    'simple_event_commercial_capacity_lock','simple_event_commercial_capacity_verify',
  ]])).rows;
  const wanted = [
    ['simple_event_capacity_contract','event','simple_event_capacity_contract()',23,false],
    ['simple_event_capacity_lock','booking','lock_simple_event_capacity()',23,false],
    ['simple_event_capacity_verify','booking','verify_simple_event_capacity()',21,true],
    ['simple_event_commercial_capacity_lock','sales_commercial_allocation_movement','lock_simple_event_capacity()',7,false],
    ['simple_event_commercial_capacity_verify','sales_commercial_allocation_movement','verify_simple_event_capacity()',5,true],
  ].sort((a,b) => a[0].localeCompare(b[0])).map(([name,relation,fn,type,deferred]) => ({
    name,relation,fn,type,enabled:'O',deferrable:deferred,deferred,
  }));
  assert.deepEqual(triggers, wanted, 'Trigger contract differs');
}
