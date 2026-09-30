// Incident-specific acknowledgement, NOT a workflow replay. Dry-run unless --apply.
// No personal data or workflow payload values are printed.
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const TENANT = '21296ad6-1350-483a-a90c-1b06ece70501';
const EVENT = '15e1c506-8ced-4c72-81ab-8eb07dd11f38';
const SUBMISSION = '93ac8bce-6ab3-4a8a-b40b-610652aaaf78';
const ORGANIZATION = 'ce1578e3-f700-417a-9816-683fee5b7561';
const OCCURRENCE = '416e05f0-cd68-49a3-80c9-fb38260b487c';
const FIELD = '253a166d-1914-4ea0-a214-d3476dc97e14';
const SCHOOL_LEVELS = '24dd507a-43b4-45f8-a396-eb4b9b079f1d';
const KEY = `dd-field-mapping:${EVENT}`;
const EVENT_KEY = 'preference:ded635a2-fb7a-48df-b6a3-14110c537885:11';
const REASON = 'Incident reconciliation 15e1c506: existing matching organization flags verified; acknowledged without workflow replay or stage change';
// Exact pending cohort captured during the read-only investigation. Never
// discover and acknowledge newly created siblings merely by a broad filter.
const PENDING = new Map([
  ['9652f714-917b-4169-bae2-e238eb3b0477', ['12', '36d0817e-acb7-43f1-8590-531e19886b61']],
  ['8dfdec0b-fd50-4409-9993-6651de19c63b', ['13', '84a15ff1-542a-442c-a8fc-4eb9585505e1']],
  ['0dce0147-febb-43de-81d3-68d49f152d49', ['14', '62a6b407-22c8-43d8-b357-1c4e0bca6538']],
  ['e07706c5-a652-40d6-b90f-986a164a3c5a', ['15', '24dd507a-43b4-45f8-a396-eb4b9b079f1d']],
  ['64bf4db8-a38e-49fd-ac8f-dd4816885eae', ['16', 'eff6f08f-bddc-4205-9cac-7251a11db368']],
  ['ac09c787-fd0d-4680-aece-ed2c19a4a1d1', ['17', 'bbc558ab-1782-4994-b70a-87939544828a']],
  ['98e94a65-a0b3-42d5-9c1c-180f8172ef42', ['18', 'a67cbbad-d0bc-4805-b98d-1d5d53d9f26a']],
  ['f7d11935-2200-4a7e-bb8d-02460a1bff83', ['19', '9cf870e4-6b3b-47d1-9233-a783135130b7']],
  ['8a734ac8-2326-423b-b4c6-8ee420563200', ['21', '81fe250c-ae91-477f-80d9-79e24033063d']],
  ['2c0767f9-4c41-49ce-ae9b-ef6349703284', ['22', '3c8cfcd5-c89b-4f8f-9e5a-aee47539d574']],
  ['fc3897f5-570b-4914-9510-2bf4d01314e5', ['23', '45641770-9594-462e-b235-79316a11a1be']],
  ['3ad6e060-559b-4de4-afc6-41ec65ec93bf', ['24', 'f2435ba9-9e15-4b02-bf47-c1f0aacf8ff6']],
  ['56f87859-557d-4c9e-8c6b-d341a8d9a181', ['25', '680f7943-f602-4da0-86b8-0fa01ac99218']],
  ['88a1c4f2-010e-4f8d-8051-9583d55d1b01', ['26', 'd89bc293-99d1-455d-80c3-50efbad06add']],
  ['a78e883f-1030-4c9f-97c9-796e04035e04', ['27', 'e2c271e7-b650-4438-8302-cf0c0155a1aa']],
  ['94a22077-a770-4ad4-80e3-8d2d48d39c12', ['31', 'c6abfa4f-9a54-49c6-8f62-68c0714d3a46']],
  ['97ced59e-160d-4951-b147-4b0128adf027', ['32', '077f1aa6-abdc-4bdc-a6ca-34b93c8726fd']],
  ['2e815929-d244-4102-b2d7-c8fe6ca0834d', ['7', 'c613c9be-8ae6-4201-b704-c5b24b24fe16']],
  ['585d74e9-b786-4a59-82ef-bcd0997b3fe0', ['8', '79e723bd-f5ff-43aa-aa62-eec7f5c5c88f']],
  ['d10f7b70-7e5c-498d-8199-af38b475234b', ['9', 'b687c108-7ea5-450d-930d-7d5bf6b3acf0']],
]);
const PENDING_FIELDS = [...new Set([...PENDING.values()].map(([, field]) => field))];

