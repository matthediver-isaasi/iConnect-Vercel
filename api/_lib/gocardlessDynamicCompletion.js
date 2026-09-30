// Financial completion for one-off dynamic collections. The database owns the
// all-payments predicate and commits settlement plus its notification outbox.
import { supabase } from './database.js';
import { sendDdLifecycleEmail } from './gocardlessDdEmails.js';
import { sendTenantEmail } from './tenantEmailService.js';
import {
  processDynamicCompletion, processDynamicNotification,
  runDynamicCompletion, runDynamicNotification,
  selectDynamicCompletions, selectDynamicNotifications,
} from './directDebitDynamicPipeline.js';

const checked = (result, context) => {
  if (result.error) throw new Error(`${context}: ${result.error.message}`);
  return result.data;
};
const COMPLETIONS = 'gocardless_dynamic_term_completions';

export async function notifyDynamicTermCompletion(completion, {
  db = supabase, sendEmail = sendTenantEmail, emailLifecycle = sendDdLifecycleEmail,
  now = () => new Date(),
} = {}) {
  return processDynamicNotification({ completion,
    effects: createLiveDynamicCompletionEffects({ db, sendEmail, emailLifecycle, now }) });
}

async function executeDynamicCompletionNotice(completion, {
  db = supabase, sendEmail = sendTenantEmail, emailLifecycle = sendDdLifecycleEmail,
  now = () => new Date(),
} = {}) {
  if (completion.notification_status === 'sent') return { sent: true, duplicate: true };
  if (completion.notification_status === 'review') return { sent: false, review: true };
  let preparation;
  if (!completion.notification_messages) {
    const agreement = checked(await db.from('membership_billing_agreements').select('*')
      .eq('id', completion.billing_agreement_id).eq('tenant_id', completion.tenant_id).single(), 'Load completed dynamic agreement');
    const messages = [];
    // Render and resolve the entire recipient manifest before any transport
    // effect. Subsequent retries use this immutable manifest, not live contacts.
    preparation = await emailLifecycle('plan_completed', agreement, {
      db, send: async message => { messages.push(message); return { success: true }; },
    });
    if (messages.length) {
      completion = checked(await db.rpc('prepare_gocardless_dynamic_completion_notice', {
        p_tenant_id: completion.tenant_id, p_plan_id: completion.plan_id, p_messages: messages,
      }), 'Reserve completion recipient manifest');
    }
  }
  let uncertain = false;
  let attempts = 0;
  const sendMessage = async message => {
    attempts++;
    const claim = checked(await db.rpc('claim_gocardless_dynamic_completion_delivery', {
      p_tenant_id: completion.tenant_id, p_plan_id: completion.plan_id,
      p_recipient: message.to, p_message: message,
    }), 'Claim dynamic completion recipient');
    const delivery = claim.delivery;
    if (!claim.claimed) {
      if (delivery.status === 'sent') return { success: true };
      uncertain ||= delivery.status === 'uncertain';
      return { success: false, error: `Completion notification ${delivery.status}` };
    }
    let sent;
    try {
      // Replay the winning message, never rerender/reprice a claimed request.
      sent = await sendEmail(delivery.message);
    } catch (error) {
      // An unclassified throw could occur after provider acceptance.
      sent = { success: false, ambiguousEffect: true, error: error.message };
    }
    const accepted = sent?.success === true;
    const ambiguous = !accepted && (sent?.ambiguousEffect === true || sent == null);
    const status = accepted ? 'sent' : ambiguous ? 'uncertain' : 'failed';
    // If this write fails after send, the durable sending lease becomes
    // uncertain on recovery. It is never blindly resent.
    checked(await db.rpc('finish_gocardless_dynamic_completion_delivery', {
      p_tenant_id: completion.tenant_id, p_delivery_id: delivery.id,
      p_claim_token: delivery.claim_token, p_status: status, p_evidence: sent || { error: 'No transport response' },
    }), 'Persist dynamic completion delivery');
    uncertain ||= ambiguous;
    return accepted ? sent : { success: false, error: sent?.error || 'Completion delivery failed' };
  };
  for (const message of completion.notification_messages || []) await sendMessage(message);
  // Concurrent workers can each deliver a different recipient while observing
  // the other's lease. Derive the aggregate from retained outcomes, not which
  // individual worker happened to send which email.
  const outcomes = checked(await db.from('gocardless_dynamic_completion_deliveries').select('recipient,status')
    .eq('plan_id', completion.plan_id).eq('tenant_id', completion.tenant_id), 'Read completion delivery outcomes');
  const sent = attempts > 0 && (completion.notification_messages || []).every(message =>
    outcomes.some(outcome => outcome.recipient === message.to.trim().toLowerCase() && outcome.status === 'sent'));
  uncertain ||= outcomes.some(outcome => outcome.status === 'uncertain');
  checked(await db.from(COMPLETIONS).update({
    notification_status: sent ? 'sent' : uncertain ? 'review' : 'pending',
    notification_error: sent ? null : uncertain
      ? 'Delivery acceptance is uncertain. Review retained provider evidence before authorizing another attempt.'
      : preparation?.reason || 'Not all completion recipients were accepted; retry is pending',
    notification_next_check_at: new Date(now().getTime() + 60 * 60 * 1000).toISOString(),
    ...(sent ? { notified_at: now().toISOString() } : {}),
  }).eq('plan_id', completion.plan_id).eq('tenant_id', completion.tenant_id)
    .neq('notification_status', 'sent'), 'Update dynamic completion notification');
  return { sent, review: uncertain };
}

