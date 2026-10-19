// Always creates a private Unix-socket PostgreSQL cluster. No URLs, credentials,
// HTTP/provider calls, live database writes, or deploy tooling are accepted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createLocalPostgresHarness } from './test-support/local-postgres-harness.mjs';
import { IEDIT_COMPONENT_POLICIES } from '../api/_lib/memberContentIEditExtraction.js';

const baseline = readFileSync('supabase/migrations/202612310007_iedit_member_content.sql', 'utf8');
const migration = readFileSync('supabase/migrations/202612310010_iedit_invalidation_precision.sql', 'utf8');
const lifecycle = readFileSync('supabase/migrations/20261031_member_content_generation_lifecycle.sql', 'utf8');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const a = id(1), b = id(2);

test('SQL renderer inventory matches the audited extractor (new renderers require review)', () => {
  const inventory = migration.match(/known_types constant text\[\] := ARRAY\[([\s\S]*?)\];/);
  assert.ok(inventory);
  const sqlTypes = [...inventory[1].matchAll(/'([^']+)'/g)].map(match => match[1]).sort();
  assert.deepEqual(sqlTypes, Object.keys(IEDIT_COMPONENT_POLICIES).sort());
  assert.doesNotMatch(migration, /CREATE TABLE|DROP TRIGGER|GRANT .*authenticated/i);
});

