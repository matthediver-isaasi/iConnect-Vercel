import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('follow-up migration preserves legacy history, validates offsets and fences concurrent identities/claims', { timeout: 120000 }, async () => {
  const h = await createLocalPostgresHarness('follow-up-schema-'), clients = [];
  let started = false;
  const command = (name, args) => { const r = spawnSync(name, args, { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  try {
    command('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    command('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o',
      `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    for (let i = 0; i < 3; i++) {
      const c = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' });
      await c.connect(); clients.push(c);
    }
    const [admin, a, b] = clients;
    await admin.query(readFileSync('docs/event_email_schema.sql', 'utf8'));
    const e = '00000000-0000-4000-8000-000000000001', book = '00000000-0000-4000-8000-000000000002';
    await admin.query(`INSERT INTO event_email(id,event_id,email_type,subject,body) VALUES($1,$1,'reminder','s','b')`, [e]);
    await admin.query(`INSERT INTO scheduled_email(event_email_id,booking_id,attendee_email,scheduled_send_time,status)
      VALUES($1,$2,'fixture@example.test',now(),'sent')`, [e, book]);
    await admin.query(readFileSync('supabase/migrations/202612310039_training_reminder_target_snapshot.sql', 'utf8'));
    await admin.query(readFileSync('supabase/migrations/202612310060_event_email_follow_ups.sql', 'utf8'));
    assert.equal((await admin.query('SELECT status FROM scheduled_email')).rows[0].status, 'sent');
    await assert.rejects(admin.query(`INSERT INTO scheduled_email(event_email_id,booking_id,attendee_email,scheduled_send_time)
      VALUES($1,$2,'fixture@example.test',now())`, [e, book]), { code: '23505' });
    for (const value of [-1, 'NaN', 'Infinity']) {
      await assert.rejects(admin.query(`INSERT INTO event_email(event_id,email_type,subject,body,follow_up_scope,follow_up_delay,follow_up_unit)
        VALUES($1,'follow_up','s','b','event',$2,'hours')`, [e, value]), { code: '23514' });
    }
    await assert.rejects(admin.query(`INSERT INTO event_email(event_id,email_type,subject,body)
      VALUES($1,'follow_up','s','b')`, [e]), { code: '23514' });
    const f = (await admin.query(`INSERT INTO event_email(event_id,email_type,subject,body,follow_up_scope,follow_up_delay,follow_up_unit)
      VALUES($1,'follow_up','s','b','day',0,'hours') RETURNING id`, [e])).rows[0].id;
    const insert = c => c.query(`INSERT INTO scheduled_email(event_email_id,booking_id,attendee_email,scheduled_send_time,
      follow_up_target_key,follow_up_target_snapshot,follow_up_booking_table)
      VALUES($1,$2,'fixture@example.test',now(),'day:2027-01-02','snapshot','booking') RETURNING id`, [f, book]);
    const outcomes = await Promise.allSettled([insert(a), insert(b)]);
    assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(outcomes.find(x => x.status === 'rejected').reason.code, '23505');
    const row = outcomes.find(x => x.status === 'fulfilled').value.rows[0].id;
    const claim = c => c.query("UPDATE scheduled_email SET status='failed' WHERE id=$1 AND status='pending' RETURNING id", [row]);
    const claims = await Promise.all([claim(a), claim(b)]);
    assert.equal(claims.reduce((n, r) => n + r.rowCount, 0), 1);
    assert.equal((await admin.query("UPDATE scheduled_email SET status='pending' WHERE id=$1 AND status='pending' RETURNING id", [row])).rowCount, 0);
    await admin.query(`INSERT INTO scheduled_email(event_email_id,booking_id,attendee_email,scheduled_send_time,
      follow_up_target_key,follow_up_target_snapshot,follow_up_booking_table)
      VALUES($1,$2,'fixture@example.test',now(),'day:2027-01-03','snapshot','booking')`, [f, book]);
    assert.equal((await admin.query('SELECT count(*)::int n FROM scheduled_email')).rows[0].n, 3);
  } finally {
    await Promise.all(clients.map(c => c.end()));
    if (started) command('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});
