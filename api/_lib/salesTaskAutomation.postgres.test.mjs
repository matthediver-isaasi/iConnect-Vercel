import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const uuid = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const id = n => `'${uuid(n)}'`;
const migration = readFileSync('supabase/migrations/202610120002_sales_acceptance_tasks.sql', 'utf8');

test('accepted quote task automation: real PostgreSQL transactions, snapshots, recovery and access boundaries', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sales-task-automation-'));
  const data = join(dir, 'db'), socket = join(dir, 'socket');
  mkdirSync(socket);
  const run = (cmd, args, input) => {
    const r = spawnSync(cmd, args, { input, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr || 'Command failed');
    return r.stdout.trim();
  };
  const args = ['-h', socket, '-p', '55454', '-U', 'postgres', '-d', 'postgres', '-XAtq', '-v', 'ON_ERROR_STOP=1'];
  const sql = q => run('psql', args, q);
  const service = q => sql(`SET ROLE service_role; SET request.jwt.claim.role='service_role'; ${q}`);
  const process = () => service(`SELECT process_sales_acceptance_tasks(${id(1)},${id(3)})`);
  const configure = (list = 6, actor = 9, identity = 8) => service(
    `SELECT configure_sales_task_automation(${id(1)},${id(3)},${list ? id(list) : 'NULL'},${id(identity)},'member',${id(actor)})`);
  const count = (table, condition = 'true') => Number(sql(`SELECT count(*) FROM ${table} WHERE ${condition}`));
  const quote = (n, { flags = [true], bundle = false, mode = 'standard', opportunity = 3 } = {}) => {
    sql(`UPDATE opportunity SET task_mode='${mode}' WHERE id=${id(3)};
      INSERT INTO sales_quote VALUES(${id(n)},${id(1)},${opportunity ? id(opportunity) : 'NULL'});
      INSERT INTO sales_quote_version VALUES(${id(n + 10000)},${id(1)},${id(n)},'draft');`);
    flags.forEach((flag, index) => {
      const snapshot = JSON.stringify({ name: `Product ${n}-${index}`, ...(flag === null ? {} : { create_task_on_acceptance: flag }) });
      sql(`INSERT INTO sales_quote_line VALUES(${id(n + 20000 + index)},${id(1)},${id(n + 10000)},
        '${bundle ? 'bundle' : 'product'}','${bundle ? '{}' : snapshot}',2);`);
      if (bundle) sql(`INSERT INTO sales_quote_bundle_component VALUES(${id(n + 30000 + index)},${id(1)},
        ${id(n + 20000 + index)},'${snapshot}',3);`);
    });
  };
  const accept = n => service(`UPDATE sales_quote_version SET status='issued' WHERE id=${id(n + 10000)};
    UPDATE sales_quote_version SET status='accepted' WHERE id=${id(n + 10000)};`);
  let started = false;
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-locale']);
    run('pg_ctl', ['-D', data, '-l', join(dir, 'log'), '-o', `-F -k ${socket} -p 55454 -c listen_addresses=''`, '-w', 'start']);
    started = true;
    // Fixture types/nullable defaults checked against DEST metadata. No network DB.
    sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$SELECT current_setting('request.jwt.claim.role',true)$$;
      GRANT USAGE ON SCHEMA auth TO service_role;
      CREATE TABLE sales_catalogue_product(id uuid PRIMARY KEY);
      INSERT INTO sales_catalogue_product VALUES(${id(90)});
      CREATE TABLE opportunity(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,task_mode text NOT NULL,
       created_by_kind varchar(20) NOT NULL,created_by_id uuid NOT NULL,UNIQUE(tenant_id,id));
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,identity_id text);
      CREATE TABLE tenant_user(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,identity_id text);
      CREATE TABLE project_board(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,is_archived boolean DEFAULT false);
      CREATE TABLE project_list(id uuid PRIMARY KEY,board_id uuid NOT NULL REFERENCES project_board(id),
       is_archived boolean DEFAULT false);
      CREATE TABLE project_board_member(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),board_id uuid NOT NULL,
       identity_id uuid NOT NULL,role varchar(20) DEFAULT 'member');
      CREATE TABLE sales_opportunity_project(tenant_id uuid NOT NULL,opportunity_id uuid PRIMARY KEY,board_id uuid NOT NULL);
      CREATE TABLE sales_quote(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,opportunity_id uuid);
      CREATE TABLE sales_quote_version(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,quote_id uuid NOT NULL,
       status varchar(30) NOT NULL, UNIQUE(tenant_id,id));
      CREATE TABLE sales_quote_line(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,quote_version_id uuid NOT NULL,
       catalogue_kind varchar(20),catalogue_snapshot jsonb,quantity numeric(24,6));
      CREATE TABLE sales_quote_bundle_component(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,quote_line_id uuid NOT NULL,
       product_snapshot jsonb,quantity numeric(24,6));
      CREATE TABLE opportunity_task(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,
       opportunity_id uuid NOT NULL,title varchar(240) NOT NULL,description text,created_by_kind varchar(20) NOT NULL
       CHECK(created_by_kind IN ('member','tenant_user')),created_by_id uuid NOT NULL);
      CREATE TABLE project_card(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),board_id uuid NOT NULL REFERENCES project_board(id),
       list_id uuid NOT NULL REFERENCES project_list(id),title text NOT NULL,description text,position integer NOT NULL DEFAULT 0,
       created_by uuid NOT NULL);
      INSERT INTO opportunity VALUES(${id(3)},${id(1)},'standard','member',${id(9)}),
       (${id(4)},${id(2)},'standard','member',${id(19)});
      INSERT INTO member VALUES(${id(9)},${id(1)},${id(8)}),(${id(19)},${id(2)},${id(18)});
      INSERT INTO project_board(id,tenant_id) VALUES(${id(5)},${id(1)}),(${id(15)},${id(2)});
      INSERT INTO project_list(id,board_id) VALUES(${id(6)},${id(5)}),(${id(16)},${id(15)});
      INSERT INTO project_board_member(board_id,identity_id,role) VALUES(${id(5)},${id(8)},'owner');
      INSERT INTO sales_opportunity_project VALUES(${id(1)},${id(3)},${id(5)});
      GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;`);
    sql(migration);
    sql(readFileSync('supabase/migrations/202610120003_sales_acceptance_task_grants.sql', 'utf8'));
    // Use the real immutability guards, not hand-written approximations.
    const quotesMigration = readFileSync('supabase/migrations/20260909_sales_quotes.sql', 'utf8');
    for (const [fn, trigger, table] of [
      ['guard_issued_quote_immutable', 'sales_quote_version_immutable', 'sales_quote_version'],
      ['guard_quote_child_immutable', 'sales_quote_line_immutable', 'sales_quote_line'],
      ['guard_quote_component_immutable', 'sales_quote_component_immutable', 'sales_quote_bundle_component'],
    ]) {
      const definition = quotesMigration.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(\\)[\\s\\S]*?END \\$\\$;`))?.[0];
      assert.ok(definition);
      sql(definition);
      sql(`CREATE TRIGGER ${trigger} BEFORE ${table === 'sales_quote_version' ? 'UPDATE OR DELETE' : 'INSERT OR UPDATE OR DELETE'}
       ON ${table} FOR EACH ROW EXECUTE FUNCTION public.${fn}();`);
    }

    await t.test('legacy products default off; old accepted quotes are not backfilled', () => {
      assert.equal(sql('SELECT create_task_on_acceptance FROM sales_catalogue_product'), 'f');
      quote(100, { flags: [null, false] }); accept(100);
      assert.equal(count('sales_acceptance_task_request'), 0);
      sql(`INSERT INTO sales_quote_version VALUES(${id(777)},${id(1)},${id(100)},'accepted');`);
      assert.equal(count('sales_acceptance_task_request'), 0);
    });
    await t.test('one standard task per opted-in line, independent of live product and linked board', () => {
      quote(200, { flags: [true, false] }); accept(200);
      assert.equal(count('opportunity_task'), 1);
      assert.equal(count('project_card'), 0);
      assert.equal(sql('SELECT quantity FROM sales_acceptance_task_request'), '2.000000');
      assert.match(sql('SELECT description FROM opportunity_task'), /Quantity: 2/);
      assert.throws(() => sql(`UPDATE sales_quote_line SET catalogue_snapshot='{"create_task_on_acceptance":false}'
        WHERE quote_version_id=${id(10200)}`), /Issued quote lines are immutable/);
      service(`UPDATE sales_quote_version SET status='accepted' WHERE id=${id(10200)};`);
      process(); process();
      assert.equal(count('opportunity_task'), 1);
    });
    await t.test('bundle opt-in reads component snapshots and multiplies quantities', () => {
      quote(300, { flags: [true, false], bundle: true }); accept(300);
      assert.equal(count('opportunity_task'), 2);
      assert.equal(sql(`SELECT quantity FROM sales_acceptance_task_request WHERE quote_version_id=${id(10300)}`), '6.000000');
    });
    await t.test('missing destination preserves acceptance and a pending request in captured project mode', () => {
      quote(400, { mode: 'project' }); accept(400);
      assert.equal(sql(`SELECT status FROM sales_quote_version WHERE id=${id(10400)}`), 'accepted');
      assert.equal(sql(`SELECT status FROM sales_acceptance_task_request WHERE quote_version_id=${id(10400)}`), 'pending');
      assert.match(sql(`SELECT last_error FROM sales_acceptance_task_request WHERE quote_version_id=${id(10400)}`), /destination list/);
      sql(`UPDATE opportunity SET task_mode='standard' WHERE id=${id(3)}`);
      configure(); process();
      assert.equal(count('project_card'), 1);
      assert.equal(count('opportunity_task'), 2);
      assert.equal(sql(`SELECT task_mode FROM sales_acceptance_task_request WHERE quote_version_id=${id(10400)}`), 'project');
    });
    await t.test('archive/revoke prevents creation; restoration allows retry without duplicates', () => {
      sql(`UPDATE project_list SET is_archived=true WHERE id=${id(6)}`);
      quote(500, { mode: 'project' }); accept(500);
      assert.equal(count('project_card'), 1);
      sql(`UPDATE project_list SET is_archived=false WHERE id=${id(6)};
        UPDATE project_board_member SET role='viewer' WHERE identity_id=${id(8)}`);
      process(); assert.equal(count('project_card'), 1);
      assert.throws(() => configure(), /owner or administrator/);
      sql(`UPDATE project_board_member SET role='owner' WHERE identity_id=${id(8)}`);
      process(); assert.equal(count('project_card'), 2);
      sql(`DELETE FROM project_card`);
      process(); assert.equal(count('project_card'), 0, 'completed requests must not recreate deliberately deleted cards');
    });
    await t.test('parallel retries create exactly one task', async () => {
      configure(null); quote(600, { mode: 'project' }); accept(600); configure();
      const command = `SET ROLE service_role; SET request.jwt.claim.role='service_role';
        SELECT process_sales_acceptance_tasks(${id(1)},${id(3)});`;
      await Promise.all([0, 1].map(() => promisify(execFile)('psql', [...args, '-c', command])));
      assert.equal(count('project_card'), 1);
    });
    await t.test('one failing insert rolls back locally, other tasks succeed and retry recovers', () => {
      sql(`CREATE FUNCTION fail_test_card() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.title='Product 700-0' THEN RAISE EXCEPTION 'sensitive test details'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER fail_test_card BEFORE INSERT ON project_card FOR EACH ROW EXECUTE FUNCTION fail_test_card();`);
      quote(700, { mode: 'project', flags: [true, true] }); accept(700);
      assert.equal(count('sales_acceptance_task_request', `quote_version_id=${id(10700)} AND status='pending'`), 1);
      assert.equal(count('sales_acceptance_task_request', `quote_version_id=${id(10700)} AND status='completed'`), 1);
      assert.doesNotMatch(sql(`SELECT last_error FROM sales_acceptance_task_request WHERE quote_version_id=${id(10700)}`), /sensitive/);
      sql('DROP TRIGGER fail_test_card ON project_card'); process();
      assert.equal(count('sales_acceptance_task_request', `quote_version_id=${id(10700)} AND status='completed'`), 2);
    });
    await t.test('financial/acceptance transaction rollback also rolls back generated tasks', () => {
      quote(800);
      const before = count('opportunity_task');
      service(`BEGIN; UPDATE sales_quote_version SET status='accepted' WHERE id=${id(10800)}; ROLLBACK;`);
      assert.equal(count('opportunity_task'), before);
      assert.equal(count('sales_acceptance_task_request', `quote_version_id=${id(10800)}`), 0);
    });
    await t.test('tenant, identity, list and SQL execution boundaries fail closed', () => {
      assert.throws(() => configure(16), /available list/);
      assert.throws(() => configure(6, 19, 18), /identity unavailable/);
      assert.throws(() => service(`SELECT process_sales_acceptance_tasks(${id(2)},${id(3)})`), /Opportunity unavailable/);
      for (const role of ['anon', 'authenticated']) {
        assert.throws(() => sql(`SET ROLE ${role}; SELECT process_sales_acceptance_tasks(${id(1)},${id(3)});`), /permission denied/);
        assert.throws(() => sql(`SET ROLE ${role}; SELECT * FROM sales_acceptance_task_request`), /permission denied/);
        assert.throws(() => sql(`SET ROLE ${role}; SELECT configure_sales_task_automation(${id(1)},${id(3)},NULL,NULL,'member',${id(9)})`), /permission denied/);
      }
      assert.throws(() => service('DELETE FROM sales_acceptance_task_request'), /permission denied/);
      assert.throws(() => sql(`SELECT process_sales_acceptance_tasks(${id(1)},${id(3)})`), /service role required/);
    });
    await t.test('automatic tasks require an opportunity before issue, not a silent dropped request', () => {
      quote(900, { opportunity: null });
      assert.throws(() => accept(900), /Link an opportunity before issuing/);
      assert.equal(sql(`SELECT status FROM sales_quote_version WHERE id=${id(10900)}`), 'draft');
    });
    await t.test('linking a different board cannot silently redirect pending accepted work', () => {
      configure(null); quote(1000, { mode: 'project' }); accept(1000);
      sql(`INSERT INTO project_board(id,tenant_id) VALUES(${id(25)},${id(1)});
        INSERT INTO project_list(id,board_id) VALUES(${id(26)},${id(25)});
        INSERT INTO project_board_member(board_id,identity_id,role) VALUES(${id(25)},${id(8)},'admin');
        UPDATE sales_opportunity_project SET board_id=${id(25)} WHERE opportunity_id=${id(3)};`);
      configure(26); process();
      assert.equal(count('project_card', `board_id=${id(25)}`), 0);
      assert.match(sql(`SELECT last_error FROM sales_acceptance_task_request WHERE quote_version_id=${id(11000)}`), /different board/);
      sql(`UPDATE sales_opportunity_project SET board_id=${id(5)} WHERE opportunity_id=${id(3)}`);
      configure(); process();
      assert.equal(sql(`SELECT status FROM sales_acceptance_task_request WHERE quote_version_id=${id(11000)}`), 'completed');
    });
    await t.test('automatic named lists, both acceptance routes, retries, settings and concurrency', async () => {
      sql(`CREATE TABLE sales_settings(tenant_id uuid PRIMARY KEY,quote_prefix text DEFAULT 'Q',
       quote_number_padding integer DEFAULT 6,default_currency text DEFAULT 'GBP',default_tax_rate_bps integer DEFAULT 0,
       default_terms text DEFAULT '',module_enabled boolean DEFAULT true,version integer DEFAULT 1,updated_by text,updated_at timestamptz);
       CREATE TABLE sales_audit_event(tenant_id uuid,actor_id text,actor_type text,action text,entity_type text,entity_id text,before_data jsonb,after_data jsonb);
       ALTER TABLE project_list ALTER COLUMN id SET DEFAULT gen_random_uuid();
       ALTER TABLE project_list ADD COLUMN name text DEFAULT 'Existing', ADD COLUMN position integer DEFAULT 0;`);
      sql(readFileSync('supabase/migrations/202610120004_sales_automatic_quote_task_lists.sql', 'utf8'));
      const before = count('project_card');
      configure(null);
      quote(1200, { mode: 'project', flags: [true, false] }); accept(1200);
      assert.equal(count('project_card'), before + 1);
      assert.equal(count('project_list', `board_id=${id(5)} AND name='Quote tasks'`), 1);
      quote(1300, { mode: 'project', flags: [true], bundle: true }); accept(1300);
      assert.equal(count('project_card'), before + 2);
      assert.equal(count('project_list', `board_id=${id(5)} AND name='Quote tasks'`), 1);
      process(); process();
      assert.equal(count('project_card'), before + 2);
      service(`SELECT patch_sales_settings(${id(1)},1,'{"quoteTaskListName":"Delivery work"}','staff','tenant_user')`);
      assert.throws(() => service(`SELECT patch_sales_settings(${id(1)},1,'{"quoteTaskListName":"Stale"}','staff','tenant_user')`), /version conflict/);
      assert.throws(() => service(`SELECT patch_sales_settings(${id(1)},2,'{"quoteTaskListName":"  "}','staff','tenant_user')`), /1-100/);
      sql(`UPDATE project_board SET is_archived=true WHERE id=${id(5)}`);
      quote(1400, { mode: 'project' }); accept(1400);
      assert.equal(count('sales_acceptance_task_request', `quote_version_id=${id(11400)} AND status='pending'`), 1);
      sql(`UPDATE project_board SET is_archived=false WHERE id=${id(5)}`);
      const command = `SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT process_sales_acceptance_tasks(${id(1)},${id(3)});`;
      await Promise.all([0, 1].map(() => promisify(execFile)('psql', [...args, '-c', command])));
      assert.equal(count('project_card'), before + 3);
      assert.equal(count('project_list', `name='Delivery work'`), 1);
      assert.equal(count('project_card', `list_id IN (SELECT id FROM project_list WHERE name='Quote tasks')`), 2);
      sql(`UPDATE project_list SET is_archived=true WHERE name='Delivery work'`);
      quote(1500, { mode: 'project' }); accept(1500);
      assert.equal(count('project_list', `name='Delivery work' AND is_archived IS NOT TRUE`), 1);
      const standardBefore = count('opportunity_task');
      quote(1600); accept(1600);
      assert.equal(count('opportunity_task'), standardBefore + 1);
      quote(1700, { mode: 'project', flags: [null] }); accept(1700);
      assert.equal(count('sales_acceptance_task_request', `quote_version_id=${id(11700)}`), 0);
      assert.throws(() => sql(`SET ROLE authenticated; SELECT sales_quote_task_destination(${id(1)},${id(3)},NULL)`), /permission denied/);
      assert.throws(() => service(`SELECT sales_quote_task_destination(${id(2)},${id(3)},NULL)`), /unavailable/);
      assert.throws(() => service(`SELECT sales_quote_task_destination(${id(1)},${id(3)},${id(25)})`), /changed/);
    });
  } finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    rmSync(dir, { recursive: true, force: true });
  }
});