test('007 -> 010: real PostgreSQL invalidation, eligibility, identity moves, drift guard and rollback', { timeout: 60000 }, async t => {
  const h = await createLocalPostgresHarness('iedit-precision-');
  let started = false;
  const run = (cmd, args, input) => {
    const result = spawnSync(cmd, args, { input, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const sqlArgs = ['-h', h.socket, '-p', String(h.port), '-U', 'postgres',
    '-d', 'postgres', '-XqAt', '-v', 'ON_ERROR_STOP=1'];
  const sql = text => run('psql', sqlArgs, text);
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres', '--no-locale', '--encoding=UTF8']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'),
      '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    const invalidator = lifecycle.slice(lifecycle.indexOf('CREATE OR REPLACE FUNCTION invalidate_member_content_source('),
      lifecycle.indexOf('CREATE OR REPLACE FUNCTION member_content_source_change_trigger()'))
      .replace("'blog_post', 'canvas_page'", "'blog_post', 'canvas_page', 'iedit_page'");
    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE member_content_source (
        tenant_id uuid,content_type text,source_id uuid,generation bigint,active_generation bigint,
        claim_token uuid,claim_started_at timestamp,PRIMARY KEY(tenant_id,content_type,source_id));
      CREATE TABLE member_content_reindex_job (
        tenant_id uuid,content_type text,source_id uuid,attempts int,available_at timestamp,
        last_error text,updated_at timestamp,PRIMARY KEY(tenant_id,content_type,source_id));
      CREATE TABLE i_edit_page(id uuid PRIMARY KEY,tenant_id uuid,builder_type text,
        status text,title text,layout_type text,microsite_id uuid,updated_at timestamp);
      CREATE TABLE i_edit_page_element(id uuid PRIMARY KEY,page_id uuid,tenant_id uuid,
        element_type text,content jsonb,settings jsonb,display_order int,updated_at timestamp);
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,first_name text,last_name text,
        last_login timestamp,updated_at timestamp,email text,role_id uuid,future_policy jsonb);
      CREATE TABLE organization(id uuid PRIMARY KEY,tenant_id uuid,name text,logo_url text,updated_at timestamp);
      CREATE TABLE organization_preference_value(id uuid PRIMARY KEY,organization_id uuid,field_id uuid,value jsonb,updated_at timestamp);
      CREATE TABLE member_resource_category(id uuid PRIMARY KEY,member_id uuid,category_id uuid,updated_at timestamp);
      CREATE TABLE wall_of_fame_person(id uuid PRIMARY KEY,tenant_id uuid,first_name text,
        is_active boolean,category_id uuid,biography text,updated_at timestamp,future_policy jsonb);
      CREATE TABLE wall_of_fame_section(id uuid PRIMARY KEY,tenant_id uuid,name text,is_active boolean,updated_at timestamp);
      CREATE TABLE wall_of_fame_category(id uuid PRIMARY KEY,tenant_id uuid,name text,description text,
        section_id uuid,is_active boolean,display_order int,updated_at timestamp);
      CREATE TABLE guest_writer(id uuid PRIMARY KEY,tenant_id uuid,full_name text,updated_at timestamp);
      CREATE TABLE card_deck(id uuid PRIMARY KEY,tenant_id uuid,title text,status text,updated_at timestamp);
      CREATE TABLE system_settings(id uuid PRIMARY KEY,tenant_id uuid,setting_key text,setting_value jsonb,updated_at timestamp);
      CREATE TABLE tenant(id uuid PRIMARY KEY,updated_at timestamp,future_policy jsonb);
      CREATE TABLE member_ai_settings(id int PRIMARY KEY,allowed_content_types text[]);
      ${invalidator}
      ${baseline.slice(baseline.indexOf('CREATE OR REPLACE FUNCTION public.iedit_member_content_change()'),
        baseline.indexOf("NOTIFY pgrst"))}
    `);
    const fingerprint = () => sql("SELECT md5(pg_get_functiondef('public.iedit_member_content_change()'::regprocedure))");
    assert.equal(fingerprint(), 'f544251efd883ab9113865f80cf8b685');
    const triggerContract = () => sql(`SELECT string_agg(pg_get_triggerdef(oid),E'\\n' ORDER BY tgrelid::text)
      FROM pg_trigger WHERE tgname='iedit_member_content_change'`);
    const contract = triggerContract();
    // Migration failure is atomic and unknown baseline drift cannot be patched.
    const originalDef = sql("SELECT pg_get_functiondef('public.iedit_member_content_change()'::regprocedure)");
    sql(originalDef.replace('DECLARE', 'DECLARE\n  -- fixture drift'));
    const rejected = spawnSync('psql', sqlArgs, { input: migration, encoding: 'utf8' });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Exact iEdit invalidation function guard failed/);
    sql(originalDef);
    sql(migration);
    assert.equal(fingerprint(), 'dc3a6c04d4fb55992708ac0e1ab7a2c8');
    sql(migration); // exact reapplication is idempotent
    assert.equal(triggerContract(), contract);
    assert.equal(sql(`SELECT bool_or(has_function_privilege(r,'public.iedit_member_content_change()','EXECUTE'))
      FROM unnest(ARRAY['anon','authenticated','service_role']) roles(r)`), 'f');

    // Two tenants, six renderers each: no saved provenance is used for discovery.
    const renderers = ['text_block', 'showcase', 'wall_of_fame', 'organisation_directory', 'card_deck', 'future_renderer'];
    const pages = [];
    for (const [tenant, base] of [[a, 100], [b, 200]]) {
      for (const [i, type] of renderers.entries()) {
        const page = id(base + i);
        pages.push(page);
        sql(`INSERT INTO i_edit_page(id,tenant_id,builder_type,status,title,layout_type)
          VALUES('${page}','${tenant}','iedit','published','fixture','public');
          INSERT INTO i_edit_page_element(id,page_id,tenant_id,element_type)
          VALUES('${id(base + i + 1000)}','${page}','${tenant}','${type}')`);
      }
    }
    sql(`INSERT INTO member(id,tenant_id,first_name) VALUES('${id(10)}','${a}','Before');
      INSERT INTO member(id,tenant_id,first_name) VALUES('${id(11)}','${b}','Other');
      INSERT INTO organization(id,tenant_id,name) VALUES('${id(12)}','${a}','Org'),('${id(13)}','${b}','Other');
      INSERT INTO wall_of_fame_person(id,tenant_id,first_name,is_active) VALUES('${id(14)}','${a}','Not yet listed',false);
      INSERT INTO card_deck(id,tenant_id,title,status) VALUES('${id(15)}','${a}','Card','inactive');
      INSERT INTO wall_of_fame_section(id,tenant_id,name,is_active) VALUES('${id(24)}','${a}','Board',false);
      INSERT INTO wall_of_fame_category(id,tenant_id,name,section_id) VALUES('${id(25)}','${a}','Trustees','${id(24)}');
      INSERT INTO guest_writer(id,tenant_id,full_name) VALUES('${id(26)}','${a}','Published author');
      INSERT INTO system_settings(id,tenant_id,setting_key,setting_value)
        VALUES('${id(16)}','${a}','article_display_name','"Articles"');
    `);
    const state = () => JSON.parse(sql(`SELECT jsonb_object_agg(source_id,generation)
      FROM member_content_source WHERE content_type='iedit_page'`));
    // Re-arm a fixture searchable generation and claim before every mutation.
    const check = (statement, affected, label) => {
      sql(`UPDATE member_content_source SET active_generation=generation,claim_token='${id(999)}',claim_started_at=now()`);
      const before = state();
      sql(statement);
      const after = state();
      for (const page of pages) {
        assert.equal(after[page] - before[page], affected.includes(page) ? 1 : 0, `${label}: ${page}`);
        assert.equal(sql(`SELECT active_generation IS NULL AND claim_token IS NULL FROM member_content_source
          WHERE source_id='${page}' AND content_type='iedit_page'`), affected.includes(page) ? 't' : 'f', `${label}: claim fence`);
      }
      t.diagnostic(label);
    };
    const allA = pages.slice(0, 6), allB = pages.slice(6);
    const scopeA = (...types) => allA.filter((_, i) => types.includes(renderers[i]) || renderers[i] === 'future_renderer');
    check(`UPDATE member SET last_login=now(),updated_at=now() WHERE id='${id(10)}'`, [], 'member login/timestamp preserves active generation and claim');
    check(`UPDATE member SET first_name=first_name WHERE id='${id(10)}'`, [], 'no-op preserves active generation');
    check(`UPDATE member SET first_name='New',updated_at=now() WHERE id='${id(10)}'`, scopeA('showcase'), 'byline scopes to showcase plus unknown renderer');
    check(`UPDATE guest_writer SET full_name='Renamed' WHERE id='${id(26)}'`, scopeA('showcase'), 'guest byline name');
    check(`UPDATE member SET email='changed@example.invalid' WHERE id='${id(10)}'`, allA, 'member access identity stays broad');
    check(`UPDATE member SET role_id='${id(900)}' WHERE id='${id(10)}'`, allA, 'member role stays broad');
    check(`UPDATE member SET future_policy='{}',last_login=now() WHERE id='${id(10)}'`, allA, 'unknown field plus ignored field stays broad');
    check(`UPDATE wall_of_fame_person SET is_active=true WHERE id='${id(14)}'`, scopeA('wall_of_fame'), 'newly eligible person scopes by renderer not saved IDs');
    check(`UPDATE wall_of_fame_person SET category_id='${id(801)}',is_active=false WHERE id='${id(14)}'`, scopeA('wall_of_fame'), 'category move and removal retains fencing');
    check(`UPDATE wall_of_fame_section SET is_active=true WHERE id='${id(24)}'`, scopeA('wall_of_fame'), 'newly eligible section');
    check(`UPDATE wall_of_fame_category SET section_id='${id(802)}',display_order=1 WHERE id='${id(25)}'`, scopeA('wall_of_fame'), 'category parent move and order');
    check(`UPDATE wall_of_fame_person SET future_policy='{}' WHERE id='${id(14)}'`, allA, 'unknown dependency field remains broad');
    check(`UPDATE card_deck SET status='active' WHERE id='${id(15)}'`, scopeA('card_deck'), 'newly eligible selected card');
    check(`UPDATE organization SET name='Renamed',logo_url='fixture' WHERE id='${id(12)}'`, scopeA('organisation_directory'), 'directory name/order and logo eligibility');
    check(`UPDATE system_settings SET setting_value='"Posts"' WHERE id='${id(16)}'`, scopeA('showcase', 'organisation_directory'), 'known setting scopes conservatively');
    check(`UPDATE system_settings SET setting_key='org_directory_show_title' WHERE id='${id(16)}'`, scopeA('showcase', 'organisation_directory'), 'known setting key move includes both renderer families');
    check(`UPDATE system_settings SET setting_key='unknown_policy' WHERE id='${id(16)}'`, allA, 'known-to-unknown setting key move stays broad');
    check(`UPDATE system_settings SET setting_key='article_display_name' WHERE id='${id(16)}'`, allA, 'unknown-to-known setting key move stays broad');
    check(`UPDATE member SET tenant_id='${b}',first_name='Moved' WHERE id='${id(10)}'`, pages, 'old and new tenant identity preserved');
    check(`UPDATE member SET id='${id(19)}' WHERE id='${id(10)}'`, allB, 'record ID change stays broad');
    check(`DELETE FROM member WHERE id='${id(19)}'`, allB, 'delete remains broad');
    check(`INSERT INTO member(id,tenant_id) VALUES('${id(19)}','${a}')`, allA, 'insert remains broad');
    check(`INSERT INTO organization_preference_value VALUES('${id(20)}','${id(12)}','${id(21)}','[]',NULL)`, allA, 'parent-scoped insert');
    check(`UPDATE organization_preference_value SET organization_id='${id(13)}'`, pages, 'both old and new authoritative parent tenants');
    check(`DELETE FROM organization_preference_value`, allB, 'parent-scoped delete before parent removal');
    check(`INSERT INTO member_resource_category VALUES('${id(22)}','${id(19)}','${id(23)}',NULL)`, allA, 'member resource eligibility insert');
    check(`UPDATE member_resource_category SET member_id='${id(11)}'`, pages, 'member resource parent move');
    check(`DELETE FROM member_resource_category`, allB, 'member resource eligibility delete');
    check(`UPDATE i_edit_page SET updated_at=now() WHERE id='${id(100)}'`, [], 'page timestamp only');
    check(`UPDATE i_edit_page SET layout_type='member' WHERE id='${id(100)}'`, [id(100)], 'page access change');
    check(`UPDATE i_edit_page_element SET content='{"text":"new"}' WHERE page_id='${id(100)}'`, [id(100)], 'authored element content');
    check(`UPDATE i_edit_page_element SET page_id='${id(200)}' WHERE page_id='${id(100)}'`, [id(100), id(200)], 'element move fences old and new pages');
    check(`UPDATE i_edit_page SET builder_type='canvas' WHERE id='${id(100)}'`, [id(100)], 'builder move fences old iEdit and new Canvas');
    assert.equal(sql(`SELECT count(*) FROM member_content_source WHERE source_id='${id(100)}' AND content_type='canvas_page'`), '1');
    // Rollback restores both generation and queue effects.
    const beforeRollback = state();
    sql(`BEGIN; UPDATE member SET role_id='${id(901)}' WHERE id='${id(19)}'; ROLLBACK;`);
    assert.deepEqual(state(), beforeRollback);
    assert.equal(sql(`SELECT count(*) FROM member_content_reindex_job WHERE content_type='iedit_page'`), '12');
    // Exercise the generation+claim CAS predicate against a genuinely stale
    // claim after this trigger invalidates it. This is not a publisher mock.
    const generation = sql(`SELECT generation FROM member_content_source WHERE source_id='${id(101)}'`);
    sql(`UPDATE member_content_source SET claim_token='${id(999)}' WHERE source_id='${id(101)}';
      UPDATE member SET first_name='Changed after claim' WHERE id='${id(19)}'`);
    assert.equal(sql(`WITH stale AS (
      UPDATE member_content_source SET active_generation=generation
      WHERE source_id='${id(101)}' AND generation=${generation} AND claim_token='${id(999)}' RETURNING 1
    ) SELECT count(*) FROM stale`), '0');
  } finally {
    if (started) run('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});
