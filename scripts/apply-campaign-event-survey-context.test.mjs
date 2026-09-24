import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from './test-support/local-postgres-harness.mjs';
import { applyMigration, validateMigration } from './apply-campaign-event-survey-context.mjs';

const sql = await readFile(new URL('../migrations/20260901_campaign_event_survey_context.sql', import.meta.url), 'utf8');
test('migration accepts only the two reviewed additive columns', () => {
  assert.doesNotThrow(() => validateMigration(sql));
  assert.throws(() => validateMigration(`${sql}\nDELETE FROM email_campaign;`));
  assert.throws(() => validateMigration(sql.replace('jsonb', 'text')));
});

test('real isolated PostgreSQL: nullable types, preexisting values/xmins unchanged, replay idempotent', async () => {
  const harness = await createLocalPostgresHarness('campaign-survey-schema-');
  let started = false;
  let client;
  try {
    execFileSync('initdb', ['-D', harness.data, '-A', 'trust', '-U', 'runner', '--no-locale'], { stdio: 'pipe' });
    execFileSync('pg_ctl', ['-D', harness.data, '-l', path.join(harness.root, 'postgres.log'),
      '-o', `-k ${harness.socket} -p ${harness.port} -h ''`, '-w', 'start'], { stdio: 'pipe' });
    started = true;
    client = new pg.Client({ host: harness.socket, port: harness.port, user: 'runner', database: 'postgres' });
    await client.connect();
    await client.query(`
      CREATE TABLE email_campaign (id int primary key, subject text);
      CREATE TABLE event_email (id int primary key, body text);
      INSERT INTO email_campaign VALUES (1, '{{event_survey_url}}'), (2, 'unchanged');
      INSERT INTO event_email VALUES (1, '[[event.survey_url]]');
    `);
    for (let pass = 0; pass < 2; pass++) {
      const result = await applyMigration(client, sql);
      assert.deepEqual(result.map(row => row.type), ['jsonb', 'uuid']);
      assert.deepEqual(result.map(row => row.preexistingRowsVerified), [2, 1]);
      assert.ok(result.every(row => row.preexistingRowsUnchanged));
    }
    const values = await client.query('SELECT event_survey_context FROM email_campaign');
    assert.ok(values.rows.every(row => row.event_survey_context === null));
    const assignment = await client.query('SELECT event_survey_assignment_id FROM event_email');
    assert.equal(assignment.rows[0].event_survey_assignment_id, null);
  } finally {
    await client?.end();
    if (started) execFileSync('pg_ctl', ['-D', harness.data, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    await harness.cleanup();
  }
});