// These are the complete active organization workflow set, including the
// nonmatching email/record-create workflows. Any edit/addition blocks apply.
// Fingerprint is MD5 of the named jsonb_build_object in WORKFLOWS below.
const EXPECTED = new Map(Object.entries({
  '31bde2ab-3966-401b-9bdd-f770764ed9ce': '9f04b24116d2a3100fc631eab7e5a33f',
  '4bdb2cbb-76c3-468b-9464-b768dd1bfe1a': '4c7dc2b94d38578eb25e929826dac8a9',
  '5912cb3e-27b5-414d-a105-69a83ea1697b': 'a5b21e7409f8fa84e9dca6035354b0b8',
  '69534af9-1c9e-4cf3-ba39-c59115c7e426': '697292eccc8273c70a1405c5cb68c0d3',
  '80775fe1-1f75-4892-80eb-56edf1d3e3fa': '4d6451965ec29e683dc884911f1f5c8a',
  'b9c7dfb0-172f-440b-82da-d582ebf9aa8f': '0030bfdfcf44d7cecb32e5a5871b724f',
  'c17479a8-00a2-413d-8a30-c2a61e728cac': 'e49fdddad2801cf7a0de63c3bc29e227',
  'd45ddf4e-4093-4f98-8ec8-b3eeaaf00a19': 'ec0faad198f182992e0dcf5c0024d71a',
  'd4fc3dc0-a61c-463d-aa1c-29a1f90233e5': 'f7ea2daa8cc857e276c99dd49945d774',
  'e3384f06-5fc2-49d5-a337-889be7280a0e': 'f541c9d046b0b84ae93dcca16a611677',
}));
const ASSIGNMENTS = new Map(Object.entries({
  'b9c7dfb0-172f-440b-82da-d582ebf9aa8f': ['e0fa56c0-bcb2-4e76-9d60-2b066fadf993', 'true'],
  '69534af9-1c9e-4cf3-ba39-c59115c7e426': ['5258baff-8cc0-4d86-aec2-d79790e0cb0d', 'true'],
  'd4fc3dc0-a61c-463d-aa1c-29a1f90233e5': ['de0fa76a-bfa1-4543-9eec-bb2015389c05', 'false'],
}));
const ALL_ASSIGNMENTS = new Map([
  ...ASSIGNMENTS,
  ['e3384f06-5fc2-49d5-a337-889be7280a0e', ['e0fa56c0-bcb2-4e76-9d60-2b066fadf993', 'false']],
  ['4bdb2cbb-76c3-468b-9464-b768dd1bfe1a', ['5258baff-8cc0-4d86-aec2-d79790e0cb0d', 'false']],
  ['c17479a8-00a2-413d-8a30-c2a61e728cac', ['de0fa76a-bfa1-4543-9eec-bb2015389c05', 'true']],
]);
const FLAGS = [...new Set([...ASSIGNMENTS.values()].map(([field]) => field))];
const assert = (condition, reason) => { if (!condition) throw new Error(`Guard failed: ${reason}`); };
const rows = async (db, sql, params = []) => (await db.query(sql, params)).rows;
const lock = (apply) => apply ? ' FOR UPDATE' : '';

