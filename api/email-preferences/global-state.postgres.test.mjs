import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';

const databaseUrl = process.env.DEST_DATABASE_URL
  || process.env.DEV_DATABASE_URL
  || process.env.DATABASE_URL;

async function withRollback(t, fn) {
  if (!databaseUrl) {
    t.skip('No destination/development PostgreSQL URL is available');
    return;
  }
  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}

async function setGlobal(client, {
  tenantId,
  email,
  memberId = null,
  optOutAll,
  categoryIds,
}) {
  await client.query(
    'select set_email_preference_global_state($1, $2, $3, $4, $5, $6)',
    [tenantId, email, memberId, optOutAll, null, categoryIds],
  );
}

test('migration canonicalizes legacy email variants before creating the ledger contract', async (t) => {
  await withRollback(t, async (client) => {
    const fixture = await client.query(`
      select tenant_id
      from communication_category
      where is_active = true
      limit 1
    `);
    if (!fixture.rows[0]) {
      t.skip('No tenant fixture exists');
      return;
    }
    const { tenant_id: tenantId } = fixture.rows[0];
    const localPart = `migration-${randomUUID()}`;
    const canonicalEmail = `${localPart}@example.invalid`;

    await client.query(`
      alter table email_unsubscribe
      drop constraint if exists email_unsubscribe_email_canonical_check
    `);
    await client.query(`
      drop trigger if exists email_unsubscribe_canonicalize_email
      on email_unsubscribe
    `);
    await client.query(`
      insert into email_unsubscribe (
        tenant_id, email, unsubscribe_type, communication_category_id, source
      ) values
        ($1, $2, 'all', null, 'user'),
        ($1, $3, 'all', null, 'user')
    `, [tenantId, canonicalEmail.toUpperCase(), ` ${canonicalEmail} `]);

    const migration = await readFile(
      new URL('../../supabase/migrations/20260831_repair_atomic_email_preference_global_state.sql', import.meta.url),
      'utf8',
    );
    await client.query(migration);

    const rows = await client.query(`
      select email
      from email_unsubscribe
      where tenant_id = $1
        and email = $2
        and unsubscribe_type = 'all'
        and communication_category_id is null
    `, [tenantId, canonicalEmail]);
    assert.deepEqual(rows.rows, [{ email: canonicalEmail }]);

    const secondEmail = `trigger-${randomUUID()}@example.invalid`;
    await client.query(`
      insert into email_unsubscribe (
        tenant_id, email, unsubscribe_type, communication_category_id, source
      ) values ($1, $2, 'all', null, 'user')
    `, [tenantId, ` ${secondEmail.toUpperCase()} `]);
    const triggered = await client.query(`
      select email
      from email_unsubscribe
      where tenant_id = $1
        and email = $2
        and unsubscribe_type = 'all'
        and communication_category_id is null
    `, [tenantId, secondEmail]);
    assert.deepEqual(triggered.rows, [{ email: secondEmail }]);
  });
});

