import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('notification SQL: service-only claims, concurrent/crashed send fencing, durable receipts and atomic notes',
  { timeout: 120000 }, async () => {
    const h = await createLocalPostgresHarness('membership-notifications-');
    const clients = [];
    let started = false;
    const command = (name, args) => {
      const result = spawnSync(name, args, { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    };
    try {
      command('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
      command('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o',
        `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
      started = true;
      for (let i = 0; i < 3; i++) {
        const client = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' });
        await client.connect();
        clients.push(client);
      }
      const [admin, worker, second] = clients;
      await admin.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
        CREATE TABLE member_note(target_member_id uuid,author_member_id uuid,content text);
        CREATE TABLE organization_note(organization_id uuid,member_id uuid,content text,attachments jsonb);`);
      for (const name of ['202612050001_accounting_request_queue', '202612050002_accounting_request_gc_preparation',
        '202612050003_accounting_membership_notifications']) {
        const sql = readFileSync(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8');
        await admin.query(sql);
        if (name.endsWith('notifications')) await admin.query(sql);
      }
      await worker.query('SET ROLE service_role');
      await second.query('SET ROLE service_role');
      const rpc = async (client, name, values) => (await client.query(
        `SELECT to_jsonb(public.${name}(${values.map((_, i) => `$${i + 1}`).join(',')})) AS value`, values)).rows[0].value;
      const tenant = '00000000-0000-4000-8000-000000000001';
      const owner = '00000000-0000-4000-8000-000000000002';
      for (const provider of ['xero', 'quickbooks']) for (const source of [
        'member_membership_history', 'organisation_membership_history',
      ]) {
        const snapshot = { version: 1, invoice: { amount: 100 }, payment: null,
          linkage: { ownerId: owner, recordId: `${provider}-${source}` },
          notification: { version: 1, recipients: ['a@example.invalid', 'b@example.invalid'],
            note: 'Renewed.', createdBy: null } };
        let q = await rpc(worker, 'accounting_request_enqueue',
          [tenant, provider, 'connection', `company-${source}`, source, `${provider}-${source}`, 'invoice', snapshot]);
        q = await rpc(worker, 'accounting_request_claim', [q.id]);
        const checkpoint = (stage, status, result = null) => rpc(worker, 'accounting_request_checkpoint',
          [q.id, q.lease_token, stage, status, result]);
        await assert.rejects(rpc(worker, 'accounting_membership_notification_claim',
          [q.id, q.lease_token, 'a@example.invalid']), /authority unavailable/);
        await checkpoint('invoice', 'writing');
        await checkpoint('invoice', 'done', { id: 'invoice', invoiceNumber: provider === 'xero' ? 'INV-1' : null });
        await checkpoint('link', 'writing');
        await assert.rejects(rpc(worker, 'accounting_membership_notification_claim',
          [q.id, q.lease_token, 'foreign@example.invalid']), /outside accepted/);
        const claims = await Promise.all([worker, second].map(client =>
          rpc(client, 'accounting_membership_notification_claim', [q.id, q.lease_token, 'a@example.invalid'])));
        assert.equal(claims.filter(c => c.claimed).length, 1);
        const token = claims.find(c => c.claimed).token;
        // Lost worker/success response: no lease-based automatic takeover.
        const crashed = await rpc(worker, 'accounting_membership_notification_claim',
          [q.id, q.lease_token, 'a@example.invalid']);
        assert.equal(crashed.claimed, false);
        assert.equal(crashed.status, 'sending');
        await assert.rejects(rpc(worker, 'accounting_membership_notification_finish',
          [q.id, 'a@example.invalid', token, 'delivered', null]), /Invalid delivery/);
        await rpc(worker, 'accounting_membership_notification_finish',
          [q.id, 'a@example.invalid', token, 'delivered', 'mailgun-message-a']);
        await assert.rejects(rpc(worker, 'accounting_membership_notification_finish',
          [q.id, 'a@example.invalid', token, 'pending', null]), /claim lost/);
        await assert.rejects(rpc(worker, 'accounting_membership_notification_note',
          [q.id, q.lease_token]), /delivery incomplete/);
        let b = await rpc(worker, 'accounting_membership_notification_claim', [q.id, q.lease_token, 'b@example.invalid']);
        await rpc(worker, 'accounting_membership_notification_finish', [q.id, 'b@example.invalid', b.token, 'pending', null]);
        const oldToken = b.token;
        b = await rpc(worker, 'accounting_membership_notification_claim', [q.id, q.lease_token, 'b@example.invalid']);
        assert.notEqual(b.token, oldToken);
        await assert.rejects(rpc(worker, 'accounting_membership_notification_finish',
          [q.id, 'b@example.invalid', oldToken, 'delivered', 'wrong']), /claim lost/);
        await rpc(worker, 'accounting_membership_notification_finish',
          [q.id, 'b@example.invalid', b.token, 'delivered', 'mailgun-message-b']);
        const receipts = await rpc(worker, 'accounting_membership_notification_receipts', [q.id, q.lease_token]);
        assert.equal(receipts.length, 2);
        assert.ok(receipts.every(receipt => receipt.status === 'delivered'));
        const noteTable = source === 'member_membership_history' ? 'member_note' : 'organization_note';
        await admin.query(`ALTER TABLE ${noteTable} ADD CONSTRAINT reject_note CHECK(false) NOT VALID`);
        await assert.rejects(rpc(worker, 'accounting_membership_notification_note', [q.id, q.lease_token]), /reject_note/);
        assert.equal((await admin.query('SELECT count(*)::int AS n FROM accounting_membership_notification_note WHERE request_id=$1',
          [q.id])).rows[0].n, 0);
        await admin.query(`ALTER TABLE ${noteTable} DROP CONSTRAINT reject_note`);
        await rpc(worker, 'accounting_membership_notification_note', [q.id, q.lease_token]);
        await rpc(worker, 'accounting_membership_notification_note', [q.id, q.lease_token]);
        await checkpoint('link', 'done', { linked: true });
        await rpc(worker, 'accounting_request_finish', [q.id, q.lease_token, 'complete']);
      }
      for (const table of ['member_note', 'organization_note']) {
        assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 2);
      }
      assert.equal((await admin.query(`SELECT count(*)::int AS n FROM accounting_membership_notification_delivery
        WHERE delivered_at IS NOT NULL AND provider_message_id IS NOT NULL`)).rows[0].n, 8);
      await worker.query('SET ROLE authenticated');
      await assert.rejects(worker.query('SELECT * FROM accounting_membership_notification_delivery'), /permission denied/);
      await assert.rejects(rpc(worker, 'accounting_membership_notification_claim', [tenant, owner, 'a@example.invalid']),
        /permission denied/);
    } finally {
      await Promise.all(clients.map(client => client.end()));
      if (started) command('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
      await h.cleanup();
    }
  });
