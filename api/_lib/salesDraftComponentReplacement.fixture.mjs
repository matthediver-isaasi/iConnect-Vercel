import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Runs only in the disposable database created by the real Sales migration suite.
export async function verifyDraftComponentReplacement(db) {
  const tenant = randomUUID(), other = randomUUID(), actor = randomUUID();
  const product = randomUUID(), bundle = randomUUID(), event = randomUUID();
  await db.query('INSERT INTO tenant VALUES($1),($2)', [tenant, other]);
  await db.query(`INSERT INTO event(id,tenant_id,title) VALUES($1,$2,'Fixture')`, [event, tenant]);
  await db.query(`INSERT INTO sales_catalogue_product(id,tenant_id,code,name,currency,standard_price_minor,tax_treatment)
    VALUES($1,$2,'COMP','Component','GBP',100,'zero_rated')`, [product, tenant]);
  await db.query(`INSERT INTO sales_catalogue_bundle(id,tenant_id,code,name,currency,selling_price_minor)
    VALUES($1,$2,'BUNDLE','Bundle','GBP',100)`, [bundle, tenant]);
  const line = { kind: 'free_text', description: 'Ordinary', quantity: '1', standardUnitPriceMinor: 100,
    quotedUnitPriceMinor: 100, priceOverridden: false, discountBps: 0, taxRateBps: 0,
    netMinor: 100, taxMinor: 0, grossMinor: 100, components: [] };
  const bundled = { ...line, kind: 'bundle', catalogueId: bundle, description: 'Bundle',
    components: [{ productId: product, quantity: 1, productSnapshot: { name: 'Frozen component' } }] };
  const payload = lines => ({ currency: 'GBP', termsSnapshot: {}, eventSnapshot: { id: event, kind: 'simple' },
    lines, totals: { netMinor: lines.length * 100, taxMinor: 0, grossMinor: lines.length * 100 } });
  const save = (q, p, t = tenant, expected = q?.row_version) => db.query(
    'SELECT save_sales_quote_draft($1,$2,$3,$4,$5,$6) value',
    [t, q?.id || null, expected || null, p, actor, 'tenant_user']).then(r => r.rows[0].value);
  const snapshot = async () => {
    const result = {};
    for (const table of ['sales_quote', 'sales_quote_version', 'sales_quote_line', 'sales_quote_bundle_component',
      'sales_quote_status_history', 'sales_space_allocation', 'sales_invoice_schedule']) {
      result[table] = (await db.query(`SELECT to_jsonb(t) value FROM ${table} t ORDER BY id`)).rows;
    }
    return result;
  };
  let q = await save(null, payload([bundled, line]));
  const before = await snapshot();
  await assert.rejects(save(q, payload([bundled, line])), /Issued bundle snapshots are immutable/);
  assert.deepEqual(await snapshot(), before, 'original failure rolls back all writes');
  const definitions = async () => (await db.query(`SELECT proname,proacl,pg_get_functiondef(oid) definition
    FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN
    ('save_sales_quote_draft','guard_quote_child_immutable','guard_quote_component_immutable') ORDER BY proname`)).rows;
  const guards = await definitions();
  const migration = readFileSync('supabase/migrations/202610270001_sales_draft_component_replacement.sql','utf8');
  await db.query(migration);
  await db.query(migration); // safe replay
  assert.deepEqual(await definitions(), guards, 'wrapper, guards and their grants stay byte-for-byte unchanged');
  assert.equal((await db.query(`SELECT has_function_privilege('service_role',
    'save_sales_quote_draft_before_exhibition(uuid,uuid,integer,jsonb,text,text)','EXECUTE') allowed`)).rows[0].allowed, false);
  q = await save(q, payload([bundled, line]));
  q = await save(q, payload([bundled, line]));
  q = await save(q, payload([bundled]));
  assert.equal(q.net_minor, 100);
  assert.deepEqual((await db.query(`SELECT product_snapshot FROM sales_quote_bundle_component WHERE tenant_id=$1`, [tenant])).rows,
    [{ product_snapshot: { name: 'Frozen component' } }]);
  const stable = await snapshot();
  const invalid = payload([bundled]); invalid.totals.netMinor = 999;
  for (const attempt of [
    () => save(q, invalid),
    () => save(q, payload([line]), tenant, q.row_version - 1),
    () => save(q, payload([line]), other),
  ]) {
    await assert.rejects(attempt());
    assert.deepEqual(await snapshot(), stable);
  }
  // Real exhibition synchronization after line replacement: retain and release holds.
  const req = (await db.query(`INSERT INTO sales_space_requirement(tenant_id,name) VALUES($1,'Stand') RETURNING id`, [tenant])).rows[0].id;
  // This product is already used by a draft; create a separate exhibition product.
  const spaceProduct = randomUUID();
  await db.query(`INSERT INTO sales_catalogue_product(id,tenant_id,code,name,currency,standard_price_minor,space_requirement_id,tax_treatment)
    VALUES($1,$2,'SPACE','Stand','GBP',100,$3,'zero_rated')`, [spaceProduct, tenant, req]);
  const group = (await db.query(`INSERT INTO sales_space_group(tenant_id,requirement_id,event_id,event_kind,name,prefix,currency)
    VALUES($1,$2,$3,'simple','Stands','ST','GBP') RETURNING id`, [tenant, req, event])).rows[0].id;
  const space = (await db.query(`INSERT INTO sales_exhibition_space(tenant_id,group_id,event_id,event_kind,reference,price_minor)
    VALUES($1,$2,$3,'simple','ST-1',100) RETURNING id`, [tenant, group, event])).rows[0].id;
  const held = { ...bundled, components: [{ productId: spaceProduct, quantity: 1, productSnapshot: { name: 'Stand' } }],
    catalogueSnapshot: { exhibition: { slots: [{ key: 'stand', requirementId: req }],
      selections: [{ slotKey: 'stand', spaceId: space, reference: 'ST-1', priceMinor: 100, currency: 'GBP' }] } } };
  q = await save(q, payload([held, line]));
  const allocation = (await db.query('SELECT * FROM sales_space_allocation WHERE quote_id=$1', [q.id])).rows;
  q = await save(q, payload([held, line]));
  assert.deepEqual((await db.query('SELECT * FROM sales_space_allocation WHERE quote_id=$1', [q.id])).rows, allocation);
  const heldState = await snapshot();
  const badHeld = structuredClone(held); badHeld.catalogueSnapshot.exhibition.selections[0].priceMinor = 999;
  await assert.rejects(save(q, payload([badHeld, line])), /price changed/);
  assert.deepEqual(await snapshot(), heldState, 'wrapper failure rolls back lines and holds');
  q = await save(q, payload([line]));
  assert.equal((await db.query('SELECT state FROM sales_space_allocation WHERE quote_id=$1', [q.id])).rows[0].state, 'released');
  assert.equal((await db.query('SELECT count(*) FROM sales_quote_bundle_component WHERE tenant_id=$1', [tenant])).rows[0].count, '0');
  assert.equal((await db.query('SELECT gross_minor FROM sales_quote_version WHERE id=$1', [q.version_id])).rows[0].gross_minor, '100');
  const issued = await save(null, payload([bundled]));
  const draft = await save(null, payload([bundled]));
  await db.query('SELECT issue_sales_quote($1,$2,$3,$4,$5)', [tenant, issued.id, issued.row_version, actor, 'tenant_user']);
  const child = async version => (await db.query('SELECT id FROM sales_quote_line WHERE quote_version_id=$1', [version])).rows[0].id;
  const issuedLine = await child(issued.version_id), draftLine = await child(draft.version_id);
  const protectedState = await snapshot();
  for (const sql of [
    `DELETE FROM sales_quote_line WHERE id='${issuedLine}'`,
    `UPDATE sales_quote_line SET description='tampered' WHERE id='${issuedLine}'`,
    `UPDATE sales_quote_line SET quote_version_id='${draft.version_id}' WHERE id='${issuedLine}'`,
    `UPDATE sales_quote_line SET quote_version_id='${issued.version_id}' WHERE id='${draftLine}'`,
    `DELETE FROM sales_quote_bundle_component WHERE quote_line_id='${issuedLine}'`,
    `UPDATE sales_quote_bundle_component SET quantity=2 WHERE quote_line_id='${issuedLine}'`,
    `UPDATE sales_quote_bundle_component SET quote_line_id='${draftLine}' WHERE quote_line_id='${issuedLine}'`,
    `UPDATE sales_quote_bundle_component SET quote_line_id='${issuedLine}' WHERE quote_line_id='${draftLine}'`,
    `UPDATE sales_quote_bundle_component SET tenant_id='${other}' WHERE quote_line_id='${draftLine}'`,
  ]) {
    await assert.rejects(db.query(sql), /immutable/);
    assert.deepEqual(await snapshot(), protectedState);
  }
}