function conditionMet(condition, value) {
  assert(['contains', 'not_contains'].includes(condition.operator), 'unsupported condition operator');
  const text = String(value ?? '');
  let array;
  try { array = JSON.parse(text); } catch { /* plain text preference */ }
  const contains = Array.isArray(array)
    ? array.some(item => String(item).toLowerCase() === String(condition.value).toLowerCase())
    : text.toLowerCase().includes(String(condition.value).toLowerCase());
  return condition.operator === 'contains' ? contains : !contains;
}
function workflowMatches(conditions, schoolLevels) {
  assert(Array.isArray(conditions) && conditions.length > 0, 'unexpected conditions');
  return conditions.reduce((value, condition, index) => {
    assert(condition.field_id === SCHOOL_LEVELS && condition.field_type === 'org_custom', 'condition target changed');
    const matched = conditionMet(condition, schoolLevels);
    return index === 0 ? matched : condition.logic === 'OR' ? value || matched : value && matched;
  }, false);
}

const WORKFLOWS = `SELECT id, name, trigger_type, trigger_config, conditions, actions,
  md5(jsonb_build_object('entity_type',entity_type,'trigger_type',trigger_type,
    'trigger_config',trigger_config,'conditions',conditions,'actions',actions,
    'is_active',is_active,'trigger_mode',trigger_mode,
    'revert',revert_trigger_on_condition_fail)::text) fingerprint
  FROM workflow WHERE tenant_id=$1 AND entity_type='organization' AND is_active`;

