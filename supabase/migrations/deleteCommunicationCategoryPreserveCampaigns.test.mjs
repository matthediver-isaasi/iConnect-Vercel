import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { runMigration } from '../../scripts/apply-delete-communication-category-preserve-campaigns-migration.mjs';

const migrationUrl = new URL('./202609200001_delete_communication_category_preserve_campaigns.sql', import.meta.url);

async function withIsolatedPostgres(t, fn, { targetIdsType = 'uuid[]' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'task4600-'));
  const data = join(root, 'data');
  const port = 45460 + Math.floor(Math.random() * 1000);
  execFileSync('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres'], { stdio: 'ignore' });
  execFileSync('pg_ctl', ['-D', data, '-o', `-F -p ${port} -k ${root}`, '-w', 'start'], { stdio: 'ignore' });
  const client = new pg.Client({ host: root, port, database: 'postgres', user: 'postgres' });
  const extraClients = [];
  const openClient = async () => {
    const extra = new pg.Client({ host: root, port, database: 'postgres', user: 'postgres' });
    await extra.connect();
    extraClients.push(extra);
    return extra;
  };
  await client.connect();
  t.after(async () => {
    await Promise.allSettled(extraClients.map((extra) => extra.end()));
    await client.end().catch(() => {});
    try { execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', 'stop'], { stdio: 'ignore' }); } catch {}
    await rm(root, { recursive: true, force: true });
  });
  await client.query(`
    create role anon; create role authenticated; create role service_role;
    create table communication_category(
      id uuid primary key, tenant_id uuid, name text, description text, is_active bool,
      display_order int, created_at timestamptz, updated_at timestamptz,
      zoho_list_id text, is_public bool, member_enabled bool
    );
    create table email_campaign(
      id uuid primary key, tenant_id uuid, name text, status text,
      communication_category_id uuid references communication_category(id),
      target_type text, target_ids ${targetIdsType}, target_audiences jsonb,
      scheduled_at timestamptz, updated_at timestamptz
    );
    create table form(id uuid primary key, tenant_id uuid, communication_category_id uuid references communication_category(id) on delete set null);
    create table audience_list(
      id uuid primary key, tenant_id uuid,
      communication_category_id uuid references communication_category(id),
      target_audiences jsonb not null default '[]', updated_at timestamptz
    );
    create table email_subscriber(id uuid primary key, tenant_id uuid, communication_category_id uuid references communication_category(id) on delete set null);
    create table email_unsubscribe(id uuid primary key, tenant_id uuid, communication_category_id uuid references communication_category(id), unsubscribe_type text);
    create table member_communication_preference(id uuid primary key, tenant_id uuid, category_id uuid references communication_category(id));
    create table communication_category_role(id uuid primary key, tenant_id uuid, category_id uuid references communication_category(id));
    create table member_transactional_message(
      id uuid primary key, tenant_id uuid, communication_category_id uuid,
      updated_at timestamptz
    );
  `);
  await runMigration(client, await readFile(migrationUrl, 'utf8'));
  await fn(client, openClient);
}

const ids = {
  tenant: '10000000-0000-0000-0000-000000000001',
  otherTenant: '10000000-0000-0000-0000-000000000002',
  category: '20000000-0000-0000-0000-000000000001',
  otherCategory: '20000000-0000-0000-0000-000000000002',
  form: '30000000-0000-0000-0000-000000000001',
  list: '40000000-0000-0000-0000-000000000001',
  parentList: '40000000-0000-0000-0000-000000000002',
  directDraft: '50000000-0000-0000-0000-000000000001',
  historical: '50000000-0000-0000-0000-000000000002',
  indirect: '50000000-0000-0000-0000-000000000003',
  active: '50000000-0000-0000-0000-000000000004',
};