test('atomic global preference contract is idempotent for member and external recipients', async (t) => {
  await withRollback(t, async (client) => {
    const contract = await client.query(`
      select
        to_regprocedure(
          'public.set_email_preference_global_state(uuid,text,uuid,boolean,uuid,uuid[])'
        ) is not null as global_rpc,
        to_regprocedure(
          'public.set_email_preference_category_state(uuid,text,uuid,uuid,boolean,uuid)'
        ) is not null as category_rpc,
        (
          select indisvalid and indnullsnotdistinct
          from pg_index
          where indexrelid = 'public.idx_email_unsubscribe_unique'::regclass
        ) as null_safe_unique
    `);
    assert.deepEqual(contract.rows[0], {
      global_rpc: true,
      category_rpc: true,
      null_safe_unique: true,
    });

    const fixture = await client.query(`
      select
        member.id as member_id,
        member.tenant_id,
        member.email,
        category.id as category_id
      from member
      join communication_category category
        on category.tenant_id = member.tenant_id
       and category.is_active = true
      where member.email is not null
        and trim(member.email) <> ''
      limit 1
    `);
    if (!fixture.rows[0]) {
      t.skip('No member and active communication category fixture exists');
      return;
    }
    const {
      member_id: memberId,
      tenant_id: tenantId,
      email: memberEmail,
      category_id: categoryId,
    } = fixture.rows[0];

    await setGlobal(client, {
      tenantId,
      email: memberEmail,
      memberId,
      optOutAll: true,
      categoryIds: [categoryId],
    });
    await setGlobal(client, {
      tenantId,
      email: memberEmail,
      memberId,
      optOutAll: true,
      categoryIds: [categoryId],
    });

    const memberLedgers = await client.query(`
      select unsubscribe_type, communication_category_id, count(*)::int as count
      from email_unsubscribe
      where tenant_id = $1
        and lower(trim(email)) = lower(trim($2))
        and unsubscribe_type in ('all', 'category')
      group by unsubscribe_type, communication_category_id
    `, [tenantId, memberEmail]);
    assert.equal(
      memberLedgers.rows.find((row) => row.unsubscribe_type === 'all'
        && row.communication_category_id === null)?.count,
      1,
    );
    assert.equal(
      memberLedgers.rows.find((row) => row.unsubscribe_type === 'category'
        && row.communication_category_id === categoryId)?.count,
      1,
    );

    await setGlobal(client, {
      tenantId,
      email: memberEmail,
      memberId,
      optOutAll: false,
      categoryIds: [categoryId],
    });
    const memberAfterGlobalRemoval = await client.query(`
      select
        exists(
          select 1 from email_unsubscribe
          where tenant_id = $1
            and lower(trim(email)) = lower(trim($2))
            and unsubscribe_type = 'all'
            and communication_category_id is null
        ) as has_global,
        exists(
          select 1 from email_unsubscribe
          where tenant_id = $1
            and lower(trim(email)) = lower(trim($2))
            and unsubscribe_type = 'category'
            and communication_category_id = $3
        ) as has_category
    `, [tenantId, memberEmail, categoryId]);
    assert.deepEqual(memberAfterGlobalRemoval.rows[0], {
      has_global: false,
      has_category: true,
    });

    await client.query(
      'select set_email_preference_category_state($1, $2, $3, $4, true, null)',
      [tenantId, memberEmail, memberId, categoryId],
    );

    const externalEmail = `global-preference-${randomUUID()}@example.invalid`;
    await client.query(`
      insert into email_subscriber (
        tenant_id, email, communication_category_id, opted_out
      ) values ($1, $2, $3, false)
    `, [tenantId, externalEmail, categoryId]);

    await setGlobal(client, {
      tenantId,
      email: externalEmail,
      optOutAll: true,
      categoryIds: [categoryId],
    });
    await setGlobal(client, {
      tenantId,
      email: externalEmail,
      optOutAll: true,
      categoryIds: [categoryId],
    });
    await setGlobal(client, {
      tenantId,
      email: externalEmail,
      optOutAll: false,
      categoryIds: [categoryId],
    });

    const externalAfterGlobalRemoval = await client.query(`
      select
        (
          select count(*)::int
          from email_unsubscribe
          where tenant_id = $1
            and email = $2
            and unsubscribe_type = 'all'
            and communication_category_id is null
        ) as global_count,
        (
          select count(*)::int
          from email_unsubscribe
          where tenant_id = $1
            and email = $2
            and unsubscribe_type = 'category'
            and communication_category_id = $3
        ) as category_count,
        (
          select opted_out
          from email_subscriber
          where tenant_id = $1
            and email = $2
            and communication_category_id = $3
        ) as category_opted_out
    `, [tenantId, externalEmail, categoryId]);
    assert.deepEqual(externalAfterGlobalRemoval.rows[0], {
      global_count: 0,
      category_count: 1,
      category_opted_out: true,
    });

    await client.query(
      'select set_email_preference_category_state($1, $2, null, $3, true, null)',
      [tenantId, externalEmail, categoryId],
    );
    const externalManagedCategory = await client.query(`
      select
        subscriber.opted_out,
        not exists(
          select 1
          from email_unsubscribe ledger
          where ledger.tenant_id = subscriber.tenant_id
            and ledger.email = subscriber.email
            and ledger.unsubscribe_type = 'category'
            and ledger.communication_category_id = subscriber.communication_category_id
        ) as category_ledger_removed
      from email_subscriber subscriber
      where subscriber.tenant_id = $1
        and subscriber.email = $2
        and subscriber.communication_category_id = $3
    `, [tenantId, externalEmail, categoryId]);
    assert.deepEqual(externalManagedCategory.rows[0], {
      opted_out: false,
      category_ledger_removed: true,
    });
  });
});