// Explicit variable-price consent only. Decisions live in the capability-only
// pipeline; this module owns production effects and non-cron integration.
import { supabase } from './database.js';
import { buildIdempotencyKey, gocardlessForTenant } from './gocardless.js';
import {
  DYNAMIC_RESERVATIONS, isDynamicAgreement, dynamicCollectionDate,
  resolveDynamicCollectionPrice as resolvePrice, processDynamicCollection,
  selectDynamicCollections, runDynamicCollection,
} from './directDebitDynamicPipeline.js';

export { DYNAMIC_RESERVATIONS, isDynamicAgreement, dynamicCollectionDate };
export const resolveDynamicCollectionPrice = (agreement, intendedDate, { db = supabase } = {}) =>
  resolvePrice(agreement, intendedDate, { db });
const day = value => new Date(value).toISOString().slice(0, 10);
const equal = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
const checked = (result, context) => {
  if (result.error) throw new Error(`${context}: ${result.error.message}`);
  return result.data;
};

export function assertDynamicPayment(reservation, payment, mandateId) {
  if (!payment?.id || payment.amount !== reservation.amount_minor
    || !equal(payment.currency, reservation.currency)
    || payment.links?.mandate !== mandateId || payment.links?.subscription
    || !payment.charge_date || payment.charge_date !== reservation.requested_charge_date) {
    throw new Error('Dynamic collection provider amount, currency, mandate or charge date does not match its reservation');
  }
  if (reservation.gocardless_payment_id && reservation.gocardless_payment_id !== payment.id) {
    throw new Error('Dynamic collection provider payment identity changed');
  }
}

export async function ensureDynamicPlanForAgreement(agreement, deps = {}) {
  const db = deps.db || supabase;
  const gc = typeof deps.gc?.gocardlessForTenant === 'function'
    ? await deps.gc.gocardlessForTenant(agreement.tenant_id, { db })
    : deps.gc || await gocardlessForTenant(agreement.tenant_id, { db });
  if (!isDynamicAgreement(agreement)) throw new Error('Explicit dynamic collection consent is required');
  const terms = agreement.metadata.dd;
  const term = terms.commitment;
  if (!term?.term_key || !term.term_start_date || !term.term_end_date
    || terms.invoicing_mode !== 'per_instalment') throw new Error('Dynamic collection term or invoicing consent is incomplete');
  const idempotencyKey = buildIdempotencyKey('dd-dynamic-plan', agreement.tenant_id, agreement.id, term.term_key);
  let plan = checked(await db.from('membership_payment_plans').select('*')
    .eq('tenant_id', agreement.tenant_id).eq('idempotency_key', idempotencyKey).maybeSingle(), 'Load dynamic plan');
  let created = false;
  if (!plan) {
    const mandate = await gc.getMandate(agreement.gocardless_mandate_id);
    if (mandate?.status !== 'active' || !mandate.next_possible_charge_date) throw new Error('Dynamic collection mandate is not active or has no provider earliest charge date');
    const today = day(typeof deps.now === 'function' ? deps.now() : new Date());
    let first = [today, term.term_start_date, mandate.next_possible_charge_date].sort().at(-1);
    if (terms.first_collection_rule !== 'earliest') {
      const nominated = terms.first_collection_rule === 'anniversary'
        ? Number(term.term_start_date.slice(8, 10)) : Number(terms.collection_day);
      const wanted = Math.max(1, Math.min(28, nominated || 1));
      const candidate = `${first.slice(0, 8)}${String(wanted).padStart(2, '0')}`;
      first = candidate < first ? dynamicCollectionDate(candidate, 2) : candidate;
    }
    if (first > term.term_end_date) throw new Error('Provider notice window leaves no collection within the purchased term');
    const row = {
      tenant_id: agreement.tenant_id, billing_agreement_id: agreement.id,
      member_id: agreement.member_id || null, organization_id: agreement.organization_id || null,
      provider: 'gocardless', gocardless_mandate_id: agreement.gocardless_mandate_id,
      amount_minor: terms.monthly_amount_minor, currency: terms.currency, interval_unit: 'monthly',
      day_of_month: Number(first.slice(8)), status: 'mandate_pending',
      membership_year: terms.membership_year, start_date: first,
      instalments_total: terms.instalment_count, idempotency_key: idempotencyKey,
      environment: agreement.environment || 'sandbox',
      dynamic_next_collection_date: first,
      metadata: { collection_mode: 'dynamic', dynamic_first_date: first, agreement_id: agreement.id },
    };
    const inserted = await db.from('membership_payment_plans').insert(row).select().single();
    if (inserted.error?.code === '23505') {
      plan = checked(await db.from('membership_payment_plans').select('*')
        .eq('tenant_id', agreement.tenant_id).eq('idempotency_key', idempotencyKey).single(), 'Reload dynamic plan');
    } else {
      plan = checked(inserted, 'Create dynamic plan'); created = true;
    }
  }
  const result = await collectDynamicPlan(plan, { ...deps, db, gc });
  return { created, plan: result.plan || plan, detail: result.detail };
}

