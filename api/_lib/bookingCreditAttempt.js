import { createHash, randomUUID } from 'node:crypto';
import { getSessionMember } from './session.js';
import { resolveTenantFromRequest } from './tenantResolver.js';

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().filter(k => !k.startsWith('_')).map(k => [k, canonical(value[k])]))
    : value;
export function bookingAttemptFingerprint(body) {
  return createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex');
}
export function bookingCreditInvoiceInput(input) {
  const { paymentIntent, booker, ...rest } = input;
  const evidence = paymentIntent ? { ...paymentIntent } : null;
  if (evidence) delete evidence.client_secret;
  return { ...rest, paymentIntent: evidence, booker: booker ? {
    id: booker.id, first_name: booker.first_name, last_name: booker.last_name, email: booker.email,
  } : null };
}
export async function continueBookingCreditInvoice(db, tenantId, purchaseKey) {
  const { data: a, error } = await db.from('booking_credit_attempt').select('*')
    .eq('tenant_id', tenantId).eq('purchase_key', purchaseKey).single();
  if (error) throw new Error('Booking invoice continuation could not be loaded');
  if (a.state !== 'committed' || a.invoice_state === 'complete') return a.response;
  const input = a.funding?.invoiceInput;
  let invoice = { status: 'not_applicable' };
  if (input && Number(input.amount) > 0) {
    const { enqueueCheckoutEventInvoice, simpleEventInvoiceLines, complexEventInvoiceLines } =
      await import('./eventInvoiceProducer.js');
    const lineInput = { ...input.lineInput, voucherFunding: a.funding.voucherFunding || [] };
    invoice = await enqueueCheckoutEventInvoice({ ...input, db, tenantId, source: a.source,
      now: new Date(a.created_at),
      bookingGroupReference: purchaseKey,
      buildLines: code => a.source === 'booking'
        ? simpleEventInvoiceLines(lineInput, code) : complexEventInvoiceLines(lineInput, code),
    });
  }
  const response = { ...a.response, invoice_recovery: invoice };
  const update = await db.from('booking_credit_attempt').update({ response,
    invoice_state: invoice.queued || invoice.status === 'not_applicable' ? 'complete' : 'pending',
  }).eq('tenant_id', tenantId).eq('purchase_key', purchaseKey).eq('state','committed');
  if (update.error) throw new Error('Booking invoice continuation status could not be saved');
  return response;
}
async function rpc(db, action, args) {
  const result = await db.rpc(`booking_credit_${action}`, args);
  if (result.error) throw Object.assign(new Error(result.error.message), {
    statusCode: 409, definitiveRollback: ['P0001','23503','23505','23514','42501'].includes(result.error.code)
      && !/fence|already processing|request changed/i.test(result.error.message || ''),
  });
  return result.data;
}
export async function runBookingCreditAttempt({ db, req, body, source, work }) {
  const ids = source === 'booking' ? body.selectedVoucherIds : body.selected_voucher_ids;
  if (!Array.isArray(ids) || !ids.length) return work();
  if (body._testMode) throw Object.assign(new Error('Test-mode payment cannot fund a credit booking'), { statusCode: 403 });
  const tenant = await resolveTenantFromRequest(req);
  const member = await getSessionMember(req);
  if (!tenant?.id || !member?.id) throw Object.assign(new Error('Sign in to use booking credit'), { statusCode: 401 });
  const requestId = body.purchase_request_id;
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(requestId)) {
    throw Object.assign(new Error('A stable purchase request identifier is required'), { statusCode: 400 });
  }
  const key = `BCR-${createHash('sha256').update(`${tenant.id}:${source}:${member.id}:${requestId}`).digest('hex').slice(0,40)}`;
  const fence = randomUUID();
  const args = { p_tenant_id: tenant.id, p_purchase_key: key, p_fence: fence };
  const attempt = await rpc(db, 'begin', { ...args, p_member_id: member.id, p_source: source,
    p_fingerprint: bookingAttemptFingerprint(body) });
  if (attempt.response) return continueBookingCreditInvoice(db, tenant.id, key);
  req.bookingCreditAttempt = { ...args, key, memberId: member.id, source };
  try {
    const result = await work();
    const finished = await rpc(db, 'finish', { ...args, p_response: result, p_success: result?.success === true });
    return finished?.success ? continueBookingCreditInvoice(db, tenant.id, key) : finished;
  } catch (error) {
    // Finalize is a single SQL transaction. An ambiguous transport failure may
    // have committed; finish returns the committed response instead of refunding
    // a successful purchase. An expired fence can never finalize a new attempt.
    const result = await rpc(db, 'finish', { ...args,
      p_response: { success: false, error: error.message }, p_success: false });
    if (result?.success) return continueBookingCreditInvoice(db, tenant.id, key);
    throw error;
  } finally {
    delete req.bookingCreditAttempt;
  }
}
export async function finalizeBookingCredit(db, attempt, { eventId, rows, funding }) {
  return rpc(db, 'finalize', {
    p_tenant_id: attempt.p_tenant_id, p_purchase_key: attempt.key, p_fence: attempt.p_fence,
    p_event_id: eventId, p_rows: rows, p_funding: funding,
  });
}
export async function reverseBookingCredit(db, attempt, providerOutcome) {
  return rpc(db, 'reverse', { p_tenant_id: attempt.p_tenant_id, p_purchase_key: attempt.key,
    p_fence: attempt.p_fence, p_provider_outcome: providerOutcome });
}
