import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { seedMemberCpdRoleAccess } from './seed-member-cpd-role-access.mjs';

const uuid = number => `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

test('member CPD role catalogue seed on a disposable PostgreSQL cluster', { timeout: 90_000 }, async t => {
  assert.equal(process.env.TEST_ISOLATION_ACTIVE, '1', 'Use scripts/run-isolated-tests.mjs');
  assert.equal(process.env.TEST_ISOLATION_ALLOW_LOCAL_PG, '1', 'Use --allow-local-postgres');

  const root = await mkdtemp(path.join(tmpdir(), 'member-cpd-role-seed-'));
  const data = path.join(root, 'data');
  const socket = path.join(root, 'socket');
  await mkdir(socket);
  let client;
  let started = false;

  const reset = async () => {
    await client.query(`
      TRUNCATE portal_menu, role, role_access_item RESTART IDENTITY CASCADE;
      INSERT INTO role_access_item
        (id,item_type,item_key,label,icon,parent_id,display_order,is_active,settings)
      VALUES
        ('${uuid(1)}','module','membership','Membership','Users',NULL,4,true,'{"colour":"blue"}'),
        ('${uuid(2)}','module','commerce','Commerce','Card',NULL,9,true,'{"colour":"green"}');
      INSERT INTO role (id,name,excluded_features,settings)
      VALUES ('${uuid(20)}','Restricted','["cpd.old-page","commerce"]','{"landing":"home"}');
      INSERT INTO portal_menu (id,name,feature_id,position,settings)
      VALUES ('${uuid(30)}','Learning','cpd.old-page',7,'{"icon":"book","visible":true}');
    `);
  };
  const catalogue = async () => (await client.query(
    'SELECT id,item_type,item_key,label,icon,parent_id,display_order,is_active,settings FROM role_access_item ORDER BY id',
  )).rows;
  const protectedData = async () => (await client.query(`
    SELECT jsonb_build_object(
      'siblings',(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM role_access_item i
        WHERE item_key NOT IN ('cpd','cpd.member_cpd')),
      'roles',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM role r),
      'menus',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM portal_menu m)
    ) AS value
  `)).rows[0].value;
  const seed = async () => {
    await client.query('BEGIN');
    try {
      const result = await seedMemberCpdRoleAccess(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  };

  try {
    execFileSync('initdb', ['-D', data, '--no-locale', '--encoding=UTF8', '--auth=trust', '-U', 'postgres'], { stdio: 'pipe' });
    execFileSync(
      'pg_ctl',
      ['-D', data, '-l', path.join(root, 'postgres.log'), '-o', `-k ${socket} -c listen_addresses=''`, '-w', 'start'],
      { stdio: 'pipe' },
    );
    started = true;
    client = new pg.Client({ host: socket, user: 'postgres', database: 'postgres' });
    await client.connect();
    await client.query(`
      CREATE TABLE role_access_item (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        item_type text NOT NULL,
        item_key text NOT NULL,
        label text NOT NULL,
        icon text,
        parent_id uuid REFERENCES role_access_item(id),
        display_order integer NOT NULL,
        is_active boolean NOT NULL,
        settings jsonb NOT NULL DEFAULT '{}'
      );
      CREATE TABLE role (
        id uuid PRIMARY KEY,
        name text NOT NULL,
        excluded_features jsonb NOT NULL,
        settings jsonb NOT NULL
      );
      CREATE TABLE portal_menu (
        id uuid PRIMARY KEY,
        name text NOT NULL,
        feature_id text,
        position integer NOT NULL,
        settings jsonb NOT NULL
      );
    `);

    await t.test('initial seed creates canonical module and page without changing sibling access, exclusions, or menus', async () => {
      await reset();
      const before = await protectedData();
      const result = await seed();
      assert.deepEqual(result, {
        item_key: 'cpd.member_cpd',
        label: 'Member CPD',
        is_active: true,
        parent_key: 'cpd',
      });
      const { rows } = await client.query(`
        SELECT p.item_type,p.item_key,p.label,p.icon,p.display_order,p.is_active,
          m.item_type AS parent_type,m.item_key AS parent_key,m.label AS parent_label,
          m.icon AS parent_icon,m.display_order AS parent_order,m.is_active AS parent_active
        FROM role_access_item p JOIN role_access_item m ON m.id=p.parent_id
        WHERE p.item_key='cpd.member_cpd'
      `);
      assert.deepEqual(rows, [{
        item_type: 'page',
        item_key: 'cpd.member_cpd',
        label: 'Member CPD',
        icon: null,
        display_order: 0,
        is_active: true,
        parent_type: 'module',
        parent_key: 'cpd',
        parent_label: 'CPD',
        parent_icon: 'Award',
        parent_order: 10,
        parent_active: true,
      }]);
      assert.deepEqual(await protectedData(), before);
    });

    await t.test('replay makes no catalogue or related-data changes', async () => {
      const beforeCatalogue = await catalogue();
      const beforeProtected = await protectedData();
      const beforeVersions = (await client.query(
        "SELECT id,xmin::text FROM role_access_item WHERE item_key IN ('cpd','cpd.member_cpd') ORDER BY item_key",
      )).rows;
      await seed();
      assert.deepEqual(await catalogue(), beforeCatalogue);
      assert.deepEqual(await protectedData(), beforeProtected);
      assert.deepEqual((await client.query(
        "SELECT id,xmin::text FROM role_access_item WHERE item_key IN ('cpd','cpd.member_cpd') ORDER BY item_key",
      )).rows, beforeVersions, 'replay must not issue an UPDATE to canonical rows');
    });

    await t.test('existing canonical page identity is repaired while unrelated values survive', async () => {
      await reset();
      await client.query(`
        INSERT INTO role_access_item
          (id,item_type,item_key,label,icon,parent_id,display_order,is_active,settings)
        VALUES
          ('${uuid(3)}','module','cpd','CPD','Award',NULL,12,true,'{"module":"keep"}'),
          ('${uuid(4)}','page','cpd.sibling','CPD History','Clock','${uuid(3)}',3,true,'{"permission":"keep"}'),
          ('${uuid(5)}','page','cpd.member_cpd','Wrong label','Certificate','${uuid(1)}',22,false,'{"page":"keep"}');
      `);
      const beforeProtected = await protectedData();
      await seed();
      const repaired = (await client.query(
        "SELECT item_type,item_key,label,icon,parent_id,display_order,is_active,settings FROM role_access_item WHERE item_key='cpd.member_cpd'",
      )).rows[0];
      assert.deepEqual(repaired, {
        item_type: 'page',
        item_key: 'cpd.member_cpd',
        label: 'Member CPD',
        icon: 'Certificate',
        parent_id: uuid(3),
        display_order: 22,
        is_active: true,
        settings: { page: 'keep' },
      });
      assert.deepEqual(await protectedData(), beforeProtected);
      assert.deepEqual((await client.query(
        "SELECT icon,display_order,settings FROM role_access_item WHERE item_key='cpd'",
      )).rows[0], { icon: 'Award', display_order: 12, settings: { module: 'keep' } });
    });

    await t.test('ambiguous module or page identities fail and leave the transaction unchanged', async () => {
      for (const fixture of [
        `INSERT INTO role_access_item (item_type,item_key,label,parent_id,display_order,is_active)
         VALUES ('module','cpd','CPD one',NULL,10,true),('module','cpd','CPD two',NULL,11,true)`,
        `INSERT INTO role_access_item (item_type,item_key,label,parent_id,display_order,is_active)
         VALUES ('module','cpd','CPD',NULL,10,true),
                ('page','cpd.member_cpd','One',(SELECT id FROM role_access_item WHERE item_key='cpd'),0,true),
                ('page','cpd.member_cpd','Two',(SELECT id FROM role_access_item WHERE item_key='cpd'),1,true)`,
      ]) {
        await reset();
        await client.query(fixture);
        const before = await catalogue();
        await assert.rejects(seed(), /identity is ambiguous/);
        assert.deepEqual(await catalogue(), before);
      }
    });
  } finally {
    if (client) await client.end().catch(() => {});
    if (started) {
      execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    }
    await rm(root, { recursive: true, force: true });
  }
});