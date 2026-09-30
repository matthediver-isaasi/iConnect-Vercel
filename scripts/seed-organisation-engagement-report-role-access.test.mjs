import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import pg from 'pg';
import {
  seedOrganisationEngagementReportRoleAccess,
} from './seed-organisation-engagement-report-role-access.mjs';

const uuid = number => `20000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

test('organisation engagement report role catalogue seed on disposable PostgreSQL', { timeout: 90_000 }, async t => {
  assert.equal(process.env.TEST_ISOLATION_ACTIVE, '1', 'Use scripts/run-isolated-tests.mjs');
  assert.equal(process.env.TEST_ISOLATION_ALLOW_LOCAL_PG, '1', 'Use --allow-local-postgres');

  const root = await mkdtemp(path.join(tmpdir(), 'org-engagement-role-seed-'));
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
        ('${uuid(1)}','module','events','Events','Calendar',NULL,4,true,'{"colour":"blue"}'),
        ('${uuid(2)}','page','events.event-report','Event Registration Report',NULL,NULL,9,true,'{"keep":true}');
      INSERT INTO role (id,name,excluded_features,settings)
      VALUES ('${uuid(20)}','Restricted','["events.event-report"]','{"landing":"home"}');
      INSERT INTO portal_menu (id,name,feature_id,position,settings)
      VALUES ('${uuid(30)}','Reports','events.event-report',7,'{"visible":true}');
    `);
  };
  const catalogue = async () => (await client.query(
    'SELECT id,item_type,item_key,label,icon,parent_id,display_order,is_active,settings FROM role_access_item ORDER BY id',
  )).rows;
  const protectedData = async () => (await client.query(`
    SELECT jsonb_build_object(
      'unrelated',(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM role_access_item i
        WHERE item_key NOT IN ('reports','reports.org-engagement')),
      'roles',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM role r),
      'menus',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM portal_menu m)
    ) AS value
  `)).rows[0].value;
  const seed = async () => {
    await client.query('BEGIN');
    try {
      const result = await seedOrganisationEngagementReportRoleAccess(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  };

  try {
    execFileSync(
      'initdb',
      ['-D', data, '--no-locale', '--encoding=UTF8', '--auth=trust', '-U', 'postgres'],
      { stdio: 'pipe' },
    );
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

    await t.test('creates only the Reports module and engagement page', async () => {
      await reset();
      const before = await protectedData();
      assert.deepEqual(await seed(), {
        item_key: 'reports.org-engagement',
        label: 'Organisation Engagement Report',
        is_active: true,
        parent_key: 'reports',
      });
      const { rows } = await client.query(`
        SELECT p.item_type,p.item_key,p.label,p.icon,p.display_order,p.is_active,
          m.item_type AS parent_type,m.item_key AS parent_key,m.label AS parent_label,
          m.icon AS parent_icon,m.display_order AS parent_order,m.is_active AS parent_active
        FROM role_access_item p JOIN role_access_item m ON m.id=p.parent_id
        WHERE p.item_key='reports.org-engagement'
      `);
      assert.deepEqual(rows, [{
        item_type: 'page',
        item_key: 'reports.org-engagement',
        label: 'Organisation Engagement Report',
        icon: null,
        display_order: 0,
        is_active: true,
        parent_type: 'module',
        parent_key: 'reports',
        parent_label: 'Reports',
        parent_icon: 'BarChart3',
        parent_order: 5,
        parent_active: true,
      }]);
      assert.deepEqual(await protectedData(), before);
    });

    await t.test('replay is a complete no-op', async () => {
      const beforeCatalogue = await catalogue();
      const beforeProtected = await protectedData();
      const beforeVersions = (await client.query(
        "SELECT id,xmin::text FROM role_access_item WHERE item_key IN ('reports','reports.org-engagement') ORDER BY item_key",
      )).rows;
      await seed();
      assert.deepEqual(await catalogue(), beforeCatalogue);
      assert.deepEqual(await protectedData(), beforeProtected);
      assert.deepEqual((await client.query(
        "SELECT id,xmin::text FROM role_access_item WHERE item_key IN ('reports','reports.org-engagement') ORDER BY item_key",
      )).rows, beforeVersions);
    });

    await t.test('repairs the page identity while preserving existing values and unrelated reports', async () => {
      await reset();
      await client.query(`
        INSERT INTO role_access_item
          (id,item_type,item_key,label,icon,parent_id,display_order,is_active,settings)
        VALUES
          ('${uuid(3)}','module','reports','Existing Reports','Chart',NULL,12,true,'{"module":"keep"}'),
          ('${uuid(4)}','page','reports.other','Other Report','Clock','${uuid(3)}',3,true,'{"other":"keep"}'),
          ('${uuid(5)}','page','reports.org-engagement','Wrong','Certificate','${uuid(1)}',22,false,'{"page":"keep"}');
      `);
      const beforeProtected = await protectedData();
      await seed();
      assert.deepEqual((await client.query(
        "SELECT item_type,item_key,label,icon,parent_id,display_order,is_active,settings FROM role_access_item WHERE item_key='reports.org-engagement'",
      )).rows[0], {
        item_type: 'page',
        item_key: 'reports.org-engagement',
        label: 'Organisation Engagement Report',
        icon: 'Certificate',
        parent_id: uuid(3),
        display_order: 22,
        is_active: true,
        settings: { page: 'keep' },
      });
      assert.deepEqual(await protectedData(), beforeProtected);
      assert.deepEqual((await client.query(
        "SELECT label,icon,display_order,settings FROM role_access_item WHERE item_key='reports'",
      )).rows[0], {
        label: 'Existing Reports',
        icon: 'Chart',
        display_order: 12,
        settings: { module: 'keep' },
      });
    });

    await t.test('ambiguous module or page identity rolls back', async () => {
      for (const fixture of [
        `INSERT INTO role_access_item (item_type,item_key,label,parent_id,display_order,is_active)
         VALUES ('module','reports','One',NULL,10,true),('module','reports','Two',NULL,11,true)`,
        `INSERT INTO role_access_item (item_type,item_key,label,parent_id,display_order,is_active)
         VALUES ('module','reports','Reports',NULL,10,true),
                ('page','reports.org-engagement','One',(SELECT id FROM role_access_item WHERE item_key='reports'),0,true),
                ('page','reports.org-engagement','Two',(SELECT id FROM role_access_item WHERE item_key='reports'),1,true)`,
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