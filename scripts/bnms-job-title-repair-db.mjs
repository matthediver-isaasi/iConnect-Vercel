import assert from 'node:assert/strict';
import { TENANT, hash, checkCurrent } from './bnms-job-title-repair-core.mjs';

export async function liveSchema(db) {
  const columns = (await db.query("select table_name,column_name,data_type,is_nullable,column_default from information_schema.columns where table_schema='public' and table_name in ('member','member_note') order by table_name,ordinal_position")).rows;
  const triggers = (await db.query("select c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) definition,pg_get_functiondef(t.tgfoid) function from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('member','member_note') and not t.tgisinternal order by c.relname,t.tgname")).rows;
  const helpers = (await db.query("select proname,pg_get_functiondef(oid) definition from pg_proc where pronamespace='public'::regnamespace and proname in ('queue_automatic_memberships_for_source_changes','department_current_set_auth_lock') order by proname")).rows;
  const constraints = (await db.query("select conrelid::regclass::text relation,conname,pg_get_constraintdef(oid) definition from pg_constraint where conrelid in ('public.member'::regclass,'public.member_note'::regclass) order by conrelid::regclass::text,conname")).rows;
  return { columns, triggers, helpers, constraints };
}

export async function readMembers(db) {
  return (await db.query('select to_jsonb(m) record from public.member m where tenant_id=$1 order by id', [TENANT])).rows.map(r => r.record);
}

export async function executeRepair(db, items, schemaHash, { apply = false, journal = () => {} } = {}) {
  assert.equal(new Set(items.map(i => i.id)).size, items.length, 'Duplicate identities');
  for (const item of items) {
    assert.equal(item.tenant_id, TENANT);
    assert.equal(item.before.id, item.id);
    assert.equal(item.before.tenant_id, TENANT);
    assert.ok(item.title === null ? item.note : typeof item.title === 'string' && item.title.trim());
  }
  await db.query(apply ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await db.query("SET LOCAL lock_timeout='5s'");
    await db.query("SET LOCAL statement_timeout='60s'");
    assert.deepEqual((await db.query('select id,name from public.tenant where id=$1', [TENANT])).rows, [{ id: TENANT, name: 'BNMS' }]);
    assert.equal(hash(await liveSchema(db)), schemaHash, 'Reviewed schema changed');
    // Lock rule configuration against concurrent edits; no broad member/table write lock.
    if (apply) await db.query('select id from public.member_group where tenant_id=$1 order by id for share', [TENANT]);
    const readGroups = async () => (await db.query('select to_jsonb(g) record from public.member_group g where tenant_id=$1 order by id', [TENANT])).rows;
    const groups = await readGroups();
    for (const { record: group } of groups) if (group.automatic_membership_enabled) {
      assert.ok(Array.isArray(group.automatic_membership_filter_groups), 'Unknown automatic rule shape');
      for (const g of group.automatic_membership_filter_groups) {
        assert.ok(Array.isArray(g.conditions), 'Unknown automatic rule shape');
        assert.ok(!g.conditions.some(c => c.entity_scope === 'member' && c.field_type === 'core' && c.field_key === 'job_title'), 'Job-title group rule requires separate consequence review');
      }
    }
    const notesBefore = (await db.query('select to_jsonb(n) record from public.member_note n join public.member m on m.id::text=n.target_member_id where m.tenant_id=$1 order by n.id', [TENANT])).rows.map(r => r.record);
    const before = [], after = [], pending = [];
    for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
      const result = await db.query(`select to_jsonb(m) record from public.member m where id=$1 and tenant_id=$2 ${apply ? 'for update' : ''}`, [item.id, TENANT]);
      const current = result.rows[0]?.record;
      const note = item.note ? notesBefore.find(n => n.id === item.note.id) : null;
      if (checkCurrent(item, current, note) === 'replay') { after.push(current); continue; }
      before.push(current); pending.push(item);
    }
    if (!apply) { await db.query('ROLLBACK'); return { pending: pending.length, replayed: items.length - pending.length }; }
    // Durable rollback evidence is written BEFORE the first mutation.
    journal('before', { items: pending, before, notesBefore });
    for (const item of pending) {
      if (item.note) {
        const n = item.note;
        assert.equal(n.target_member_id, item.id); assert.equal(n.author_member_id, null);
        await db.query('insert into public.member_note(id,target_member_id,author_member_id,content,attachments) values($1,$2,null,$3,$4::jsonb)', [n.id, item.id, n.content, '[]']);
      }
      const updated = await db.query('update public.member set job_title=$1 where id=$2 and tenant_id=$3 and job_title is not distinct from $4 returning to_jsonb(member) record', [item.title, item.id, TENANT, item.before.job_title]);
      assert.equal(updated.rowCount, 1);
      const actual = updated.rows[0].record;
      assert.deepEqual(actual, { ...item.before, job_title: item.title, updated_at: actual.updated_at, survey_invitation_revision: item.before.survey_invitation_revision + 1 }, 'Unexpected member field or trigger change');
      after.push(actual);
    }
    const notesAfter = (await db.query('select to_jsonb(n) record from public.member_note n join public.member m on m.id::text=n.target_member_id where m.tenant_id=$1 order by n.id', [TENANT])).rows.map(r => r.record);
    assert.equal(notesAfter.length, notesBefore.length + pending.filter(i => i.note).length);
    for (const note of notesBefore) assert.deepEqual(notesAfter.find(n => n.id === note.id), note, 'Existing note changed');
    for (const { note } of pending.filter(i => i.note)) {
      const actual = notesAfter.find(n => n.id === note.id);
      for (const key of Object.keys(note)) assert.equal(actual[key], note[key], 'Note preservation failed');
    }
    assert.deepEqual(await readGroups(), groups, 'Unexpected automatic-group side effect');
    journal('precommit', { before, after, insertedNotes: pending.filter(i => i.note).map(i => i.note), changed: pending.length });
    await db.query('COMMIT');
    // A new transaction-independent read verifies committed rows and note content.
    for (const actual of after) {
      const read = (await db.query('select to_jsonb(m) record from public.member m where id=$1 and tenant_id=$2', [actual.id, TENANT])).rows[0]?.record;
      assert.deepEqual(read, actual, 'Post-commit drift; inspect journal, do not overwrite');
    }
    for (const item of pending.filter(i => i.note)) {
      const note = (await db.query('select * from public.member_note where id=$1', [item.note.id])).rows[0];
      for (const key of Object.keys(item.note)) assert.equal(note?.[key], item.note[key]);
    }
    return { changed: pending.length, notes: pending.filter(i => i.note).length, replayed: items.length - pending.length, after };
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