async function seed(client, active = false) {
  await client.query(`
    insert into communication_category(id, tenant_id, name) values
      ($1,$2,'News'), ($3,$2,'Other'), ('20000000-0000-0000-0000-000000000003',$4,'Other tenant')
  `, [ids.category, ids.tenant, ids.otherCategory, ids.otherTenant]);
  await client.query('insert into form values ($1,$2,$3)', [ids.form, ids.tenant, ids.category]);
  await client.query(`
    insert into audience_list(id,tenant_id,communication_category_id,target_audiences) values
      ($1,$2,$3,'[]'),
      ($4,$2,null,jsonb_build_array(jsonb_build_object('type','audience_list','ids',jsonb_build_array($1::text))))
  `, [ids.list, ids.tenant, ids.category, ids.parentList]);
  await client.query(`
    insert into email_campaign(id,tenant_id,name,status,communication_category_id,target_type,target_ids,target_audiences) values
      ($1,$2,'Draft','draft',$3,'role',array[$4]::uuid[],'[]'),
      ($5,$2,'History','sent',$3,'role',array[$4]::uuid[],'[]'),
      ($6,$2,'Indirect','draft',null,'audience_list',array[$7]::uuid[],'[]')
  `, [
    ids.directDraft, ids.tenant, ids.category, ids.otherCategory,
    ids.historical, ids.indirect, ids.parentList,
  ]);
  if (active) {
    await client.query(
      `insert into email_campaign(id,tenant_id,name,status,communication_category_id,target_type,target_ids,target_audiences)
       values ($1,$2,'Active','sending',$3,'role',array[$4]::uuid[],'[]')`,
      [ids.active, ids.tenant, ids.category, ids.otherCategory],
    );
  }
  await client.query(
    `insert into email_subscriber values ('60000000-0000-0000-0000-000000000001',$1,$2)`,
    [ids.tenant, ids.category],
  );
  await client.query(`
    insert into email_unsubscribe values
      ('70000000-0000-0000-0000-000000000001',$1,$2,'category'),
      ('70000000-0000-0000-0000-000000000002',$1,null,'all')
  `, [ids.tenant, ids.category]);
  await client.query(
    `insert into member_communication_preference values ('80000000-0000-0000-0000-000000000001',$1,$2)`,
    [ids.tenant, ids.category],
  );
  await client.query(
    `insert into member_transactional_message values ('90000000-0000-0000-0000-000000000001',$1,$2,now(),null)`,
    [ids.tenant, ids.category],
  );
}

test('atomic delete retains campaigns/history, marks direct and indirect targeting, and preserves global consent', async (t) => {
  await withIsolatedPostgres(t, async (client) => {
    await seed(client);
    const result = await client.query(
      'select delete_communication_category_preserving_campaigns($1,$2) result',
      [ids.tenant, ids.category],
    );
    assert.equal(result.rows[0].result.affectedCampaignCount, 3);
    assert.equal(result.rows[0].result.reviewRequiredCampaignCount, 3);

    const campaigns = await client.query(`
      select id,status,communication_category_id,category_review_required,
             deleted_category_id,deleted_category_name
      from email_campaign order by id
    `);
    assert.equal(campaigns.rowCount, 3);
    assert.deepEqual(campaigns.rows.map((row) => row.category_review_required), [true, true, true]);
    assert.equal(campaigns.rows[0].deleted_category_name, 'News');
    assert.equal(campaigns.rows[1].deleted_category_name, 'News');
    assert.equal(campaigns.rows[2].deleted_category_id, ids.category);

    const consent = await client.query(`
      select
        (select count(*)::int from email_subscriber) subscribers,
        (select count(*)::int from email_unsubscribe where unsubscribe_type='category') category_unsubscribes,
        (select count(*)::int from email_unsubscribe where unsubscribe_type='all' and communication_category_id is null) global_unsubscribes,
        (select count(*)::int from member_communication_preference) preferences
    `);
    assert.deepEqual(consent.rows[0], {
      subscribers: 0,
      category_unsubscribes: 0,
      global_unsubscribes: 1,
      preferences: 0,
    });
    const lists = await client.query('select category_review_required from audience_list order by id');
    assert.deepEqual(lists.rows, [{ category_review_required: true }, { category_review_required: true }]);
    const otherTenant = await client.query(
      `select count(*)::int count from communication_category where tenant_id=$1`,
      [ids.otherTenant],
    );
    assert.equal(otherTenant.rows[0].count, 1);
    const inbox = await client.query(`
      select communication_category_id, deleted_category_name
      from member_transactional_message
    `);
    assert.deepEqual(inbox.rows, [{
      communication_category_id: null,
      deleted_category_name: 'News',
    }]);
  });
});

test('active delivery conflict rolls back every category mutation', async (t) => {
  await withIsolatedPostgres(t, async (client) => {
    await seed(client, true);
    await assert.rejects(
      client.query('select delete_communication_category_preserving_campaigns($1,$2)', [ids.tenant, ids.category]),
      (error) => error.code === '55P03',
    );
    const state = await client.query(`
      select
        exists(select 1 from communication_category where id=$1) category_exists,
        count(*) filter(where communication_category_id=$1)::int linked_campaigns,
        (select count(*)::int from member_communication_preference where category_id=$1) preferences
      from email_campaign
    `, [ids.category]);
    assert.deepEqual(state.rows[0], { category_exists: true, linked_campaigns: 3, preferences: 1 });
  });
});

