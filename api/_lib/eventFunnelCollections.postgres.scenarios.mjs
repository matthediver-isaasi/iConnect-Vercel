import assert from 'node:assert/strict';
// Funnel Groups and event-side links. Runs after ticket routing, reusing its
// published complex-event funnel (tenant ticket `ticket` routed by `def`).
export async function exerciseFunnelCollections({ db, uuid, tenant, sql }) {
  await db.query(await sql('202711270002_event_funnel_groups_event_links.sql'));
  const complex = uuid(9560), ticket = uuid(9561), def = uuid(9562), other = uuid(9570);
  const foreignTenant = uuid(9599);
  const resolve = async () => (await db.query(`SELECT event_funnel_resolve_entry($1,'complex',$2,$3) r`,
    [tenant, complex, ticket])).rows[0].r;
  const link = (definition, collection, revision) => db.query(
    `SELECT event_funnel_set_event_link($1,'complex',$2,$3,$4,$5,'fixture') r`, [tenant, complex, definition, collection, revision]);
  const saveGroup = (id, name, revision = 0, scope = tenant) => db.query(
    `SELECT event_funnel_collection_save($1,$2,$3,$4,'fixture') r`, [scope, id, name, revision]);
  const assign = (definition, collection, scope = tenant) => db.query(
    `SELECT event_funnel_collection_assign($1,$2,$3,'fixture') r`, [scope, definition, collection]);

  // No link: unchanged routing.
  const before = await resolve();
  assert.equal(before.active, true);
  const graph = (await db.query('SELECT graph FROM event_funnel_definition WHERE id=$1', [def])).rows[0].graph;
  await db.query(`SELECT event_funnel_save_definition($1,$2,'fixture',0,'Unrelated',$3,'{"positions":{}}')`, [tenant, other, graph]);

  // Linked to a specific different funnel: the routed funnel is out of scope.
  await link(other, null, 0);
  assert.equal((await resolve()).reason, 'no_match');
  await link(def, null, 1);
  assert.equal((await resolve()).versionId, before.versionId);
  await assert.rejects(link(def, null, 1), { code: 'PT409' });
  await assert.rejects(link(def, uuid(9571), 2), { code: '22023' });

  // Group CRUD and group-scoped resolution.
  const group = uuid(9572), empty = uuid(9573);
  assert.equal((await saveGroup(group, ' Spring conference ')).rows[0].r.name, 'Spring conference');
  await assert.rejects(saveGroup(empty, 'spring CONFERENCE'), { code: 'PT409' });
  await saveGroup(empty, 'Empty');
  assert.equal((await saveGroup(group, 'Spring 2027', 1)).rows[0].r.revision, 2);
  await assert.rejects(saveGroup(group, 'Stale', 1), { code: 'PT409' });
  await assign(def, group); await assign(other, group);
  await link(null, empty, 2);
  assert.equal((await resolve()).reason, 'no_match');
  await link(null, group, 3);
  assert.equal((await resolve()).versionId, before.versionId);
  await assign(def, empty); // a funnel belongs to at most one group
  assert.equal((await db.query('SELECT count(*)::int n FROM event_funnel_collection_member WHERE definition_id=$1', [def])).rows[0].n, 1);
  assert.equal((await resolve()).reason, 'no_match');
  await assign(def, group);

  // Linked definitions cannot be removed underneath an event.
  await link(other, null, 4);
  await assert.rejects(db.query('DELETE FROM event_funnel_definition WHERE id=$1', [other]), { code: '23503' });
  await link(null, group, 5);

  // Deleting a group explicitly clears event links that depended on it.
  await assert.rejects(db.query(`SELECT event_funnel_collection_delete($1,$2,1,'fixture')`, [tenant, group]), { code: 'PT409' });
  const deleted = (await db.query(`SELECT event_funnel_collection_delete($1,$2,2,'fixture') r`, [tenant, group])).rows[0].r;
  assert.equal(deleted.clearedEventLinks, 1);
  const cleared = (await db.query('SELECT definition_id,collection_id,revision FROM event_funnel_event_link WHERE event_id=$1', [complex])).rows[0];
  assert.deepEqual([cleared.definition_id, cleared.collection_id, cleared.revision], [null, null, 7]);
  assert.equal((await resolve()).versionId, before.versionId);

  // Tenant isolation: another tenant cannot see or reference these rows.
  await assert.rejects(assign(def, empty, foreignTenant), { code: 'PT404' });
  await assert.rejects(db.query(`SELECT event_funnel_set_event_link($1,'complex',$2,NULL,NULL,0,'fixture')`,
    [foreignTenant, complex]), { code: 'PT404' });
  await saveGroup(uuid(9574), 'Foreign group', 0, foreignTenant);
  await assert.rejects(link(null, uuid(9574), 7), { code: 'PT404' });
  await assert.rejects(saveGroup(empty, 'Hijack', 1, foreignTenant), { code: 'PT409' });

  for (const role of ['anon', 'authenticated']) {
    await db.query(`SET ROLE ${role}`);
    await assert.rejects(db.query('SELECT * FROM event_funnel_collection'), { code: '42501' });
    await assert.rejects(link(null, null, 7), { code: '42501' });
    await db.query('RESET ROLE');
  }
  await db.query('SET ROLE service_role');
  await assert.rejects(db.query(`INSERT INTO event_funnel_collection(tenant_id,name,updated_by) VALUES($1,'x','x')`, [tenant]), { code: '42501' });
  await db.query('RESET ROLE');
}
