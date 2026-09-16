#!/usr/bin/env node
/**
 * Destination-only, rollback-protected integration proof for Task #4423.
 *
 * This script deliberately does not leave a fixture, member update, preference
 * value, outbox row, or schema change behind. With --apply-migration it runs
 * the supplied migration in the same transaction as the checks and rolls the
 * migration back at the end. That mode is useful for proving a migration
 * against DEST before a separately approved deployment; it is not a migration
 * runner.
 *
 * Usage:
 *   node scripts/verify-task-4423-linked-member.mjs
 *   node scripts/verify-task-4423-linked-member.mjs --apply-migration
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const MIGRATION = 'supabase/migrations/20261025_form_due_diligence_member_field_mapping.sql';
const DEST_HOST = 'lvmzliemqnieeoruhkik.supabase.co';
const DEST_POOLER_HOST = 'aws-1-eu-central-1.pooler.supabase.com';
const APPLY_MIGRATION = process.argv.includes('--apply-migration');

function fail(message) {
  throw new Error(`[task-4423] ${message}`);
}

function checkDestinationEnvironment() {
  if (!process.env.DEST_DATABASE_URL) {
    fail('DEST_DATABASE_URL is required; no database was changed.');
  }
  if (!process.env.DEST_SUPABASE_URL) {
    fail('DEST_SUPABASE_URL is required; no database was changed.');
  }

  let databaseUrl;
  let supabaseUrl;
  try {
    databaseUrl = new URL(process.env.DEST_DATABASE_URL);
    supabaseUrl = new URL(process.env.DEST_SUPABASE_URL);
  } catch {
    fail('DEST_* database URLs are not valid URLs; no database was changed.');
  }

  if (supabaseUrl.hostname !== DEST_HOST) {
    fail('DEST_SUPABASE_URL is not the documented destination project; no database was changed.');
  }
  if (databaseUrl.hostname !== DEST_POOLER_HOST) {
    fail('DEST_DATABASE_URL is not the documented destination pooler; no database was changed.');
  }
}

async function query(client, text, values = []) {
  return client.query(text, values);
}

async function expectRejected(client, label, text, values) {
  await query(client, 'SAVEPOINT task_4423_negative');
  try {
    await query(client, text, values);
    fail(`${label} unexpectedly succeeded`);
  } catch (error) {
    if (error.message.startsWith('[task-4423]')) throw error;
    await query(client, 'ROLLBACK TO SAVEPOINT task_4423_negative');
    await query(client, 'RELEASE SAVEPOINT task_4423_negative');
    return error;
  }
}

async function findFixtures(client) {
  const local = await query(client, `
    SELECT t.id AS tenant_id, o.id AS organization_id, m.id AS member_id,
           m.first_name, m.email, f.id AS form_id
      FROM public.tenant AS t
      JOIN public.organization AS o
        ON o.tenant_id = t.id
      JOIN public.member AS m
        ON m.tenant_id = t.id
       AND m.organization_id = o.id
      JOIN public.form AS f
        ON f.tenant_id = t.id
     WHERE t.status = 'active'
     LIMIT 1
  `);
  if (!local.rows[0]) {
    fail('DEST has no active tenant/organization/member/form fixture; no database was changed.');
  }

  const localFixture = local.rows[0];
  const foreign = await query(client, `
    SELECT m.id AS member_id, m.tenant_id, o.id AS organization_id
      FROM public.member AS m
      JOIN public.organization AS o
        ON o.tenant_id = m.tenant_id
     WHERE m.tenant_id IS NOT NULL
       AND m.tenant_id <> $1
     LIMIT 1
  `, [localFixture.tenant_id]);
  if (!foreign.rows[0]) {
    fail('DEST has no cross-tenant member fixture for the isolation proof; no database was changed.');
  }

  return {
    ...localFixture,
    foreign_member_id: foreign.rows[0].member_id,
    foreign_organization_id: foreign.rows[0].organization_id,
  };
}

async function assertSchema(client) {
  const columns = await query(client, `
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (
         (table_name = 'stage_field_mapping_action' AND column_name = 'target_entity')
         OR (table_name = 'form_submission_due_diligence'
             AND column_name = 'stage_action_occurrence_id')
         OR (table_name = 'form_due_diligence_field_mapping_workflow_outbox'
             AND column_name IN ('target_entity', 'member_id'))
       )
  `);
  const present = new Set(columns.rows.map((row) => `${row.table_name}.${row.column_name}`));
  for (const expected of [
    'stage_field_mapping_action.target_entity',
    'form_submission_due_diligence.stage_action_occurrence_id',
    'form_due_diligence_field_mapping_workflow_outbox.target_entity',
    'form_due_diligence_field_mapping_workflow_outbox.member_id',
  ]) {
    assert.ok(present.has(expected), `missing ${expected}; apply the Task #4423 migration first`);
  }

  const functions = await query(client, `
    SELECT p.oid::regprocedure::text AS signature,
           p.proargnames
      FROM pg_proc AS p
      JOIN pg_namespace AS n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'apply_form_due_diligence_field_mapping_with_outbox'
  `);
  const rpcFunction = functions.rows.find((row) => row.proargnames?.includes('p_target_entity'));
  assert.ok(rpcFunction, 'member-aware atomic field-mapping RPC is not installed');
  assert.ok(
    rpcFunction.proargnames.includes('p_member_id'),
    'member-aware atomic field-mapping RPC has no p_member_id argument',
  );
}

async function schemaFingerprint(client) {
  const columns = await query(client, `
    SELECT table_name, column_name, is_nullable, udt_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (
         (table_name = 'stage_field_mapping_action' AND column_name = 'target_entity')
         OR (table_name = 'form_submission_due_diligence'
             AND column_name = 'stage_action_occurrence_id')
         OR (table_name = 'form_due_diligence_field_mapping_workflow_outbox'
             AND column_name IN ('target_entity', 'member_id'))
       )
     ORDER BY table_name, column_name
  `);
  const functions = await query(client, `
    SELECT p.oid::regprocedure::text AS signature, p.proargnames
      FROM pg_proc AS p
      JOIN pg_namespace AS n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'apply_form_due_diligence_field_mapping_with_outbox'
     ORDER BY 1
  `);
  return {
    columns: columns.rows,
    functions: functions.rows,
  };
}

async function createFixture(client, fixture) {
  const submissionId = randomUUID();
  const ddId = randomUUID();
  const preferenceId = randomUUID();
  const eventPrefix = `task-4423-${randomUUID()}`;
  const customName = `${eventPrefix}-member-field`;

  await query(client, `
    INSERT INTO public.form_submission (
      id, form_id, tenant_id, organization_id, submission_data, submitted_by_email
    ) VALUES ($1, $2, $3, NULL, $4::jsonb, $5)
  `, [
    submissionId,
    fixture.form_id,
    fixture.tenant_id,
    JSON.stringify({ source_name: 'member-only submission' }),
    `task-4423-${randomUUID()}@example.invalid`,
  ]);
  await query(client, `
    INSERT INTO public.form_submission_due_diligence (
      id, form_submission_id, tenant_id, original_form_values, reviewed_form_values,
      field_review_status
    ) VALUES ($1, $2, $3, $4::jsonb, '{}'::jsonb, '{}'::jsonb)
  `, [
    ddId,
    submissionId,
    fixture.tenant_id,
    JSON.stringify({ source_name: 'member-only submission' }),
  ]);
  await query(client, `
    INSERT INTO public.preference_field (
      id, name, label, field_type, tenant_id, entity_scope, is_active
    ) VALUES ($1, $2, $3, 'text', $4, 'member', TRUE)
  `, [preferenceId, customName, customName, fixture.tenant_id]);

  return {
    ...fixture,
    submission_id: submissionId,
    dd_id: ddId,
    preference_id: preferenceId,
    event_core: `${eventPrefix}:core`,
    event_custom: `${eventPrefix}:custom`,
    event_clear: `${eventPrefix}:clear`,
    new_first_name: `Task4423-${randomUUID().slice(0, 8)}`,
  };
}

async function createSecondOccurrence(client, fixture) {
  const submissionId = randomUUID();
  const ddId = randomUUID();
  await query(client, `
    INSERT INTO public.form_submission (
      id, form_id, tenant_id, organization_id, submission_data, submitted_by_email
    ) VALUES ($1, $2, $3, NULL, $4::jsonb, $5)
  `, [
    submissionId,
    fixture.form_id,
    fixture.tenant_id,
    JSON.stringify({ source_name: 'member-only second occurrence' }),
    `task-4423-${randomUUID()}@example.invalid`,
  ]);
  await query(client, `
    INSERT INTO public.form_submission_due_diligence (
      id, form_submission_id, tenant_id, original_form_values, reviewed_form_values,
      field_review_status
    ) VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)
  `, [ddId, submissionId, fixture.tenant_id]);
  return { ...fixture, submission_id: submissionId, dd_id: ddId };
}

async function rpc(client, fixture, {
  eventKey,
  eventType,
  targetEntity = 'member',
  organizationId = null,
  memberId = fixture.member_id,
  mutation = {},
  preferenceFieldId = null,
  preferenceValue = null,
}) {
  const result = await query(client, `
    SELECT public.apply_form_due_diligence_field_mapping_with_outbox(
      $1::uuid, $2::uuid, $3::text, $4::text, $5::uuid, $6::jsonb,
      $7::uuid, $8::text, $9::text, $10::uuid
    ) AS result
  `, [
    fixture.tenant_id,
    fixture.dd_id,
    eventKey,
    eventType,
    organizationId,
    JSON.stringify(mutation),
    preferenceFieldId,
    preferenceValue,
    targetEntity,
    memberId,
  ]);
  return result.rows[0].result;
}

async function assertOutbox(client, fixture, eventKey, expected) {
  const result = await query(client, `
    SELECT target_entity, organization_id, member_id, event_type, payload
      FROM public.form_due_diligence_field_mapping_workflow_outbox
     WHERE form_submission_due_diligence_id = $1
       AND event_key = $2
  `, [fixture.dd_id, eventKey]);
  assert.equal(result.rowCount, 1, `one outbox event should exist for ${eventKey}`);
  assert.deepEqual(result.rows[0], expected);
}

async function verifyMemberCoreAndIdempotency(client, fixture) {
  const before = await query(client, `
    SELECT first_name, email, organization_id
      FROM public.member
     WHERE id = $1 AND tenant_id = $2
  `, [fixture.member_id, fixture.tenant_id]);
  assert.equal(before.rowCount, 1);

  const applied = await rpc(client, fixture, {
    eventKey: fixture.event_core,
    eventType: 'core',
    mutation: { first_name: fixture.new_first_name },
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.before.first_name, before.rows[0].first_name);
  assert.equal(applied.after.first_name, fixture.new_first_name);

  const after = await query(client, `
    SELECT first_name, email, organization_id
      FROM public.member
     WHERE id = $1 AND tenant_id = $2
  `, [fixture.member_id, fixture.tenant_id]);
  assert.equal(after.rows[0].first_name, fixture.new_first_name);
  assert.equal(after.rows[0].email, before.rows[0].email, 'member core mapping must not update email');
  assert.deepEqual(after.rows[0].organization_id, before.rows[0].organization_id);
  await assertOutbox(client, fixture, fixture.event_core, {
    target_entity: 'member',
    organization_id: null,
    member_id: fixture.member_id,
    event_type: 'core',
    payload: {
      before: applied.before,
      after: applied.after,
      mutation: { first_name: fixture.new_first_name },
    },
  });

  const repeated = await rpc(client, fixture, {
    eventKey: fixture.event_core,
    eventType: 'core',
    mutation: { first_name: fixture.new_first_name },
  });
  assert.equal(repeated.applied, false, 'repeating the same event must be a no-op');
  assert.equal(repeated.replayed, true, 'repeating the same event must replay the persisted result');
  const outboxCount = await query(client, `
    SELECT COUNT(*)::integer AS count
      FROM public.form_due_diligence_field_mapping_workflow_outbox
     WHERE form_submission_due_diligence_id = $1 AND event_key = $2
  `, [fixture.dd_id, fixture.event_core]);
  assert.equal(outboxCount.rows[0].count, 1);

  const changedValueError = await expectRejected(client, 'changed value with same event key', `
    SELECT public.apply_form_due_diligence_field_mapping_with_outbox(
      $1::uuid, $2::uuid, $3::text, 'core', NULL, $4::jsonb,
      NULL, NULL, 'member', $5::uuid
    )
  `, [
    fixture.tenant_id,
    fixture.dd_id,
    fixture.event_core,
    JSON.stringify({ first_name: `${fixture.new_first_name}-changed` }),
    fixture.member_id,
  ]);
  assert.match(changedValueError.message, /different mutation/);

  const orgBefore = await query(client, `
    SELECT name, phone FROM public.organization
     WHERE id = $1 AND tenant_id = $2
  `, [fixture.organization_id, fixture.tenant_id]);
  const changedTargetError = await expectRejected(client, 'changed target with same event key', `
    SELECT public.apply_form_due_diligence_field_mapping_with_outbox(
      $1::uuid, $2::uuid, $3::text, 'core', $4::uuid, $5::jsonb,
      NULL, NULL, 'organization', NULL
    )
  `, [
    fixture.tenant_id,
    fixture.dd_id,
    fixture.event_core,
    fixture.organization_id,
    JSON.stringify({ phone: 'must-not-write' }),
  ]);
  assert.match(changedTargetError.message, /different target/);
  const orgAfter = await query(client, `
    SELECT name, phone FROM public.organization
     WHERE id = $1 AND tenant_id = $2
  `, [fixture.organization_id, fixture.tenant_id]);
  assert.deepEqual(orgAfter.rows, orgBefore.rows, 'same-key target rejection must not mutate the organization');

  const secondOccurrence = await createSecondOccurrence(client, fixture);
  const secondValue = `${fixture.new_first_name}-second`;
  const secondApplied = await rpc(client, secondOccurrence, {
    eventKey: fixture.event_core,
    eventType: 'core',
    mutation: { first_name: secondValue },
  });
  assert.equal(secondApplied.applied, true, 'a new DD occurrence may reuse the action key');
  assert.equal(secondApplied.before.first_name, fixture.new_first_name);
  assert.equal(secondApplied.after.first_name, secondValue);
  await assertOutbox(client, secondOccurrence, fixture.event_core, {
    target_entity: 'member',
    organization_id: null,
    member_id: fixture.member_id,
    event_type: 'core',
    payload: {
      before: secondApplied.before,
      after: secondApplied.after,
      mutation: { first_name: secondValue },
    },
  });
}

async function verifyCustomAndClear(client, fixture) {
  const custom = await rpc(client, fixture, {
    eventKey: fixture.event_custom,
    eventType: 'preference',
    preferenceFieldId: fixture.preference_id,
    preferenceValue: 'custom-value',
  });
  assert.equal(custom.applied, true);
  const stored = await query(client, `
    SELECT value FROM public.member_preference_value
     WHERE member_id = $1 AND field_id = $2
  `, [fixture.member_id, fixture.preference_id]);
  assert.deepEqual(stored.rows, [{ value: 'custom-value' }]);
  await assertOutbox(client, fixture, fixture.event_custom, {
    target_entity: 'member',
    organization_id: null,
    member_id: fixture.member_id,
    event_type: 'preference',
    payload: {
      field_id: fixture.preference_id,
      previous_value: null,
      new_value: 'custom-value',
    },
  });

  const cleared = await rpc(client, fixture, {
    eventKey: fixture.event_clear,
    eventType: 'preference',
    preferenceFieldId: fixture.preference_id,
    preferenceValue: null,
  });
  assert.equal(cleared.applied, true);
  const clearedStored = await query(client, `
    SELECT value FROM public.member_preference_value
     WHERE member_id = $1 AND field_id = $2
  `, [fixture.member_id, fixture.preference_id]);
  // Some destination deployments remove null-valued preference rows in a
  // trigger; both representations mean the member field was cleared.
  assert.ok(
    clearedStored.rows.length === 0
      || (clearedStored.rows.length === 1 && clearedStored.rows[0].value === null),
    'clear must leave no member preference value',
  );
  await assertOutbox(client, fixture, fixture.event_clear, {
    target_entity: 'member',
    organization_id: null,
    member_id: fixture.member_id,
    event_type: 'preference',
    payload: {
      field_id: fixture.preference_id,
      previous_value: 'custom-value',
      new_value: null,
    },
  });
}

async function verifyOrganizationCompatibility(client, fixture) {
  const before = await query(client, `
    SELECT name, email, phone
      FROM public.organization
     WHERE id = $1 AND tenant_id = $2
  `, [fixture.organization_id, fixture.tenant_id]);
  assert.equal(before.rowCount, 1);
  const updatedPhone = `task-4423-${randomUUID()}`;
  const applied = await rpc(client, fixture, {
    eventKey: `${fixture.event_core}:organization`,
    eventType: 'core',
    targetEntity: 'organization',
    organizationId: fixture.organization_id,
    memberId: null,
    mutation: { phone: updatedPhone },
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.before.phone, before.rows[0].phone);
  assert.equal(applied.after.phone, updatedPhone);
  await assertOutbox(client, fixture, `${fixture.event_core}:organization`, {
    target_entity: 'organization',
    organization_id: fixture.organization_id,
    member_id: null,
    event_type: 'core',
    payload: {
      before: applied.before,
      after: applied.after,
      mutation: { phone: updatedPhone },
    },
  });
  const repeated = await rpc(client, fixture, {
    eventKey: `${fixture.event_core}:organization`,
    eventType: 'core',
    targetEntity: 'organization',
    organizationId: fixture.organization_id,
    memberId: null,
    mutation: { phone: updatedPhone },
  });
  assert.equal(repeated.applied, false);
}

async function verifyIsolationAndValidation(client, fixture) {
  const orgBefore = await query(client, `
    SELECT name, email, phone FROM public.organization
     WHERE id = $1 AND tenant_id = $2
  `, [fixture.organization_id, fixture.tenant_id]);
  const memberBefore = await query(client, `
    SELECT first_name, email FROM public.member
     WHERE id = $1 AND tenant_id = $2
  `, [fixture.member_id, fixture.tenant_id]);

  await expectRejected(client, 'invalid target entity', `
    SELECT public.apply_form_due_diligence_field_mapping_with_outbox(
      $1::uuid, $2::uuid, $3::text, 'core', NULL, $4::jsonb,
      NULL, NULL, 'invalid', $5::uuid
    )
  `, [
    fixture.tenant_id,
    fixture.dd_id,
    `${fixture.event_core}:invalid-target`,
    JSON.stringify({ first_name: 'must-not-write' }),
    fixture.member_id,
  ]);
  await expectRejected(client, 'missing member target', `
    SELECT public.apply_form_due_diligence_field_mapping_with_outbox(
      $1::uuid, $2::uuid, $3::text, 'core', NULL, $4::jsonb,
      NULL, NULL, 'member', NULL
    )
  `, [
    fixture.tenant_id,
    fixture.dd_id,
    `${fixture.event_core}:missing-member`,
    JSON.stringify({ first_name: 'must-not-write' }),
  ]);
  await expectRejected(client, 'foreign member target', `
    SELECT public.apply_form_due_diligence_field_mapping_with_outbox(
      $1::uuid, $2::uuid, $3::text, 'core', NULL, $4::jsonb,
      NULL, NULL, 'member', $5::uuid
    )
  `, [
    fixture.tenant_id,
    fixture.dd_id,
    `${fixture.event_core}:foreign-member`,
    JSON.stringify({ first_name: 'must-not-write' }),
    fixture.foreign_member_id,
  ]);
  await expectRejected(client, 'foreign organization target', `
    SELECT public.apply_form_due_diligence_field_mapping_with_outbox(
      $1::uuid, $2::uuid, $3::text, 'core', $4::uuid, $5::jsonb,
      NULL, NULL, 'organization', NULL
    )
  `, [
    fixture.tenant_id,
    fixture.dd_id,
    `${fixture.event_core}:foreign-organization`,
    fixture.foreign_organization_id,
    JSON.stringify({ name: 'must-not-write' }),
  ]);

  const orgAfter = await query(client, `
    SELECT name, email, phone FROM public.organization
     WHERE id = $1 AND tenant_id = $2
  `, [fixture.organization_id, fixture.tenant_id]);
  const memberAfter = await query(client, `
    SELECT first_name, email FROM public.member
     WHERE id = $1 AND tenant_id = $2
  `, [fixture.member_id, fixture.tenant_id]);
  assert.deepEqual(orgAfter.rows, orgBefore.rows);
  assert.deepEqual(memberAfter.rows, memberBefore.rows);
}

async function verifyRollback(client, fixture, before, schemaBefore) {
  await query(client, 'ROLLBACK');
  const check = await new pg.Client({ connectionString: process.env.DEST_DATABASE_URL });
  await check.connect();
  try {
    const member = await query(check, `
      SELECT first_name, email FROM public.member
       WHERE id = $1 AND tenant_id = $2
    `, [fixture.member_id, fixture.tenant_id]);
    assert.deepEqual(member.rows, before.member);
    const outbox = await query(check, `
      SELECT COUNT(*)::integer AS count
        FROM public.form_due_diligence_field_mapping_workflow_outbox
       WHERE form_submission_due_diligence_id = $1
    `, [fixture.dd_id]);
    assert.equal(outbox.rows[0].count, 0, 'rollback must remove all fixture outbox rows');
    const preference = await query(check, `
      SELECT COUNT(*)::integer AS count
        FROM public.preference_field WHERE id = $1
    `, [fixture.preference_id]);
    assert.equal(preference.rows[0].count, 0, 'rollback must remove the temporary preference field');
    assert.deepEqual(
      await schemaFingerprint(check),
      schemaBefore,
      'rollback must remove temporary schema changes when --apply-migration is used',
    );
  } finally {
    await check.end();
  }
}

async function main() {
  checkDestinationEnvironment();
  const migration = APPLY_MIGRATION ? await readFile(MIGRATION, 'utf8') : null;
  const client = new pg.Client({ connectionString: process.env.DEST_DATABASE_URL });
  await client.connect();
  let transactionOpen = false;
  try {
    const schemaBefore = await schemaFingerprint(client);
    await query(client, 'BEGIN');
    transactionOpen = true;
    await query(client, "SELECT pg_advisory_xact_lock(hashtextextended('task-4423-linked-member', 0))");
    if (migration) await query(client, migration);
    await assertSchema(client);
    const fixture = await createFixture(client, await findFixtures(client));
    const before = {
      member: [{
        first_name: fixture.first_name,
        email: fixture.email,
      }],
    };
    await verifyMemberCoreAndIdempotency(client, fixture);
    await verifyCustomAndClear(client, fixture);
    await verifyOrganizationCompatibility(client, fixture);
    await verifyIsolationAndValidation(client, fixture);
    await verifyRollback(client, fixture, before, schemaBefore);
    transactionOpen = false;
    console.log('[task-4423] PASS: member core/custom/clear, atomic before/after outbox, replay no-op, same-key changed-value/target rejection, new-occurrence second event, member-only submission, tenant isolation, invalid/foreign target rejection, and rollback verified on DEST.');
  } catch (error) {
    if (transactionOpen) {
      try {
        await query(client, 'ROLLBACK');
      } catch {
        // Preserve the original assertion or database error.
      }
    }
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`[task-4423] FAIL: ${error.message}`);
  process.exitCode = 1;
});