test('sent and cancelled affected campaigns are both marked because pending recipients are resumable', async (t) => {
  await withIsolatedPostgres(t, async (client) => {
    await seed(client);
    const cancelledId = '50000000-0000-0000-0000-000000000006';
    await client.query(`
      insert into email_campaign(
        id,tenant_id,name,status,communication_category_id,target_type,target_ids,target_audiences
      ) values ($1,$2,'Cancelled','cancelled',$3,'role',array[$4]::uuid[],'[]')
    `, [cancelledId, ids.tenant, ids.category, ids.otherCategory]);
    const result = await client.query(
      'select delete_communication_category_preserving_campaigns($1,$2) result',
      [ids.tenant, ids.category],
    );
    assert.equal(result.rows[0].result.reviewRequiredCampaignCount, 4);
    const finalRows = await client.query(`
      select status,category_review_required,deleted_category_name
      from email_campaign where id in ($1,$2) order by status
    `, [ids.historical, cancelledId]);
    assert.deepEqual(finalRows.rows, [
      { status: 'cancelled', category_review_required: true, deleted_category_name: 'News' },
      { status: 'sent', category_review_required: true, deleted_category_name: 'News' },
    ]);
  });
});

test('review marker cannot be bypassed with stale indirect targeting and clears after deliberate valid reconfiguration', async (t) => {
  await withIsolatedPostgres(t, async (client) => {
    await seed(client);
    await client.query('select delete_communication_category_preserving_campaigns($1,$2)', [ids.tenant, ids.category]);
    await assert.rejects(
      client.query('select clear_email_campaign_category_review($1,$2)', [ids.tenant, ids.indirect]),
      (error) => error.code === '23503',
    );
    await client.query(`
      update email_campaign
      set communication_category_id=$3, target_type='role',
          target_ids=array[$3]::uuid[], target_audiences='[]'
      where tenant_id=$1 and id=$2
    `, [ids.tenant, ids.indirect, ids.otherCategory]);
    const cleared = await client.query(
      'select (clear_email_campaign_category_review($1,$2)).category_review_required value',
      [ids.tenant, ids.indirect],
    );
    assert.equal(cleared.rows[0].value, false);
  });
});

test('deleted communication_category JSON segment stays blocked instead of widening', async (t) => {
  await withIsolatedPostgres(t, async (client) => {
    await seed(client);
    const campaignId = '50000000-0000-0000-0000-000000000005';
    await client.query(`
      insert into email_campaign(
        id,tenant_id,name,status,target_type,target_ids,target_audiences
      ) values (
        $1,$2,'JSON category','draft','communication_category',array[$3]::uuid[],
        jsonb_build_array(jsonb_build_object(
          'type','communication_category','ids',jsonb_build_array($3::text)
        ))
      )
    `, [campaignId, ids.tenant, ids.category]);
    await client.query(
      'select delete_communication_category_preserving_campaigns($1,$2)',
      [ids.tenant, ids.category],
    );
    const marked = await client.query(`
      select category_review_required,status from email_campaign where id=$1
    `, [campaignId]);
    assert.deepEqual(marked.rows[0], { category_review_required: true, status: 'draft' });
    await client.query(`
      update email_campaign set communication_category_id=$2 where id=$1
    `, [campaignId, ids.otherCategory]);
    await assert.rejects(
      client.query('select clear_email_campaign_category_review($1,$2)', [ids.tenant, campaignId]),
      (error) => error.code === '23503',
    );
  });
});

test('unknown future FK blocker causes full transactional rollback', async (t) => {
  await withIsolatedPostgres(t, async (client) => {
    await seed(client);
    await client.query(`
      create table unknown_category_reference(
        id uuid primary key,
        category_id uuid not null references communication_category(id)
      )
    `);
    await client.query(
      `insert into unknown_category_reference values
        ('a0000000-0000-0000-0000-000000000001',$1)`,
      [ids.category],
    );
    await assert.rejects(
      client.query('select delete_communication_category_preserving_campaigns($1,$2)', [ids.tenant, ids.category]),
      (error) => error.code === '23503',
    );
    const state = await client.query(`
      select
        exists(select 1 from communication_category where id=$1) category_exists,
        count(*) filter(where communication_category_id=$1)::int linked_campaigns,
        bool_and(category_review_required = false) markers_rolled_back,
        (select count(*)::int from email_subscriber where communication_category_id=$1) subscribers,
        (select communication_category_id=$1 from member_transactional_message limit 1) inbox_rolled_back
      from email_campaign
    `, [ids.category]);
    assert.deepEqual(state.rows[0], {
      category_exists: true,
      linked_campaigns: 2,
      markers_rolled_back: true,
      subscribers: 1,
      inbox_rolled_back: true,
    });
  });
});

