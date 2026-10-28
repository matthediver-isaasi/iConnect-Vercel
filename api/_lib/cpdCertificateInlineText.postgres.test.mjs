import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { CPD_TEXT_EXAMPLE } from '../../shared/cpdCertificateDisplay.js';
import { serializeCertificatePlaceholder } from '../../client/src/lib/cpdCertificateContract.js';
import { validPlaceholders } from './cpdCertificateTemplatesApi.js';

test('authored-text migration preserves atomic saves, reloads, copies, legacy fields and grants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inline-cpd-'));
  const socket = join(root, 'socket'); await mkdir(socket);
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr);
  };
  const db = new pg.Client({ host: socket, port: 55449, user: 'postgres', database: 'postgres' });
  let started = false;
  try {
    run('initdb', ['-D', join(root, 'data'), '-U', 'postgres', '-A', 'trust', '--no-locale']);
    run('pg_ctl', ['-D', join(root, 'data'), '-l', join(root, 'log'), '-o', `-k ${socket} -p 55449 -h ''`, '-w', 'start']);
    started = true; await db.connect();
    await db.query('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE TABLE tenant(id uuid PRIMARY KEY); CREATE TABLE role(excluded_features text[]);');
    await db.query(await readFile('supabase/migrations/20260906_cpd_certificate_templates.sql', 'utf8'));
    const migration = await readFile('supabase/migrations/20261027_cpd_certificate_authored_text.sql', 'utf8');
    const originalFunction = (await db.query("SELECT pg_get_functiondef('save_cpd_certificate_template(uuid,uuid,integer,text,text,jsonb,text)'::regprocedure) AS def")).rows[0].def;
    const checked = await readFile('supabase/migrations/20261028_cpd_certificate_checked_save.sql', 'utf8');
    await db.query(checked);
    await db.query(migration); await db.query(migration);
    const tenant = '11111111-1111-4111-8111-111111111111';
    await db.query('INSERT INTO tenant VALUES($1)', [tenant]);
    const create = async name => (await db.query('INSERT INTO cpd_certificate_template(tenant_id,name) VALUES($1,$2) RETURNING id', [tenant, name])).rows[0].id;
    const id = await create('Original'), copy = await create('Copy');
    const fields = validPlaceholders([serializeCertificatePlaceholder({
      key: 'text.credits', text_template: CPD_TEXT_EXAMPLE, page: 1, x: 20, y: 20, width: 500, height: 100,
      font_family: 'Helvetica', font_size: 18, required: true, multiline: true,
    })]);
    const save = (target, version, rows) => db.query('SELECT save_cpd_certificate_template_checked($1,$2,$3,$4,NULL,$5,$6)',
      [target, tenant, version, target === id ? 'Original' : 'Copy', JSON.stringify(rows), 'fixture']);
    await save(id, 1, fields);
    const loaded = (await db.query('SELECT * FROM cpd_certificate_placeholder WHERE template_id=$1', [id])).rows;
    assert.equal(loaded[0].text_template, CPD_TEXT_EXAMPLE);
    // A stale inner RPC must roll back the deletion AND version claim.
    const patchedFunction = (await db.query("SELECT pg_get_functiondef('save_cpd_certificate_template(uuid,uuid,integer,text,text,jsonb,text)'::regprocedure) AS def")).rows[0].def;
    await db.query(originalFunction);
    await assert.rejects(save(id, 2, [{ ...fields[0], text_template: 'Edited sentence' }]), /cpd_text_schema_incompatible/);
    assert.equal((await db.query('SELECT version FROM cpd_certificate_template WHERE id=$1', [id])).rows[0].version, 2);
    assert.equal((await db.query('SELECT text_template FROM cpd_certificate_placeholder WHERE template_id=$1', [id])).rows[0].text_template, CPD_TEXT_EXAMPLE);
    await db.query('ALTER TABLE cpd_certificate_placeholder RENAME COLUMN text_template TO retained_text');
    await assert.rejects(save(id, 2, fields), /cpd_text_schema_incompatible/);
    await db.query('ALTER TABLE cpd_certificate_placeholder RENAME COLUMN retained_text TO text_template');
    await db.query(patchedFunction);
    await save(copy, 1, validPlaceholders(loaded));
    assert.equal((await db.query('SELECT text_template FROM cpd_certificate_placeholder WHERE template_id=$1', [copy])).rows[0].text_template, CPD_TEXT_EXAMPLE);
    await assert.rejects(save(id, 1, []), { code: '40001' });
    assert.equal((await db.query('SELECT count(*) FROM cpd_certificate_placeholder WHERE template_id=$1', [id])).rows[0].count, '1');
    await save(id, 2, [{ ...fields[0], text_template: null, placeholder_key: 'cpd.cpd_points' }]);
    assert.equal((await db.query('SELECT text_template FROM cpd_certificate_placeholder WHERE template_id=$1', [id])).rows[0].text_template, null);
    assert.equal((await db.query("SELECT has_function_privilege('authenticated','save_cpd_certificate_template(uuid,uuid,integer,text,text,jsonb,text)','EXECUTE') AS allowed")).rows[0].allowed, false);
    assert.equal((await db.query("SELECT has_function_privilege('authenticated','save_cpd_certificate_template_checked(uuid,uuid,integer,text,text,jsonb,text)','EXECUTE') AS allowed")).rows[0].allowed, false);
    await save(copy, 2, [{ ...fields[0], text_template: `Updated: ${CPD_TEXT_EXAMPLE}` }]);
    assert.equal((await db.query('SELECT text_template FROM cpd_certificate_placeholder WHERE template_id=$1', [copy])).rows[0].text_template, `Updated: ${CPD_TEXT_EXAMPLE}`);
  } finally {
    await db.end().catch(() => {});
    if (started) run('pg_ctl', ['-D', join(root, 'data'), '-m', 'immediate', '-w', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});
