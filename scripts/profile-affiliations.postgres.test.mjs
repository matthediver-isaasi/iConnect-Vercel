import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from './test-support/local-postgres-harness.mjs';

test('isolated profile affiliation transaction, protected metadata, rollback and retry', async () => {
  const h = await createLocalPostgresHarness('profile-affiliations-');
  let db, started = false;
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
  };
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    db = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' });
    await db.connect();
    await db.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE organization(id uuid PRIMARY KEY,tenant_id uuid,name text);
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,organization_id uuid,role_id uuid);
      CREATE TABLE role_member_field_permission(id uuid PRIMARY KEY,role_id text,field_key text,permission text);
      CREATE TABLE custom_object_field_role_permission(id uuid PRIMARY KEY,tenant_id uuid,role_id uuid,field_id uuid,access_level text);
      CREATE TABLE custom_object_definition(id uuid PRIMARY KEY,tenant_id uuid,status text,primary_display_field_id uuid);
      CREATE TABLE preference_field(id uuid PRIMARY KEY,tenant_id uuid,custom_object_id uuid,name text,field_type text,is_required boolean);
      CREATE TABLE custom_object_relationship_definition(id uuid PRIMARY KEY,tenant_id uuid,status text,
        source_kind text,target_kind text,source_custom_object_id uuid,target_custom_object_id uuid,cardinality text,configuration jsonb DEFAULT '{}');
      CREATE TABLE custom_object_record(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,custom_object_id uuid,
        data jsonb DEFAULT '{}',archived_at timestamptz,archived_by text,archive_reason text,updated_at timestamptz DEFAULT now(),created_by text);
      CREATE TABLE custom_object_relationship(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,
        relationship_definition_id uuid,source_record_id uuid,target_record_id uuid,field_values jsonb DEFAULT '{}',
        archived_at timestamptz,archived_by text,created_by text);
      GRANT SELECT,UPDATE ON member TO authenticated;
      GRANT ALL ON custom_object_record,custom_object_relationship TO authenticated;
    `);
    const prior = await readFile('supabase/migrations/20261102_form_member_affiliation_snapshots.sql', 'utf8');
    const graph = prior.slice(prior.indexOf('CREATE FUNCTION public.form_member_affiliation_graph'), prior.indexOf('CREATE FUNCTION public.form_member_affiliation_capture'));
    await db.query(graph);
    await db.query(await readFile('supabase/migrations/20261103_profile_member_affiliations.sql', 'utf8'));
    const cfg = { enabled: true, memberDepartmentDefinitionId: id(30), departmentOrganizationDefinitionId: id(31),
      secondaryMemberDefinitionId: id(32), secondaryOrganizationDefinitionId: id(33), secondaryLabelFieldId: id(42) };
    await db.query(`INSERT INTO tenant VALUES($1),($2);
    `, [id(1), id(2)]);
    for (const n of [10, 11, 12]) await db.query('INSERT INTO organization VALUES($1,$2,$3)', [id(n), id(1), `Organisation ${n}`]);
    await db.query('INSERT INTO organization VALUES($1,$2,$3)', [id(13), id(2), 'Other tenant']);
    await db.query('INSERT INTO member VALUES($1,$2,$3,$4),($5,$2,NULL,$4)', [id(3), id(1), id(10), id(4), id(5)]);
    await db.query('INSERT INTO custom_object_definition VALUES($1,$2,$3,$4),($5,$2,$3,$6)', [id(20), id(1), 'active', id(41), id(21), id(42)]);
    await db.query(`INSERT INTO preference_field VALUES($1,$2,$3,'name','text',false),($4,$2,$5,'label','text',false)`,
      [id(41), id(1), id(20), id(42), id(21)]);
    for (const [n, object, target, cardinality] of [[30, 20, 'member', 'many_to_many'], [31, 20, 'organization', 'many_to_one'],
      [32, 21, 'member', 'many_to_one'], [33, 21, 'organization', 'many_to_one']]) {
      await db.query(`INSERT INTO custom_object_relationship_definition(id,tenant_id,status,source_kind,target_kind,source_custom_object_id,cardinality,configuration)
        VALUES($1,$2,'active','custom_object',$3,$4,$5,$6)`, [id(n), id(1), target, id(object), cardinality,
        n === 30 ? { relationship_fields: [{ key: 'survey_respondent', type: 'boolean', default_value: false }] } : {}]);
    }
    for (const n of [50, 51, 52]) {
      await db.query('INSERT INTO custom_object_record(id,tenant_id,custom_object_id,data) VALUES($1,$2,$3,$4)',
        [id(n), id(1), id(20), { name: `Department ${n}` }]);
      await db.query('INSERT INTO custom_object_relationship(tenant_id,relationship_definition_id,source_record_id,target_record_id) VALUES($1,$2,$3,$4)',
        [id(1), id(31), id(n), id(n - 40)]);
    }
    const rpc = async (name, args) => (await db.query(`SELECT ${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) result`, args)).rows[0].result;
    const capture = async (member = id(3)) => rpc('profile_affiliation_capture', [id(1), member]);
    const save = (token, proposal, member = id(3), tenant = id(1)) => rpc('profile_affiliation_apply', [tenant, member, token, proposal]);
    assert.deepEqual(await capture(), { active: false });
    await rpc('profile_affiliation_policy_save', [id(1), 0, cfg]);
    await assert.rejects(rpc('profile_affiliation_policy_save', [id(1), 0, cfg]), /Settings changed/);
    let snapshot = await capture();
    await assert.rejects(save(snapshot.token, { primary: id(13) }), /Organisation unavailable/);
    await assert.rejects(save(snapshot.token, {}, id(5)), /Reload/);
    await assert.rejects(save(snapshot.token, {}, id(3), id(2)), /Reload/);
    const proposal = { primary: id(10), secondary: [id(11)], departments: [id(50), id(51)] };
    assert.equal((await save(snapshot.token, proposal)).committed, true);
    assert.equal((await save(snapshot.token, proposal)).replayed, true);
    await assert.rejects(save(snapshot.token, { primary: null }), /already used/);
    const edges = async () => (await db.query('SELECT * FROM custom_object_relationship WHERE relationship_definition_id=$1 AND target_record_id=$2 AND archived_at IS NULL ORDER BY id', [id(30), id(3)])).rows;
    assert.equal((await edges()).length, 2);
    assert.ok((await edges()).every(e => e.field_values.survey_respondent === false));
    snapshot = await capture();
    await assert.rejects(save(snapshot.token, { primary: id(12) }), /Review department removals/);
    assert.equal((await db.query('SELECT organization_id FROM member WHERE id=$1', [id(3)])).rows[0].organization_id, id(10));
    assert.equal((await edges()).length, 2);
    await save(snapshot.token, { primary: id(12), departments: [id(51), id(52)] });
    assert.equal((await edges()).length, 2);
    await db.query("UPDATE custom_object_relationship SET field_values='{\"survey_respondent\":true}' WHERE relationship_definition_id=$1 AND source_record_id=$2 AND target_record_id=$3", [id(30), id(51), id(3)]);
    snapshot = await capture();
    await assert.rejects(save(snapshot.token, { departments: [] }), /protected respondent/);
    await assert.rejects(save(snapshot.token, { secondary: [] }), /administrator assistance/);
    // A pre-existing protected cross-organisation link is grandfathered.
    await db.query('UPDATE member SET organization_id=$1 WHERE id=$2', [id(10), id(3)]);
    snapshot = await capture();
    await save(snapshot.token, {});
    assert.equal((await edges()).length, 2);
    snapshot = await capture();
    await db.query('UPDATE member SET organization_id=$1 WHERE id=$2', [id(12), id(3)]);
    await assert.rejects(save(snapshot.token, {}), /changed or expired/);
    // Explicit null supports no-primary while secondary scope remains.
    snapshot = await capture();
    await save(snapshot.token, { primary: null, departments: [id(51)] });
    snapshot = await capture();
    const choices = await rpc('profile_affiliation_choices', [id(1), id(3), snapshot.token, 'department', '', 1, null, [id(11)]]);
    assert.deepEqual(choices.items.map(x => x.id), [id(51)]);
    assert.equal(choices.items[0].organizationLabel, 'Organisation 11');
    await rpc('profile_affiliation_policy_save', [id(1), 1, { ...cfg, enabled: false }]);
    await assert.rejects(save(snapshot.token, {}), /settings changed/);
    assert.deepEqual(await capture(), { active: false });
    await db.query('SET ROLE authenticated');
    await assert.rejects(db.query('UPDATE member SET organization_id=$1 WHERE id=$2', [id(10), id(3)]), /affiliation service/);
    await assert.rejects(db.query('SELECT profile_affiliation_capture($1,$2)', [id(1), id(3)]), /permission denied/);
    await assert.rejects(db.query('UPDATE profile_affiliation_policy SET config=$1', [cfg]), /permission denied/);
    await assert.rejects(db.query('UPDATE custom_object_relationship SET archived_at=now()'), /permission denied/);
    await db.query('RESET ROLE');
    // Scope rejection must roll back an earlier archive and bridge mutation.
    await rpc('profile_affiliation_policy_save', [id(1), 2, cfg]);
    snapshot = await capture();
    await assert.rejects(save(snapshot.token, { primary: id(10), secondary: [id(12)], departments: [id(50), id(51)] }), /Review/);
    assert.equal((await edges()).length, 1);
    assert.equal((await db.query('SELECT count(*)::int n FROM profile_affiliation_operation WHERE committed_at IS NOT NULL')).rows[0].n, 4);
    // Force a late insert failure after the primary/bridge mutations. Every
    // mutation and the audit stamp must roll back, and the same token can retry.
    snapshot = await capture();
    await db.query(`CREATE FUNCTION reject_fixture_department() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.relationship_definition_id='${id(30)}' AND NEW.source_record_id='${id(50)}' THEN
        RAISE EXCEPTION 'fixture late failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_fixture_department BEFORE INSERT ON custom_object_relationship FOR EACH ROW EXECUTE FUNCTION reject_fixture_department();`);
    const lateProposal = { primary: id(10), secondary: [id(11), id(12)], departments: [id(50), id(51)] };
    await assert.rejects(save(snapshot.token, lateProposal), /fixture late failure/);
    assert.equal((await db.query('SELECT organization_id FROM member WHERE id=$1', [id(3)])).rows[0].organization_id, null);
    assert.equal((await db.query('SELECT committed_at FROM profile_affiliation_operation WHERE id=$1', [snapshot.token])).rows[0].committed_at, null);
    await db.query('DROP TRIGGER reject_fixture_department ON custom_object_relationship');
    await save(snapshot.token, lateProposal);
    assert.equal((await edges()).length, 2);
    // Archived definitions and restrictive field grants invalidate an open edit.
    snapshot = await capture();
    await db.query("UPDATE custom_object_relationship_definition SET status='archived' WHERE id=$1", [id(30)]);
    await assert.rejects(save(snapshot.token, {}), /changed or expired/);
    await db.query("UPDATE custom_object_relationship_definition SET status='active' WHERE id=$1", [id(30)]);
    await db.query("INSERT INTO custom_object_field_role_permission VALUES($1,$2,$3,$4,'none')", [id(70), id(1), id(4), id(41)]);
    await assert.rejects(capture(), /labels are restricted/);
    await db.query('DELETE FROM custom_object_field_role_permission');
    // Search is literal, stable and bounded beyond one page.
    for (let n = 100; n < 130; n++) await db.query('INSERT INTO organization VALUES($1,$2,$3)', [id(n), id(1), `Pagination ${n}`]);
    snapshot = await capture();
    const first = await rpc('profile_affiliation_choices', [id(1), id(3), snapshot.token, 'organization', 'Pagination', 1, null, []]);
    const second = await rpc('profile_affiliation_choices', [id(1), id(3), snapshot.token, 'organization', 'Pagination', 2, null, []]);
    assert.equal(first.items.length, 25); assert.equal(first.hasMore, true);
    assert.equal(second.items.length, 5); assert.equal(second.hasMore, false);
    assert.equal(new Set([...first.items, ...second.items].map(x => x.id)).size, 30);
    // Second tenant has reversed member and ownership sides, with no bridge.
    await db.query('INSERT INTO member VALUES($1,$2,NULL,$3)', [id(200), id(2), id(4)]);
    await db.query("INSERT INTO custom_object_definition VALUES($1,$2,'active',$3)", [id(201), id(2), id(202)]);
    await db.query("INSERT INTO preference_field VALUES($1,$2,$3,'name','text',false)", [id(202), id(2), id(201)]);
    await db.query(`INSERT INTO custom_object_relationship_definition(id,tenant_id,status,source_kind,target_kind,target_custom_object_id,cardinality)
      VALUES($1,$2,'active','member','custom_object',$3,'many_to_many'),($4,$2,'active','organization','custom_object',$3,'one_to_many')`,
    [id(203), id(2), id(201), id(204)]);
    await db.query(`INSERT INTO custom_object_record(id,tenant_id,custom_object_id,data) VALUES($1,$2,$3,'{"name":"Generic department"}')`, [id(205), id(2), id(201)]);
    await db.query('INSERT INTO custom_object_relationship(tenant_id,relationship_definition_id,source_record_id,target_record_id) VALUES($1,$2,$3,$4)', [id(2), id(204), id(13), id(205)]);
    await rpc('profile_affiliation_policy_save', [id(2), 0, { enabled: true, memberDepartmentDefinitionId: id(203), departmentOrganizationDefinitionId: id(204) }]);
    const generic = await rpc('profile_affiliation_capture', [id(2), id(200)]);
    await save(generic.token, { primary: id(13), departments: [id(205)] }, id(200), id(2));
    assert.equal((await db.query('SELECT count(*)::int n FROM custom_object_relationship WHERE relationship_definition_id=$1 AND source_record_id=$2', [id(203), id(200)])).rows[0].n, 1);
  } finally {
    await db?.end();
    if (started) spawnSync('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});
