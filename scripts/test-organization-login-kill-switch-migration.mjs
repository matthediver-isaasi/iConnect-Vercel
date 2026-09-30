import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { isApprovedDestinationSupabaseTarget } from './lib/destinationSupabaseTarget.mjs';

const connectionString = process.env.DEST_DATABASE_URL;
const destinationSupabaseUrl = process.env.DEST_SUPABASE_URL;
if (!connectionString || !destinationSupabaseUrl
    || !isApprovedDestinationSupabaseTarget(connectionString, destinationSupabaseUrl)) {
  throw new Error('Verified DEST_DATABASE_URL and DEST_SUPABASE_URL are required.');
}

const client = new pg.Client({
  connectionString,
  ssl: { rejectUnauthorized: false },
});
const nonce = crypto.randomUUID();

await client.connect();
try {
  await client.query('BEGIN');
  const { rows: tenants } = await client.query(
    `SELECT id FROM public.tenant WHERE status = 'active' ORDER BY id LIMIT 1`
  );
  assert.ok(tenants[0]?.id, 'DEST must contain an active tenant for transactional migration verification');
  const tenantId = tenants[0].id;

  const { rows: orgRows } = await client.query(
    `INSERT INTO public.organization (tenant_id, name)
     VALUES ($1, $2) RETURNING id`,
    [tenantId, `Task 4395 transaction ${nonce}`],
  );
  const organizationId = orgRows[0].id;
  const { rows: memberRows } = await client.query(
    `INSERT INTO public.member (tenant_id, organization_id, email)
     VALUES ($1, $2, $3) RETURNING id`,
    [tenantId, organizationId, `task-4395-${nonce}@example.invalid`],
  );
  const memberId = memberRows[0].id;

  // Proves the fence remains complete past PostgREST's common 1,000-row cap:
  // session cleanup may be delayed, but every one of these rows is fenced by
  // the one durable member generation below.
  await client.query(
    `INSERT INTO public.session (sid, sess, expire)
     SELECT $1 || '-' || series::text,
       json_build_object(
         'memberId', $2::text,
         'memberLoginGeneration', 0,
         'organisationLoginGateGeneration', 0
       ),
       now() + interval '1 hour'
     FROM generate_series(1, 1001) AS series`,
    [`task4395-${nonce}`, memberId],
  );

  await client.query(
    `UPDATE public.organization SET member_login_blocked = true WHERE id = $1`,
    [organizationId],
  );
  await client.query('SAVEPOINT generation_tamper');
  try {
    await client.query(
      `UPDATE public.organization SET member_login_revocation_generation = -1 WHERE id = $1`,
      [organizationId],
    );
    assert.fail('direct generation decrease unexpectedly succeeded');
  } catch (error) {
    assert.match(error.message, /(monotonic|check constraint)/i);
    await client.query('ROLLBACK TO SAVEPOINT generation_tamper');
  }
  await client.query('RELEASE SAVEPOINT generation_tamper');
  const { rows: memberFence } = await client.query(
    `SELECT generation FROM public.member_login_session_revocation WHERE member_id = $1::text`,
    [memberId],
  );
  assert.equal(Number(memberFence[0]?.generation), 1, 'manual block must atomically write member fence');
  const { rows: fencedRows } = await client.query(
    `SELECT count(*)::integer AS count
     FROM public.session s
     CROSS JOIN public.member_login_session_revocation r
     WHERE s.sess->>'memberId' = r.member_id
       AND (s.sess->>'memberLoginGeneration')::bigint < r.generation
       AND s.sid LIKE $1`,
    [`task4395-${nonce}%`],
  );
  assert.equal(fencedRows[0].count, 1001, 'all sessions beyond 1,000 are durably revoked');
  await client.query('SAVEPOINT expected_fence_failure');
  try {
    await client.query(
      `INSERT INTO public.session (sid, sess, expire)
       VALUES ($1, json_build_object('memberId', $2::text, 'memberLoginGeneration', 0,
                 'organisationLoginGateGeneration', 0), now() + interval '1 hour')`,
      [`task4395-stale-${nonce}`, memberId],
    );
    assert.fail('database write fence accepted a stale member session');
  } catch (error) {
    assert.match(error.message, /generation is revoked/);
    await client.query('ROLLBACK TO SAVEPOINT expected_fence_failure');
  }
  await client.query('RELEASE SAVEPOINT expected_fence_failure');

  // Restoring allowed access does not alter the tombstone generation.
  await client.query(
    `UPDATE public.organization SET member_login_blocked = false WHERE id = $1`,
    [organizationId],
  );
  const { rows: restoredFence } = await client.query(
    `SELECT generation FROM public.member_login_session_revocation WHERE member_id = $1::text`,
    [memberId],
  );
  assert.equal(Number(restoredFence[0]?.generation), 1, 'unblock must never resurrect old sessions');
  await client.query('SAVEPOINT stale_session_upgrade');
  try {
    await client.query(
      `UPDATE public.session
       SET sess = json_build_object('memberId', $1::text, 'memberLoginGeneration', 999,
                  'organizationLoginGeneration', 999, 'userType', 'tenant_user')
       WHERE sid = $2`,
      [memberId, `task4395-${nonce}-1`],
    );
    assert.fail('stale session update unexpectedly restamped revoked provenance');
  } catch (error) {
    assert.match(error.message, /Existing member login session generation is revoked/);
    await client.query('ROLLBACK TO SAVEPOINT stale_session_upgrade');
  }
  await client.query('RELEASE SAVEPOINT stale_session_upgrade');

  const { rows: existingGate } = await client.query(
    `SELECT id FROM public.system_settings
     WHERE tenant_id = $1 AND setting_key = 'organization_login_gate'
     LIMIT 1`,
    [tenantId],
  );
  const gateValue = JSON.stringify({
    enabled: true, fieldSource: 'core', fieldKey: 'status', requiredValue: 'active',
  });
  if (existingGate[0]?.id) {
    await client.query(
      `UPDATE public.system_settings SET setting_value = $1 WHERE id = $2`,
      [gateValue, existingGate[0].id],
    );
  } else {
    await client.query(
      `INSERT INTO public.system_settings (tenant_id, setting_key, setting_value)
       VALUES ($1, 'organization_login_gate', $2)`,
      [tenantId, gateValue],
    );
  }
  const memberGeneration = async (id = memberId) => {
    const { rows } = await client.query(
      `SELECT generation FROM public.member_login_session_revocation WHERE member_id = $1::text`,
      [id],
    );
    return Number(rows[0]?.generation || 0);
  };
  const { rows: legacyMemberRows } = await client.query(
    `INSERT INTO public.member (tenant_id, organization_id, email)
     VALUES (NULL, $1, $2) RETURNING id`,
    [organizationId, `task-4395-legacy-${nonce}@example.invalid`],
  );
  const { rows: unrelatedOrgRows } = await client.query(
    `INSERT INTO public.organization (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [tenantId, `Task 4395 unrelated ${nonce}`],
  );
  const { rows: unrelatedMemberRows } = await client.query(
    `INSERT INTO public.member (tenant_id, organization_id, email) VALUES ($1, $2, $3) RETURNING id`,
    [tenantId, unrelatedOrgRows[0].id, `task-4395-unrelated-${nonce}@example.invalid`],
  );
  const beforeCore = await memberGeneration();
  const beforeLegacyCore = await memberGeneration(legacyMemberRows[0].id);
  await client.query(`UPDATE public.organization SET status = 'task-4395-denied' WHERE id = $1`, [organizationId]);
  assert.equal(await memberGeneration(), beforeCore + 1, 'direct denied core transition must advance only linked member fence');
  assert.equal(await memberGeneration(legacyMemberRows[0].id), beforeLegacyCore + 1, 'NULL-tenant legacy member linked to denied organisation must be fenced');
  assert.equal(await memberGeneration(unrelatedMemberRows[0].id), 0, 'allowed unrelated organisation must not be logged out');

  const customGateValue = JSON.stringify({
    enabled: true, fieldSource: 'custom', fieldKey: '__pending__', requiredValue: 'allowed',
  });
  const { rows: customFieldRows } = await client.query(
    `INSERT INTO public.preference_field (tenant_id, name, label, field_type, entity_scope)
     VALUES ($1, $2, $3, 'text', 'organization') RETURNING id`,
    [tenantId, `task4395-field-${nonce}`, `Task 4395 ${nonce}`],
  );
  const customFieldId = customFieldRows[0].id;
  const { rows: otherFieldRows } = await client.query(
    `INSERT INTO public.preference_field (tenant_id, name, label, field_type, entity_scope)
     VALUES ($1, $2, $3, 'text', 'organization') RETURNING id`,
    [tenantId, `task4395-other-${nonce}`, `Task 4395 other ${nonce}`],
  );
  const gateSetting = JSON.stringify({
    ...JSON.parse(customGateValue),
    fieldKey: customFieldId,
  });
  await client.query(
    `UPDATE public.system_settings SET setting_value = $1
     WHERE tenant_id = $2 AND setting_key = 'organization_login_gate'`,
    [gateSetting, tenantId],
  );
  const unrelatedAfterConfig = await memberGeneration(unrelatedMemberRows[0].id);
  // Returning A to an allowed core value does not revoke it. Switching the
  // gate to an absent custom value may revoke A, so establish the baseline
  // only after that configuration transition.
  await client.query(`UPDATE public.organization SET status = 'active' WHERE id = $1`, [organizationId]);
  const beforeCustomInsert = await memberGeneration();
  const { rows: preferenceRows } = await client.query(
    `INSERT INTO public.organization_preference_value (organization_id, field_id, value)
     VALUES ($1, $2, 'allowed') RETURNING id`,
    [organizationId, customFieldId],
  );
  assert.equal(await memberGeneration(), beforeCustomInsert, 'allowed custom recovery must not revoke sessions');
  const beforeCustomDelete = await memberGeneration();
  await client.query(`DELETE FROM public.organization_preference_value WHERE id = $1`, [preferenceRows[0].id]);
  assert.equal(await memberGeneration(), beforeCustomDelete + 1, 'direct custom gate-field delete to denied must advance linked fence');
  const { rows: restoredPreferenceRows } = await client.query(
    `INSERT INTO public.organization_preference_value (organization_id, field_id, value)
     VALUES ($1, $2, 'allowed') RETURNING id`,
    [organizationId, customFieldId],
  );
  const beforeCustomMove = await memberGeneration();
  await client.query(
    `UPDATE public.organization_preference_value SET field_id = $1 WHERE id = $2`,
    [otherFieldRows[0].id, restoredPreferenceRows[0].id],
  );
  assert.equal(await memberGeneration(), beforeCustomMove + 1, 'moving a gated custom value to denied must advance linked fence');
  assert.equal(await memberGeneration(unrelatedMemberRows[0].id), unrelatedAfterConfig, 'custom edit must not revoke unrelated organisation member');

  const { rows: otherOrgRows } = await client.query(
    `INSERT INTO public.organization (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [tenantId, `Task 4395 reassignment ${nonce}`],
  );
  const beforeReassignment = await memberGeneration();
  await client.query(`UPDATE public.member SET organization_id = $1 WHERE id = $2`, [otherOrgRows[0].id, memberId]);
  const { rows: reassignmentFence } = await client.query(
    `SELECT generation FROM public.member_login_session_revocation WHERE member_id = $1::text`,
    [memberId],
  );
  assert.equal(Number(reassignmentFence[0]?.generation), beforeReassignment + 1, 'direct member reassignment must advance member fence');

  // Hostile REST roles cannot inspect/mint/rewrite session or revocation state;
  // service_role keeps the server-side Supabase client functional.
  async function expectAnonDenied(sql, params = []) {
    await client.query('SAVEPOINT hostile_role');
    await client.query('SET LOCAL ROLE anon');
    try {
      await client.query(sql, params);
      assert.fail(`anon unexpectedly executed: ${sql}`);
    } catch (error) {
      assert.match(error.message, /(permission denied|row-level security)/i);
      await client.query('ROLLBACK TO SAVEPOINT hostile_role');
    }
    await client.query('RELEASE SAVEPOINT hostile_role');
  }
  await expectAnonDenied(`SELECT * FROM public.member_login_session_revocation LIMIT 1`);
  await expectAnonDenied(
    `INSERT INTO public.session (sid, sess, expire)
     VALUES ($1, '{}'::json, now() + interval '1 hour')`,
    [`task4395-anon-${nonce}`],
  );
  await expectAnonDenied(`SELECT public.bump_member_login_generation('hostile', 'hostile')`);
  await client.query('SAVEPOINT service_role_access');
  await client.query('SET LOCAL ROLE service_role');
  await assert.doesNotReject(client.query(`SELECT count(*) FROM public.session`));
  await client.query('ROLLBACK TO SAVEPOINT service_role_access');
  await client.query('RELEASE SAVEPOINT service_role_access');

  await client.query('ROLLBACK');

  // Two independent connections reproduce the phantom-member race: the block
  // transaction has scanned existing members, while a new member/session is
  // committed before that block commits. The organisation generation must
  // still make that session unusable after access is restored.
  const { rows: phantomOrgRows } = await client.query(
    `INSERT INTO public.organization (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [tenantId, `Task 4395 phantom ${nonce}`],
  );
  const phantomOrgId = phantomOrgRows[0].id;
  const phantomSessionId = `task4395-phantom-${nonce}`;
  const peer = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await peer.connect();
  let phantomMemberId;
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = '10000ms'`);
    await client.query(`UPDATE public.organization SET member_login_blocked = true WHERE id = $1`, [phantomOrgId]);
    const { rows: phantomMemberRows } = await peer.query(
      `INSERT INTO public.member (tenant_id, organization_id, email) VALUES ($1, $2, $3) RETURNING id`,
      [tenantId, phantomOrgId, `task-4395-phantom-${nonce}@example.invalid`],
    );
    phantomMemberId = phantomMemberRows[0].id;
    await peer.query(
      `INSERT INTO public.session (sid, sess, expire)
       VALUES ($1, json_build_object('memberId', $2::text, 'memberLoginGeneration', 0,
                 'organizationLoginGeneration', 0), now() + interval '1 hour')`,
      [phantomSessionId, phantomMemberId],
    );
    await client.query('COMMIT');
    await client.query(`UPDATE public.organization SET member_login_blocked = false WHERE id = $1`, [phantomOrgId]);
    const { rows: phantomFenceRows } = await client.query(
      `SELECT count(*)::integer AS count
       FROM public.session s
       JOIN public.member m ON m.id::text = s.sess->>'memberId'
       JOIN public.organization o ON o.id = m.organization_id
       WHERE s.sid = $1
         AND COALESCE((s.sess->>'organizationLoginGeneration')::bigint, 0)
             < o.member_login_revocation_generation`,
      [phantomSessionId],
    );
    assert.equal(phantomFenceRows[0].count, 1, 'phantom member session must remain fenced after restore');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await peer.query(`DELETE FROM public.session WHERE sid = $1`, [phantomSessionId]).catch(() => {});
    if (phantomMemberId) await peer.query(`DELETE FROM public.member WHERE id = $1`, [phantomMemberId]).catch(() => {});
    await peer.query(`DELETE FROM public.organization WHERE id = $1`, [phantomOrgId]).catch(() => {});
    await peer.end();
  }

  // Isolated-tenant gate transition races: creators start while the gate
  // change holds the exclusive lock, then commit afterwards. Fresh
  // post-lock policy evaluation must reject both organisationless and newly
  // organised member session issuance without touching any other tenant.
  const { rows: raceTenantRows } = await client.query(
    `INSERT INTO public.tenant (name, slug) VALUES ($1, $2) RETURNING id`,
    [`Task 4395 race ${nonce}`, `task-4395-race-${nonce}`],
  );
  const raceTenantId = raceTenantRows[0].id;
  const racePeer = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await racePeer.connect();
  let noOrgMemberId;
  let raceOrgId;
  let raceOrgMemberId;
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO public.system_settings (tenant_id, setting_key, setting_value)
       VALUES ($1, 'organization_login_gate', $2)`,
      [raceTenantId, JSON.stringify({ enabled: true, fieldSource: 'core', fieldKey: 'status', requiredValue: 'active' })],
    );
    const noOrgInsert = racePeer.query(
      `INSERT INTO public.member (tenant_id, email) VALUES ($1, $2) RETURNING id`,
      [raceTenantId, `task-4395-no-org-${nonce}@example.invalid`],
    );
    await client.query('COMMIT');
    noOrgMemberId = (await noOrgInsert).rows[0].id;
    await assert.rejects(
      racePeer.query(
        `INSERT INTO public.session (sid, sess, expire)
         VALUES ($1, json_build_object('memberId', $2::text, 'tenantId', $3::text,
                   'memberLoginGeneration', 0, 'organizationLoginGeneration', 0),
                 now() + interval '1 hour')`,
        [`task4395-no-org-${nonce}`, noOrgMemberId, raceTenantId],
      ),
      /blocked by organisation gate/,
      'organizationless member created across gate transition cannot mint a session',
    );

    await client.query('BEGIN');
    await client.query(
      `UPDATE public.system_settings SET setting_value = $1
       WHERE tenant_id = $2 AND setting_key = 'organization_login_gate'`,
      [JSON.stringify({ enabled: true, fieldSource: 'core', fieldKey: 'status', requiredValue: 'denied' }), raceTenantId],
    );
    const orgInsert = racePeer.query(
      `INSERT INTO public.organization (tenant_id, name, status) VALUES ($1, $2, 'active') RETURNING id`,
      [raceTenantId, `Task 4395 new-org race ${nonce}`],
    );
    await client.query('COMMIT');
    raceOrgId = (await orgInsert).rows[0].id;
    const { rows: raceOrgMemberRows } = await racePeer.query(
      `INSERT INTO public.member (tenant_id, organization_id, email) VALUES ($1, $2, $3) RETURNING id`,
      [raceTenantId, raceOrgId, `task-4395-new-org-${nonce}@example.invalid`],
    );
    raceOrgMemberId = raceOrgMemberRows[0].id;
    await assert.rejects(
      racePeer.query(
        `INSERT INTO public.session (sid, sess, expire)
         VALUES ($1, json_build_object('memberId', $2::text, 'tenantId', $3::text,
                   'memberLoginGeneration', 0, 'organizationLoginGeneration', 0),
                 now() + interval '1 hour')`,
        [`task4395-new-org-${nonce}`, raceOrgMemberId, raceTenantId],
      ),
      /blocked by organisation gate/,
      'new organisation/member created across gate transition cannot mint a session',
    );
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    if (raceOrgMemberId) await racePeer.query(`DELETE FROM public.member WHERE id = $1`, [raceOrgMemberId]).catch(() => {});
    if (noOrgMemberId) await racePeer.query(`DELETE FROM public.member WHERE id = $1`, [noOrgMemberId]).catch(() => {});
    if (raceOrgId) await racePeer.query(`DELETE FROM public.organization WHERE id = $1`, [raceOrgId]).catch(() => {});
    await racePeer.query(`DELETE FROM public.system_settings WHERE tenant_id = $1 AND setting_key = 'organization_login_gate'`, [raceTenantId]).catch(() => {});
    await racePeer.query(`DELETE FROM public.tenant WHERE id = $1`, [raceTenantId]).catch(() => {});
    await racePeer.end();
  }

  // Two real write-skew regressions. In each case a previously valid session
  // is issued first, then a config writer and policy-value writer race on two
  // connections. The shared lock forces the second writer to evaluate the
  // post-config policy and advances the organisation fence.
  const { rows: skewTenantRows } = await client.query(
    `INSERT INTO public.tenant (name, slug) VALUES ($1, $2) RETURNING id`,
    [`Task 4395 skew ${nonce}`, `task-4395-skew-${nonce}`],
  );
  const skewTenantId = skewTenantRows[0].id;
  const skewPeer = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await skewPeer.connect();
  let skewOrgId, skewMemberId, skewFieldId, skewPreferenceId;
  try {
    const { rows } = await client.query(
      `INSERT INTO public.organization (tenant_id, name, status) VALUES ($1, $2, 'active') RETURNING id`,
      [skewTenantId, `Task 4395 skew org ${nonce}`],
    );
    skewOrgId = rows[0].id;
    const member = await client.query(
      `INSERT INTO public.member (tenant_id, organization_id, email) VALUES ($1, $2, $3) RETURNING id`,
      [skewTenantId, skewOrgId, `task-4395-skew-${nonce}@example.invalid`],
    );
    skewMemberId = member.rows[0].id;
    const field = await client.query(
      `INSERT INTO public.preference_field (tenant_id, name, label, field_type, entity_scope)
       VALUES ($1, $2, $3, 'text', 'organization') RETURNING id`,
      [skewTenantId, `task4395-skew-${nonce}`, `Task 4395 skew ${nonce}`],
    );
    skewFieldId = field.rows[0].id;
    const pref = await client.query(
      `INSERT INTO public.organization_preference_value (organization_id, field_id, value)
       VALUES ($1, $2, 'allowed') RETURNING id`, [skewOrgId, skewFieldId],
    );
    skewPreferenceId = pref.rows[0].id;
    const customGate = JSON.stringify({ enabled: true, fieldSource: 'custom', fieldKey: skewFieldId, requiredValue: 'allowed' });
    await client.query(`INSERT INTO public.system_settings (tenant_id, setting_key, setting_value) VALUES ($1, 'organization_login_gate', $2)`, [skewTenantId, customGate]);
    await client.query(
      `INSERT INTO public.session (sid, sess, expire) VALUES ($1, json_build_object(
        'memberId', $2::text, 'tenantId', $3::text, 'memberLoginGeneration', 0,
        'organizationLoginGeneration', 0), now() + interval '1 hour')`,
      [`task4395-skew-core-${nonce}`, skewMemberId, skewTenantId],
    );
    await client.query('BEGIN');
    await client.query(`UPDATE public.system_settings SET setting_value = $1 WHERE tenant_id = $2 AND setting_key = 'organization_login_gate'`, [JSON.stringify({ enabled: true, fieldSource: 'core', fieldKey: 'status', requiredValue: 'active' }), skewTenantId]);
    const coreMutation = skewPeer.query(`UPDATE public.organization SET status = 'inactive' WHERE id = $1`, [skewOrgId]);
    await client.query('COMMIT');
    await coreMutation;
    const coreFence = await client.query(`SELECT member_login_revocation_generation AS generation FROM public.organization WHERE id = $1`, [skewOrgId]);
    assert.ok(Number(coreFence.rows[0].generation) > 0, 'config-versus-core race advances stale session organisation fence');

    await client.query(`UPDATE public.organization SET status = 'active' WHERE id = $1`, [skewOrgId]);
    const freshGeneration = Number((await client.query(`SELECT member_login_revocation_generation AS generation FROM public.organization WHERE id = $1`, [skewOrgId])).rows[0].generation);
    const freshMemberGeneration = Number((await client.query(`SELECT generation FROM public.member_login_session_revocation WHERE member_id = $1::text`, [skewMemberId])).rows[0]?.generation || 0);
    await client.query(
      `INSERT INTO public.session (sid, sess, expire) VALUES ($1, json_build_object(
        'memberId', $2::text, 'tenantId', $3::text, 'memberLoginGeneration', $4::bigint,
        'organizationLoginGeneration', $5::bigint), now() + interval '1 hour')`,
      [`task4395-skew-custom-${nonce}`, skewMemberId, skewTenantId, freshMemberGeneration, freshGeneration],
    );
    await client.query('BEGIN');
    await client.query(`UPDATE public.system_settings SET setting_value = $1 WHERE tenant_id = $2 AND setting_key = 'organization_login_gate'`, [customGate, skewTenantId]);
    const customMutation = skewPeer.query(`UPDATE public.organization_preference_value SET value = 'denied' WHERE id = $1`, [skewPreferenceId]);
    await client.query('COMMIT');
    await customMutation;
    const customFence = await client.query(`SELECT member_login_revocation_generation AS generation FROM public.organization WHERE id = $1`, [skewOrgId]);
    assert.ok(Number(customFence.rows[0].generation) > freshGeneration, 'config-versus-custom race advances stale session organisation fence');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await skewPeer.query(`DELETE FROM public.session WHERE sid LIKE $1`, [`task4395-skew-%${nonce}`]).catch(() => {});
    if (skewPreferenceId) await skewPeer.query(`DELETE FROM public.organization_preference_value WHERE id = $1`, [skewPreferenceId]).catch(() => {});
    if (skewMemberId) await skewPeer.query(`DELETE FROM public.member WHERE id = $1`, [skewMemberId]).catch(() => {});
    if (skewOrgId) await skewPeer.query(`DELETE FROM public.organization WHERE id = $1`, [skewOrgId]).catch(() => {});
    if (skewFieldId) await skewPeer.query(`DELETE FROM public.preference_field WHERE id = $1`, [skewFieldId]).catch(() => {});
    await skewPeer.query(`DELETE FROM public.system_settings WHERE tenant_id = $1`, [skewTenantId]).catch(() => {});
    await skewPeer.query(`DELETE FROM public.tenant WHERE id = $1`, [skewTenantId]).catch(() => {});
    await skewPeer.end();
  }
  console.log('Verified durable fences, NULL-tenant legacy coverage, phantom-member concurrency, hostile roles, isolation, direct transitions, restoration tombstones, and >1000-session coverage on DEST.');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await client.end();
}