export async function reconcile(db, { apply = false } = {}) {
  let begun = false;
  try {
    await db.query(`BEGIN ISOLATION LEVEL SERIALIZABLE ${apply ? 'READ WRITE' : 'READ ONLY'}`);
    begun = true;
    await db.query("SET LOCAL statement_timeout = '15s'");
    await db.query("SET LOCAL lock_timeout = '3s'");
    const outbox = (await rows(db, `SELECT id, tenant_id, form_submission_due_diligence_id,
      event_key, event_type, target_entity, organization_id, member_id, payload,
      status, attempt_count, created_at, updated_at, last_error, completed_at
      FROM form_due_diligence_field_mapping_workflow_outbox
      WHERE id=$1 AND tenant_id=$2${lock(apply)}`, [EVENT, TENANT]))[0];
    assert(outbox && outbox.form_submission_due_diligence_id === SUBMISSION
      && outbox.organization_id === ORGANIZATION && outbox.member_id === null
      && outbox.event_key === EVENT_KEY && outbox.event_type === 'preference'
      && outbox.target_entity === 'organization' && outbox.status === 'requires_attention'
      && outbox.attempt_count === 1 && !outbox.completed_at, 'outbox identity/state changed');
    assert(outbox.payload && Object.keys(outbox.payload).sort().join(',') === 'field_id,new_value'
      && outbox.payload.field_id === FIELD, 'immutable event contract changed');
    assert(outbox.last_error?.includes('interrupted and requires attention'), 'outbox reason changed');

    const claim = (await rows(db, `SELECT delivery_key,tenant_id,entity_type,entity_id,
      status,claimed_at,completed_at,updated_at,last_error,owner_token
      FROM workflow_delivery_claim WHERE delivery_key=$1 AND tenant_id=$2${lock(apply)}`,
    [KEY, TENANT]))[0];
    assert(claim && claim.entity_type === 'organization' && claim.entity_id === ORGANIZATION
      && claim.status === 'processing' && claim.owner_token && !claim.completed_at
      && !claim.last_error && new Date(claim.claimed_at).getTime() === new Date(claim.updated_at).getTime(),
    'claim identity/state changed');
    assert(Date.now() - new Date(claim.claimed_at).getTime() > 30 * 60_000,
      'claim is not stale (30 minutes)');

    const dd = (await rows(db, `SELECT id,tenant_id,workflow_status,stage_action_occurrence_id
      FROM form_submission_due_diligence WHERE id=$1 AND tenant_id=$2${lock(apply)}`,
    [SUBMISSION, TENANT]))[0];
    assert(dd && dd.workflow_status === 'approved' && dd.stage_action_occurrence_id === OCCURRENCE,
      'current approved DD occurrence changed');
    const org = (await rows(db, `SELECT id,tenant_id FROM organization
      WHERE id=$1 AND tenant_id=$2${lock(apply)}`, [ORGANIZATION, TENANT]))[0];
    assert(org, 'organization changed');

    const pending = await rows(db, `SELECT id,tenant_id,form_submission_due_diligence_id,
      event_key,event_type,target_entity,organization_id,member_id,status,
      attempt_count,completed_at,payload
      FROM form_due_diligence_field_mapping_workflow_outbox
      WHERE tenant_id=$1 AND form_submission_due_diligence_id=$2
        AND status IN ('pending','processing','requires_attention')
      ORDER BY id${lock(apply)}`, [TENANT, SUBMISSION]);
    assert(pending.length === PENDING.size + 1
      && pending.filter(row => row.id === EVENT).length === 1,
    'unresolved outbox cohort changed');
    const siblingsToReconcile = pending.filter(row => row.id !== EVENT);
    for (const sibling of siblingsToReconcile) {
      const expected = PENDING.get(sibling.id);
      assert(expected, `unexpected unresolved sibling ${sibling.id}`);
      assert(sibling.tenant_id === TENANT && sibling.form_submission_due_diligence_id === SUBMISSION
        && sibling.event_key === `preference:ded635a2-fb7a-48df-b6a3-14110c537885:${expected[0]}`
        && sibling.event_type === 'preference' && sibling.target_entity === 'organization'
        && sibling.organization_id === ORGANIZATION && sibling.member_id === null
        && sibling.status === 'pending' && sibling.attempt_count === 0 && !sibling.completed_at
        && sibling.payload?.field_id === expected[1]
        && Object.keys(sibling.payload).sort().join(',') === (expected[0] === '32'
          ? 'field_id,new_value,previous_value' : 'field_id,new_value'),
      `sibling ${expected[0]} state/immutable payload changed`);
    }
    const pendingClaims = await rows(db, `SELECT delivery_key,status
      FROM workflow_delivery_claim WHERE delivery_key = ANY($1::text[])${lock(apply)}`,
    [siblingsToReconcile.map(row => `dd-field-mapping:${row.id}`)]);
    assert(pendingClaims.length === 0, `pending siblings have pre-existing claim(s): ${pendingClaims.length}`);

    const values = await rows(db, `SELECT field_id::text, value FROM organization_preference_value
      WHERE organization_id=$1 AND field_id::text = ANY($2::text[])${lock(apply)}`,
    [ORGANIZATION, [FIELD, ...PENDING_FIELDS, ...FLAGS]]);
    const byField = new Map(values.map(v => [v.field_id, v.value]));
    assert(values.length === 4 + PENDING_FIELDS.length && byField.get(FIELD) === outbox.payload.new_value,
      'event preference no longer matches current organization value');
    const types = await rows(db, `SELECT id::text, field_type FROM preference_field
      WHERE id::text = ANY($1::text[]) AND tenant_id=$2 AND entity_scope='organization'
        AND is_active${apply ? ' FOR SHARE' : ''}`,
    [[FIELD, ...PENDING_FIELDS, ...FLAGS], TENANT]);
    const fieldTypes = new Map(types.map(v => [v.id, v.field_type]));
    assert(types.length === 4 + PENDING_FIELDS.length && fieldTypes.get(FIELD) === 'boolean'
      && fieldTypes.get(SCHOOL_LEVELS) === 'picklist'
      && FLAGS.every(f => fieldTypes.get(f) === 'boolean'), 'preference field schema/config changed');
    for (const sibling of siblingsToReconcile) {
      const number = PENDING.get(sibling.id)[0];
      assert(typeof sibling.payload.new_value === 'string'
        && fieldTypes.has(sibling.payload.field_id)
        && byField.has(sibling.payload.field_id)
        && byField.get(sibling.payload.field_id) === sibling.payload.new_value,
      `sibling ${number} current preference does not equal persisted payload`);
    }

    const workflows = await rows(db, WORKFLOWS + (apply ? ' FOR SHARE' : ''), [TENANT]);
    assert(workflows.length === EXPECTED.size && workflows.every(w => EXPECTED.get(w.id) === w.fingerprint),
      'active organization workflow set/config fingerprint changed');
    const recordUpdates = workflows.filter(w => w.trigger_type === 'record_update');
    assert(recordUpdates.length === ALL_ASSIGNMENTS.size
      && recordUpdates.every(w => ALL_ASSIGNMENTS.has(w.id)), 'nested workflow candidates changed');
    for (const workflow of recordUpdates) {
      const [field, value] = ALL_ASSIGNMENTS.get(workflow.id);
      assert(workflow.actions?.length === 1
        && workflow.actions[0].type === 'update_field'
        && workflow.actions[0].config?.field_type === 'custom'
        && workflow.actions[0].config?.field_id === field
        && workflow.actions[0].config?.value === value
        && field !== FIELD && field !== SCHOOL_LEVELS,
      'potential direct/nested action is not a static custom DB assignment');
    }
    const matches = workflows.filter(w => {
      if (w.trigger_type === 'record_update') return workflowMatches(w.conditions, byField.get(SCHOOL_LEVELS));
      assert(w.trigger_type === 'field_change' || w.trigger_type === 'record_create',
        'unexpected workflow trigger type');
      if (w.trigger_type === 'field_change') {
        assert(w.trigger_config?.field_type === 'core' && w.trigger_config?.field_id === 'payment_status',
          'field-change workflow could match event, sibling, or nested custom assignment');
      }
      return false;
    });
    assert(matches.length === 3 && matches.every(w => ASSIGNMENTS.has(w.id))
      && new Set(matches.map(w => w.id)).size === 3, 'matching workflow set changed');
    for (const workflow of matches) {
      const [field, value] = ASSIGNMENTS.get(workflow.id);
      assert(workflow.actions?.length === 1
        && workflow.actions[0].type === 'update_field'
        && workflow.actions[0].config?.field_type === 'custom'
        && workflow.actions[0].config?.field_id === field
        && workflow.actions[0].config?.value === value
        && byField.get(field) === value, 'matching action is not an already satisfied static custom assignment');
    }
    // For nested custom changes, the same six record_update workflows are
    // evaluated again; there are no matching custom field_change workflows.
    const siblings = await rows(db, `SELECT status,event_type,count(*)::int count
      FROM form_due_diligence_field_mapping_workflow_outbox
      WHERE tenant_id=$1 AND form_submission_due_diligence_id=$2
      GROUP BY status,event_type ORDER BY status,event_type`, [TENANT, SUBMISSION]);
    const summary = {
      event: EVENT, mode: apply ? 'apply' : 'dry-run', reconciled: false,
      guards: 'exact outbox/claim/approved occurrence and 20 pending sibling IDs/payloads; no sibling claim; all current preferences equal payload; stale claim; all 10 workflow fingerprints; three matching static custom assignments already satisfied; no matching custom field-change/email',
      matchedWorkflows: matches.map(w => ({ id: w.id, name: w.name, kind: 'update_field/custom' })),
      siblings, pendingSiblingsAssessed: siblingsToReconcile.length,
      pendingSiblingsAcknowledged: 0, pendingSiblingsDispatched: false,
      separateDataIssue: 'registered_all_countries is typed boolean but stored value is noncanonical',
    };
    // This is diagnostic only: do not change source value, stage, siblings,
    // workflow logs, or dispatch any action.
    assert(!['true', 'false'].includes(byField.get(FIELD)), 'incident-specific boolean mismatch changed');
    if (apply) {
      const note = `${REASON} at ${new Date().toISOString()}`;
      const updatedClaim = await rows(db, `UPDATE workflow_delivery_claim SET
        status='completed', completed_at=now(), updated_at=now(),
        last_error=$3 WHERE delivery_key=$1 AND tenant_id=$2 AND status='processing'
        AND owner_token=$4 AND completed_at IS NULL RETURNING delivery_key`,
      [KEY, TENANT, note, claim.owner_token]);
      assert(updatedClaim.length === 1, 'claim changed during acknowledgement');
      const updatedOutbox = await rows(db, `UPDATE form_due_diligence_field_mapping_workflow_outbox SET
        status='completed', completed_at=now(), updated_at=now(),
        last_error=left(coalesce(last_error,'') || ' | ' || $3,2000)
        WHERE id=$1 AND tenant_id=$2 AND status='requires_attention'
        AND attempt_count=1 AND completed_at IS NULL RETURNING id`,
      [EVENT, TENANT, note]);
      assert(updatedOutbox.length === 1, 'outbox changed during acknowledgement');
      // Claim insertion and outbox update form one unit with the original
      // acknowledgement. Conflict means a worker claimed a sibling: rollback.
      const newClaims = await rows(db, `INSERT INTO workflow_delivery_claim
        (delivery_key,tenant_id,entity_type,entity_id,status,owner_token,
         claimed_at,completed_at,last_error,created_at,updated_at)
        SELECT 'dd-field-mapping:' || o.id, $2, 'organization', $3, 'completed',
          gen_random_uuid(), now(), now(), $4, now(), now()
        FROM form_due_diligence_field_mapping_workflow_outbox o
        WHERE o.id = ANY($1::uuid[]) AND o.tenant_id=$2
          AND o.form_submission_due_diligence_id=$5 AND o.status='pending'
          AND o.attempt_count=0 AND o.completed_at IS NULL
        ON CONFLICT DO NOTHING RETURNING delivery_key`,
      [siblingsToReconcile.map(row => row.id), TENANT, ORGANIZATION, note, SUBMISSION]);
      assert(newClaims.length === PENDING.size, 'a pending sibling was claimed or changed');
      const completedSiblings = await rows(db, `UPDATE form_due_diligence_field_mapping_workflow_outbox
        SET status='completed', completed_at=now(), updated_at=now(), last_error=$3
        WHERE id=ANY($1::uuid[]) AND tenant_id=$2
          AND form_submission_due_diligence_id=$4 AND status='pending'
          AND attempt_count=0 AND completed_at IS NULL RETURNING id`,
      [siblingsToReconcile.map(row => row.id), TENANT, note, SUBMISSION]);
      assert(completedSiblings.length === PENDING.size, 'a pending sibling changed during acknowledgement');
      summary.pendingSiblingsAcknowledged = completedSiblings.length;
      summary.reconciled = true;
    }
    await db.query(apply ? 'COMMIT' : 'ROLLBACK');
    begun = false;
    return summary;
  } catch (error) {
    if (begun) await db.query('ROLLBACK');
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply') || args.length > 1) {
    console.error('Usage: node scripts/reconcile-gsf-dd-fanout-15e1c506.mjs [--apply]');
    process.exitCode = 2;
  } else if (!process.env.DEST_DATABASE_URL
    || !process.env.DEST_SUPABASE_URL?.startsWith('https://lvmzliemqnieeoruhkik.supabase.co')) {
    console.error('DEST_DATABASE_URL and the exact DEST_SUPABASE_URL project are required');
    process.exitCode = 2;
  } else {
    const client = new pg.Client({
      connectionString: process.env.DEST_DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      options: '-c default_transaction_read_only=on',
    });
    try {
      await client.connect();
      console.log(JSON.stringify(await reconcile(client, { apply: args[0] === '--apply' }), null, 2));
    } catch (error) {
      console.error(`Recovery not applied: ${error.message}`);
      process.exitCode = 1;
    } finally {
      await client.end();
    }
  }
}