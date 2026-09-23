import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import {
  MIGRATION, runMigration,
} from '../../scripts/apply-outlook-health-columns-repair-migration.mjs';

const sql = await readFile(new URL(`./${MIGRATION}`, import.meta.url), 'utf8');

async function fixture(t, healthColumns = '') {
  const root = await mkdtemp(join(tmpdir(), 'outlook-health-repair-'));
  const data = join(root, 'data');
  const port = 47000 + Math.floor(Math.random() * 1000);
  execFileSync('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres'], { stdio: 'ignore' });
  execFileSync('pg_ctl', ['-D', data, '-o', `-F -p ${port} -k ${root}`, '-w', 'start'], { stdio: 'ignore' });
  const client = new pg.Client({ host: root, port, database: 'postgres', user: 'postgres' });
  await client.connect();
  t.after(async () => {
    await client.end().catch(() => {});
    try { execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', 'stop'], { stdio: 'ignore' }); } catch {}
    await rm(root, { recursive: true, force: true });
  });
  await client.query(`
    CREATE TABLE outlook_connection(
      id integer PRIMARY KEY,
      access_token text NOT NULL,
      refresh_token text NOT NULL,
      scopes text,
      sync_enabled boolean NOT NULL DEFAULT true
      ${healthColumns}
    )
  `);
  return client;
}

test('repairs missing columns, reproduces intended backfill and preserves connections and tokens', async (t) => {
  const client = await fixture(t);
  await client.query(`
    INSERT INTO outlook_connection(id,access_token,refresh_token,scopes) VALUES
      (1,'access-one','refresh-one','Mail.Read OnlineMeetings.ReadWrite OnlineMeetingArtifact.Read.All'),
      (2,'access-two','refresh-two','Mail.Read')
  `);
  const before = (await client.query(
    'SELECT id,access_token,refresh_token,scopes,sync_enabled FROM outlook_connection ORDER BY id',
  )).rows;
  await runMigration(client, sql);
  const rows = (await client.query(`
    SELECT id,access_token,refresh_token,scopes,sync_enabled,
      health_state,health_error,health_checked_at
    FROM outlook_connection ORDER BY id
  `)).rows;
  assert.deepEqual(rows.map(({ health_state: _state, health_error: _error, health_checked_at: _at, ...row }) => row), before);
  assert.deepEqual(rows.map(row => row.health_state), ['healthy', 'admin_consent_required']);
  assert.ok(rows.every(row => row.health_error === null && row.health_checked_at instanceof Date));

  await client.query(`
    UPDATE outlook_connection
    SET health_state='error', health_error='existing metadata',
        health_checked_at='2024-01-02T03:04:05Z'
    WHERE id=1
  `);
  const preserved = (await client.query('SELECT * FROM outlook_connection ORDER BY id')).rows;
  await runMigration(client, sql);
  assert.deepEqual((await client.query('SELECT * FROM outlook_connection ORDER BY id')).rows, preserved);
  assert.equal((await client.query(`
    SELECT count(*)::int AS count FROM pg_constraint
    WHERE conrelid='outlook_connection'::regclass
      AND conname='outlook_connection_health_state_check'
  `)).rows[0].count, 1);
});

test('does not overwrite pre-existing health metadata on a partially migrated table', async (t) => {
  const client = await fixture(t, `,
      health_state varchar NOT NULL DEFAULT 'reconnect_required',
      health_error text,
      health_checked_at timestamptz`);
  await client.query(`
    INSERT INTO outlook_connection VALUES
      (1,'access','refresh',
       'OnlineMeetings.ReadWrite OnlineMeetingArtifact.Read.All',true,
       'reconnect_required','deliberately retained',NULL)
  `);
  await runMigration(client, sql);
  const row = (await client.query(`
    SELECT access_token,refresh_token,health_state,health_error,health_checked_at
    FROM outlook_connection
  `)).rows[0];
  assert.deepEqual(row, {
    access_token: 'access',
    refresh_token: 'refresh',
    health_state: 'reconnect_required',
    health_error: 'deliberately retained',
    health_checked_at: null,
  });
});