export function createLiveDynamicCollectionEffects({ db, getGc }) {
  return { async perform(operation) {
    if (operation.type === 'dynamic.finish_schedule') {
      const { tenantId, planId, expectedDate } = operation.payload;
      return checked(await db.from('membership_payment_plans').update({ dynamic_next_collection_date: null })
        .eq('tenant_id', tenantId).eq('id', planId)
        .eq('dynamic_next_collection_date', expectedDate), 'Complete dynamic schedule');
    }
    if (operation.type !== 'dynamic.reserve_collection') throw new Error(`Unknown dynamic effect: ${operation.type}`);
    const { params, existing, plan, agreement, today, bnmsProcessing } = operation.payload;
    let reservation = checked(await db.rpc('reserve_gocardless_dynamic_collection', params),
      existing ? 'Authorize reserved dynamic collection' : 'Reserve dynamic collection');
    if (!existing) {
      if (bnmsProcessing && reservation.requested_charge_date < today) {
        throw new Error('BNMS pilot reserved charge date is in the past; reconcile before retry');
      }
      reservation = checked(await db.rpc('reserve_gocardless_dynamic_collection', {
        p_tenant_id: plan.tenant_id, p_plan_id: plan.id, p_collection_number: reservation.collection_number,
        p_due_date: reservation.due_date, p_price_snapshot: reservation.price_snapshot,
        p_provider_evidence: reservation.provider_evidence, p_idempotency_key: reservation.idempotency_key,
      }), 'Authorize reserved dynamic collection');
    }
    const client = await getGc(plan.tenant_id);
    const payment = await client.createPayment({
      mandateId: agreement.gocardless_mandate_id, amountMinor: reservation.amount_minor,
      currency: reservation.currency, chargeDate: reservation.requested_charge_date,
      description: `Membership ${agreement.metadata.dd.membership_year} monthly collection`,
      metadata: { tenant_id: plan.tenant_id, plan_id: plan.id, collection_reservation_id: reservation.id },
      idempotencyKey: reservation.idempotency_key,
    });
    assertDynamicPayment(reservation, payment, agreement.gocardless_mandate_id);
    await attachDynamicPayment(reservation, payment, { db });
    return { plan: { ...plan, amount_minor: reservation.amount_minor, next_charge_date: payment.charge_date }, detail: 'Dynamic collection scheduled with provider' };
  } };
}

export async function collectDynamicPlan(plan, { db = supabase, gc, now = () => new Date() } = {}) {
  const getGc = async tenantId => gc || (gc = await gocardlessForTenant(tenantId));
  return processDynamicCollection({ db, plan, now: now(), getGc,
    effects: createLiveDynamicCollectionEffects({ db, getGc }) });
}

export async function attachDynamicPayment(reservation, payment, { db = supabase } = {}) {
  return checked(await db.rpc('attach_gocardless_dynamic_payment', {
    p_tenant_id: reservation.tenant_id, p_reservation_id: reservation.id,
    p_payment: payment,
  }), 'Attach dynamic collection provider evidence');
}

export async function resolveDynamicPayment(paymentId, { db = supabase, gc } = {}) {
  const lookup = await db.from(DYNAMIC_RESERVATIONS).select('*').eq('gocardless_payment_id', paymentId).maybeSingle();
  if (['42P01', 'PGRST205'].includes(lookup.error?.code)) return null;
  let reservation = checked(lookup, 'Find dynamic payment reservation');
  let payment = null;
  if (!reservation && typeof gc?.getPayment === 'function' && !gc.gocardlessForTenant) {
    payment = await gc.getPayment(paymentId);
    const metadata = payment?.metadata;
    if (!metadata?.collection_reservation_id) return null;
    reservation = checked(await db.from(DYNAMIC_RESERVATIONS).select('*')
      .eq('id', metadata.collection_reservation_id).eq('tenant_id', metadata.tenant_id)
      .eq('plan_id', metadata.plan_id).maybeSingle(), 'Recover dynamic reservation');
    if (!reservation) throw new Error('Provider dynamic collection has no matching reservation');
  }
  if (!reservation) return null;
  const plan = checked(await db.from('membership_payment_plans').select('*')
    .eq('id', reservation.plan_id).eq('tenant_id', reservation.tenant_id).single(), 'Resolve dynamic payment plan');
  const client = typeof gc?.gocardlessForTenant === 'function'
    ? await gc.gocardlessForTenant(reservation.tenant_id, { db })
    : gc || await gocardlessForTenant(reservation.tenant_id, { db });
  payment ||= await client.getPayment(paymentId);
  assertDynamicPayment(reservation, payment, plan.gocardless_mandate_id);
  await attachDynamicPayment(reservation, payment, { db });
  return { plan, reservation, payment };
}

export async function reconcileDynamicCollections({ db = supabase, clientForTenant = gocardlessForTenant, now = () => new Date(), limit = 100, budgetMs = 45000, clock = Date.now } = {}) {
  if (budgetMs <= 0) return { processed: 0, blocked: 0 };
  const started = clock();
  const plans = checked(await selectDynamicCollections(db, now(), limit), 'Load due dynamic plans');
  const result = { processed: 0, blocked: 0 };
  for (const plan of plans || []) {
    const elapsed = clock() - started;
    if (elapsed >= budgetMs || ((result.processed + result.blocked) > 0 && budgetMs - elapsed < 30000)) break;
    const nextCheck = new Date(now().getTime() + 60 * 60 * 1000).toISOString();
    try {
      const client = await clientForTenant(plan.tenant_id);
      const getGc = async () => client;
      await runDynamicCollection({ db, plan, now: now(), getGc,
        effects: createLiveDynamicCollectionEffects({ db, getGc }) });
      checked(await db.from('membership_payment_plans').update({ dynamic_collection_error: null, dynamic_next_check_at: nextCheck })
        .eq('id', plan.id).eq('tenant_id', plan.tenant_id), 'Clear dynamic collection error');
      result.processed++;
    } catch (error) {
      checked(await db.from('membership_payment_plans').update({ dynamic_collection_error: String(error.message).slice(0, 1000), dynamic_next_check_at: nextCheck })
        .eq('id', plan.id).eq('tenant_id', plan.tenant_id), 'Record dynamic collection error');
      result.blocked++;
    }
  }
  return result;
}