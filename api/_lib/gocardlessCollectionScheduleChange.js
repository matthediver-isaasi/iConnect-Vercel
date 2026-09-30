import { randomUUID } from 'node:crypto';
import { gocardlessForTenant } from './gocardless.js';

const live = ['active', 'mandate_pending', 'first_payment_pending'];
const checked = (result) => {
  if (result.error) throw new Error(result.error.message);
  return result.data;
};

export function scheduleChangeReason({ agreement, plan, paused = false, canEdit = false }) {
  if (!canEdit) return 'Administrator Direct Debit and finance permissions are required';
  if (!agreement || !plan || agreement.tenant_id !== plan.tenant_id
    || plan.billing_agreement_id !== agreement.id
    || (plan.member_id && plan.member_id !== agreement.member_id)
    || (plan.organization_id && plan.organization_id !== agreement.organization_id)) return 'Plan ownership could not be verified';
  if (agreement.provider !== 'gocardless') return 'Only GoCardless collection timing is editable here';
  if (paused || !live.includes(plan.status) || !live.includes(agreement.status)
    || plan.collection_stopped_at) return 'The membership or payment plan is paused, stopped or inactive';
  if (plan.metadata?.catch_up_intent || agreement.metadata?.bnms_pilot_approval) return 'This plan has a protected recovery or pilot schedule requiring manual review';
  if (plan.gocardless_subscription_id) return 'Fixed subscriptions require cancellation and replacement to change their date; this feature does not perform that unsafe transition';
  if (plan.metadata?.collection_mode !== 'dynamic'
    || agreement.metadata?.dd?.collection_policy?.pricing_policy !== 'dynamic'
    || agreement.metadata?.dd?.collection_policy?.version !== 1) return 'An explicit application-scheduled dynamic collection agreement is required';
  if (!plan.dynamic_next_collection_date || !plan.metadata?.dynamic_first_date) return 'No remaining evidenced monthly collection schedule';
  return null;
}

export async function loadGoCardlessSchedule({ db, tenantId, agreement, plan, paused = false, canEdit = false, gc }) {
  const result = { provider: 'gocardless', regularDay: null, nextConfirmedDate: null,
    evidence: 'unavailable', canEdit: false, reason: 'Collection schedule evidence unavailable',
    planId: plan?.id || null, version: plan?.metadata?.collection_schedule_version || 0 };
  if (!plan || plan.tenant_id !== tenantId || agreement?.tenant_id !== tenantId
    || plan.billing_agreement_id !== agreement.id) return result;
  try {
    if (plan.gocardless_subscription_id) {
      const client = gc || await gocardlessForTenant(tenantId);
      const subscription = await client.getSubscription(plan.gocardless_subscription_id);
      if (subscription.links?.mandate !== agreement.gocardless_mandate_id) throw new Error('Provider subscription ownership mismatch');
      const providerDay = Number(subscription.day_of_month);
      result.regularDay = Number.isInteger(providerDay) && providerDay >= 1 && providerDay <= 31 ? providerDay : null;
      result.nextConfirmedDate = (subscription.upcoming_payments || [])
        .map(payment => payment.charge_date).filter(date => date >= new Date().toISOString().slice(0, 10)).sort()[0] || null;
      result.evidence = 'provider';
    } else if (plan.metadata?.collection_mode === 'dynamic' && /^\d{4}-\d{2}-\d{2}$/.test(plan.metadata.dynamic_first_date || '')) {
      result.regularDay = Number(plan.metadata.dynamic_first_date.slice(8));
      result.evidence = 'application_schedule';
    }
    const payments = checked(await db.from('gocardless_payments').select('charge_date,status')
      .eq('tenant_id', tenantId).eq('plan_id', plan.id)
      .in('status', ['pending_customer_approval', 'pending_submission', 'submitted'])
      .gte('charge_date', new Date().toISOString().slice(0, 10))
      .order('charge_date', { ascending: true }).limit(1));
    result.nextConfirmedDate = result.nextConfirmedDate || payments?.[0]?.charge_date || null;
    result.reason = scheduleChangeReason({ agreement, plan, paused, canEdit });
    if (!result.reason) {
      const unresolved = checked(await db.from('gocardless_collection_reservations').select('id')
        .eq('tenant_id', tenantId).eq('plan_id', plan.id).neq('status', 'submitted').limit(1));
      const arrears = checked(await db.from('membership_monthly_arrears_period').select('id')
        .eq('tenant_id', tenantId).eq('plan_id', plan.id).is('settled_at', null).limit(1));
      if (unresolved?.length) result.reason = 'A collection is reserved or awaiting reconciliation; resolve it before changing the day';
      else if (arrears?.length) result.reason = 'Outstanding arrears require review before changing the day';
    }
    result.canEdit = !result.reason;
  } catch (error) {
    result.reason = `Schedule could not be verified: ${error.message}`;
  }
  return result;
}

// Provider documentation: subscription dates require cancel/recreate, not an
// in-place update. Dynamic changes instead alter only our operational cadence.
// Notice and banking dates are always resolved by the existing collector from
// the mandate's next_possible_charge_date; previews are NOT confirmed charges.
export async function changeGoCardlessCollectionDay({ db, tenantId, agreement, plan, actorEmail, body, gc }) {
  const reason = scheduleChangeReason({ agreement, plan, canEdit: true });
  if (reason) throw new Error(reason);
  if (!Number.isInteger(body.day) || body.day < 1 || body.day > 28) throw new Error('Collection day must be an integer from 1 to 28');
  const confirm = body.action === 'change_collection_day';
  const requestId = confirm ? body.preview?.requestId : randomUUID();
  if (!/^[0-9a-f-]{36}$/i.test(requestId || '')) throw new Error('A saved preview is required');
  const client = gc || await gocardlessForTenant(tenantId);
  const mandate = await client.getMandate(agreement.gocardless_mandate_id);
  if (mandate?.id !== agreement.gocardless_mandate_id || mandate.status !== 'active'
    || !/^\d{4}-\d{2}-\d{2}$/.test(mandate.next_possible_charge_date || '')) {
    throw new Error('An active mandate with a confirmed notice window is required');
  }
  const amendment = checked(await db.rpc('change_gocardless_collection_day', {
    p_tenant_id: tenantId, p_plan_id: plan.id, p_request_id: requestId,
    p_day: body.day, p_confirm: confirm, p_notice_date: mandate.next_possible_charge_date,
    p_actor_email: actorEmail,
  }));
  if (confirm) return { ok: true, amendment };
  return { preview: { day: body.day, requestId, effectiveDate: amendment.effective_date,
    version: amendment.version, nextConfirmedDate: amendment.next_confirmed_date,
    noticeDate: mandate.next_possible_charge_date,
    message: 'Applies to the next unreserved monthly collection. Already scheduled payments remain unchanged. Actual bank collection dates may move for notice periods, weekends and bank holidays; this is not a confirmed charge date.' } };
}