test('send claim winning the row lock makes concurrent delete fail without mutation', async (t) => {
  await withIsolatedPostgres(t, async (client, openClient) => {
    await seed(client);
    const sender = await openClient();
    const deleter = await openClient();
    await sender.query('begin');
    await sender.query(`
      update email_campaign set status='preparing'
      where id=$1 and status='draft' and category_review_required=false
    `, [ids.directDraft]);
    const deleting = deleter.query(
      'select delete_communication_category_preserving_campaigns($1,$2)',
      [ids.tenant, ids.category],
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await sender.query('commit');
    await assert.rejects(deleting, (error) => error.code === '55P03');
    const state = await client.query(
      'select category_review_required, communication_category_id from email_campaign where id=$1',
      [ids.directDraft],
    );
    assert.deepEqual(state.rows[0], {
      category_review_required: false,
      communication_category_id: ids.category,
    });
  });
});

test('delete winning the row lock makes concurrent send claim return no row', async (t) => {
  await withIsolatedPostgres(t, async (client, openClient) => {
    await seed(client);
    const deleter = await openClient();
    const sender = await openClient();
    await deleter.query('begin');
    await deleter.query(
      'select delete_communication_category_preserving_campaigns($1,$2)',
      [ids.tenant, ids.category],
    );
    const claiming = sender.query(`
      update email_campaign set status='preparing'
      where id=$1 and tenant_id=$2 and status in ('draft','scheduled')
        and category_review_required=false
      returning id
    `, [ids.directDraft, ids.tenant]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await deleter.query('commit');
    const claim = await claiming;
    assert.equal(claim.rowCount, 0);
    const state = await client.query(
      'select status, category_review_required, communication_category_id from email_campaign where id=$1',
      [ids.directDraft],
    );
    assert.deepEqual(state.rows[0], {
      status: 'draft',
      category_review_required: true,
      communication_category_id: null,
    });
  });
});

test('category RPCs are private to service_role', async (t) => {
  await withIsolatedPostgres(t, async (client) => {
    const grants = await client.query(`
      select
        has_function_privilege('anon', 'delete_communication_category_preserving_campaigns(uuid,uuid)', 'execute') anon_delete,
        has_function_privilege('authenticated', 'delete_communication_category_preserving_campaigns(uuid,uuid)', 'execute') auth_delete,
        has_function_privilege('service_role', 'delete_communication_category_preserving_campaigns(uuid,uuid)', 'execute') service_delete,
        has_function_privilege('anon', 'clear_email_campaign_category_review(uuid,uuid)', 'execute') anon_clear,
        has_function_privilege('authenticated', 'clear_email_campaign_category_review(uuid,uuid)', 'execute') auth_clear,
        has_function_privilege('service_role', 'clear_email_campaign_category_review(uuid,uuid)', 'execute') service_clear
    `);
    assert.deepEqual(grants.rows[0], {
      anon_delete: false,
      auth_delete: false,
      service_delete: true,
      anon_clear: false,
      auth_clear: false,
      service_clear: true,
    });
  });
});

test('both deletion and review-clear RPCs support canonical text[] target_ids', async (t) => {
  await withIsolatedPostgres(t, async (client) => {
    await client.query(`
      insert into communication_category(id,tenant_id,name) values
        ($1,$2,'News'),($3,$2,'Replacement')
    `, [ids.category, ids.tenant, ids.otherCategory]);
    await client.query(`
      insert into email_campaign(
        id,tenant_id,name,status,communication_category_id,target_type,target_ids,target_audiences
      ) values (
        $1,$2,'Text target','sent',$3,'communication_category',
        array[($3::uuid)::text]::text[],
        jsonb_build_array(jsonb_build_object('type','communication_category','ids',jsonb_build_array(($3::uuid)::text)))
      )
    `, [ids.historical, ids.tenant, ids.category]);
    await client.query(
      'select delete_communication_category_preserving_campaigns($1,$2)',
      [ids.tenant, ids.category],
    );
    const marked = await client.query(
      'select status,category_review_required,deleted_category_name from email_campaign where id=$1',
      [ids.historical],
    );
    assert.deepEqual(marked.rows[0], {
      status: 'sent',
      category_review_required: true,
      deleted_category_name: 'News',
    });
    await client.query(`
      update email_campaign set communication_category_id=$2,target_type='role',
        target_ids=array[($2::uuid)::text]::text[],target_audiences='[]'
      where id=$1
    `, [ids.historical, ids.otherCategory]);
    const cleared = await client.query(
      'select (clear_email_campaign_category_review($1,$2)).category_review_required value',
      [ids.tenant, ids.historical],
    );
    assert.equal(cleared.rows[0].value, false);
  }, { targetIdsType: 'text[]' });
});