export async function completeDynamicTerm(plan, deps = {}) {
  const db = deps.db || supabase;
  return processDynamicCompletion({ plan, effects: createLiveDynamicCompletionEffects({ ...deps, db }) });
}

export function createLiveDynamicCompletionEffects(deps) {
  const db = deps.db || supabase;
  return { async perform(operation) {
    if (operation.type === 'dynamic.completion_notice') {
      return executeDynamicCompletionNotice(operation.payload.completion, { ...deps, db });
    }
    if (operation.type !== 'dynamic.complete_term') throw new Error(`Unknown completion effect: ${operation.type}`);
    const result = checked(await db.rpc('complete_gocardless_dynamic_term', operation.payload), 'Complete dynamic membership term');
    if (result.completed) result.notification = await notifyDynamicTermCompletion(result.completion, { ...deps, db });
    return result;
  } };
}

export async function reconcileDynamicTermCompletions({
  db = supabase, limit = 20, budgetMs = 5000, clock = Date.now, now = () => new Date(), ...deps
} = {}) {
  const started = clock();
  const result = { completed: 0, notified: 0, errors: 0 };
  if (budgetMs <= 0) return result;
  // Give the committed outbox a share before scanning uncompleted terms:
  // long-lived active plans must not starve recovery of an already-expired one.
  const pending = checked(await selectDynamicNotifications(db, now(), limit), 'Load completion notification outbox');
  for (const completion of pending || []) {
    if (clock() - started >= budgetMs / 2) break;
    try {
      if ((await runDynamicNotification({ db, plan: { id: completion.plan_id, tenant_id: completion.tenant_id },
        now: now(), effects: createLiveDynamicCompletionEffects({ ...deps, db, now }) })).sent) result.notified++;
    } catch (cause) {
      result.errors++;
      checked(await db.from(COMPLETIONS).update({
        notification_error: cause.message,
        notification_next_check_at: new Date(now().getTime() + 60 * 60 * 1000).toISOString(),
      }).eq('plan_id', completion.plan_id).eq('tenant_id', completion.tenant_id), 'Record completion notification error');
    }
  }
  if (clock() - started >= budgetMs) return result;
  const plans = checked(await selectDynamicCompletions(db, now(), limit), 'Load dynamic terms for completion recovery');
  for (const plan of plans || []) {
    if (clock() - started >= budgetMs) break;
    let error = null;
    try {
      const settled = await runDynamicCompletion({ db, plan, now: now(),
        effects: createLiveDynamicCompletionEffects({ ...deps, db, now }) });
      if (settled.completed) result.completed++;
    } catch (cause) {
      error = cause.message;
      result.errors++;
    }
    checked(await db.from('membership_payment_plans').update({
      dynamic_completion_next_check_at: new Date(now().getTime() + 60 * 60 * 1000).toISOString(),
      dynamic_completion_error: error,
    }).eq('id', plan.id).eq('tenant_id', plan.tenant_id), 'Record completion recovery outcome');
  }
  return result;
}