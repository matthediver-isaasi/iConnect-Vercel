/**
 * End-to-end verification for the record_create workflow custom-field
 * condition race fix, against DEST (BNMS tenant).
 * Run with:
 *   SUPABASE_URL=$DEST_SUPABASE_URL SUPABASE_SERVICE_KEY=$DEST_SUPABASE_KEY node scripts/verify-task-3196.mjs
 *
 * A) Skipped path: trigger record_create for a member with NO custom-field
 *    value -> expect a workflow_log row with status 'skipped' + condition_results.
 * B) Executed path: create a throwaway member, persist the "Membership status"
 *    preference value = 'Initial enquiry' FIRST (mirroring the reordered
 *    processor), then trigger -> expect the workflow to execute the email
 *    action and log it.
 * C) once_per_record regression: a temp action-less workflow with
 *    trigger_mode=once_per_record must (1) log 'skipped' when conditions are
 *    unmet, (2) still EXECUTE later once conditions are met (skipped rows must
 *    not block it), (3) not execute a second time.
 * All test rows are cleaned up at the end.
 */
import { createClient } from '@supabase/supabase-js';
import { triggerWorkflows } from '../api/_lib/workflows.js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db'; // BNMS
const WORKFLOW = '433e009e-f2f4-4136-ae81-d7c5dd7527b7';
const FIELD = '388e1dfe-d917-4317-933a-0319542a7d92'; // Membership status
const baseUrl = 'https://dev.iconn.app';

const cleanup = { members: [], prefs: [], logs: [], workflows: [] };

async function logsFor(workflowId, entityId) {
  const { data } = await sb.from('workflow_log')
    .select('id,status,trigger_data,actions_executed')
    .eq('workflow_id', workflowId).eq('entity_id', entityId);
  return data || [];
}

try {
  // --- A) Skipped path ---
  const { data: mA, error: eA } = await sb.from('member').insert({
    tenant_id: TENANT, email: 'task3196-skip@example.com', first_name: 'Task3196', last_name: 'SkipTest', login_enabled: false,
  }).select().single();
  if (eA) throw new Error('member A insert: ' + eA.message);
  cleanup.members.push(mA.id);

  await triggerWorkflows('member', mA.id, null, mA, 'record_create', baseUrl, {});
  const logsA = await logsFor(WORKFLOW, mA.id);
  cleanup.logs.push(...logsA.map(l => l.id));
  console.log('A) skipped-path logs:', JSON.stringify(logsA.map(l => ({ status: l.status, cr: l.trigger_data?.condition_results })), null, 1));

  // --- B) Executed path (pref value saved BEFORE trigger, like the fixed processor) ---
  const { data: mB, error: eB } = await sb.from('member').insert({
    tenant_id: TENANT, email: 'task3196-verify@example.com', first_name: 'Task3196', last_name: 'ExecTest', login_enabled: false,
  }).select().single();
  if (eB) throw new Error('member B insert: ' + eB.message);
  cleanup.members.push(mB.id);

  const { data: pv, error: ePv } = await sb.from('member_preference_value').insert({
    member_id: mB.id, field_id: FIELD, value: 'Initial enquiry',
  }).select().single();
  if (ePv) throw new Error('pref insert: ' + ePv.message);
  cleanup.prefs.push(pv.id);

  await triggerWorkflows('member', mB.id, null, mB, 'record_create', baseUrl, {});
  const logsB = await logsFor(WORKFLOW, mB.id);
  cleanup.logs.push(...logsB.map(l => l.id));
  console.log('B) executed-path logs:', JSON.stringify(logsB.map(l => ({ status: l.status, actions: l.actions_executed })), null, 1));

  // --- C) once_per_record: skipped rows must not block a later real run ---
  const { data: wfC, error: eWf } = await sb.from('workflow').insert({
    tenant_id: TENANT, name: 'TMP task3196 once_per_record test', entity_type: 'member',
    trigger_type: 'record_create', trigger_mode: 'once_per_record', is_active: true,
    conditions: [{ field_id: FIELD, field_type: 'member_custom', operator: 'equals', value: 'Initial enquiry', logic: 'AND' }],
    actions: [],
  }).select().single();
  if (eWf) throw new Error('temp workflow insert: ' + eWf.message);
  cleanup.workflows.push(wfC.id);

  const { data: mC, error: eC } = await sb.from('member').insert({
    tenant_id: TENANT, email: 'task3196-once@example.com', first_name: 'Task3196', last_name: 'OnceTest', login_enabled: false,
  }).select().single();
  if (eC) throw new Error('member C insert: ' + eC.message);
  cleanup.members.push(mC.id);

  // 1st trigger: conditions unmet -> skipped
  await triggerWorkflows('member', mC.id, null, mC, 'record_create', baseUrl, {});
  // set the custom field, 2nd trigger: must EXECUTE despite the skipped row
  const { data: pvC, error: ePvC } = await sb.from('member_preference_value').insert({
    member_id: mC.id, field_id: FIELD, value: 'Initial enquiry',
  }).select().single();
  if (ePvC) throw new Error('pref C insert: ' + ePvC.message);
  cleanup.prefs.push(pvC.id);
  await triggerWorkflows('member', mC.id, null, mC, 'record_create', baseUrl, {});
  // 3rd trigger: once_per_record must block a second execution
  await triggerWorkflows('member', mC.id, null, mC, 'record_create', baseUrl, {});

  const logsC = await logsFor(wfC.id, mC.id);
  cleanup.logs.push(...logsC.map(l => l.id));
  const statuses = logsC.map(l => l.status).sort();
  console.log('C) once_per_record logs:', JSON.stringify(statuses));
  const successCount = statuses.filter(s => s === 'success').length;
  const skippedCount = statuses.filter(s => s === 'skipped').length;
  console.log(`C) PASS=${successCount === 1 && skippedCount === 1} (expected exactly 1 success + 1 skipped; got ${successCount} success, ${skippedCount} skipped)`);
} catch (err) {
  console.error('VERIFY FAILED:', err.message);
} finally {
  if (cleanup.logs.length) await sb.from('workflow_log').delete().in('id', cleanup.logs);
  if (cleanup.prefs.length) await sb.from('member_preference_value').delete().in('id', cleanup.prefs);
  if (cleanup.members.length) await sb.from('member').delete().in('id', cleanup.members);
  if (cleanup.workflows.length) await sb.from('workflow').delete().in('id', cleanup.workflows);
  console.log('cleanup done', cleanup);
}
