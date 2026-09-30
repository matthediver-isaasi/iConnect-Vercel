import { supabase } from './database.js';
import { decryptCredentials } from './stripeCredentials.js';
import { getTenantGocardlessCredentials } from './gocardlessCredentials.js';
import { createGocardlessClient } from './gocardless.js';
import { processStripeCardPlanEvent } from './stripeMonthlyCard.js';
import { processGocardlessEvent } from './gocardlessWebhookProcessor.js';
import { getTrustedBaseUrlForTenant } from './publicBaseUrl.js';

const MAX_LIST = 50;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CONFIRMED_GC_PAYMENT_STATUSES = new Set(['confirmed', 'paid_out']);
const TERMINAL_AGREEMENT_STATUSES = new Set([
  'cancelled', 'completed', 'expired', 'payment_plan_cancelled', 'payment_plan_completed',
]);
const DISCOVERABLE_STATUSES = [
  'payment_setup_required', 'mandate_pending', 'first_payment_pending',
];

function assertId(value, label = 'agreementId') {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    const error = new Error(`${label} is malformed`);
    error.status = 400;
    throw error;
  }
}

function fail(message, status = 409, code = 'RECOVERY_NOT_ALLOWED') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
}

function validTrustedBaseUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !!parsed.hostname
      ? parsed.origin : null;
  } catch {
    return null;
  }
}

function termsFor(agreement) {
  const raw = agreement.provider === 'stripe'
    ? agreement.metadata?.card : agreement.metadata?.dd;
  if (!raw) return null;
  return {
    kind: raw.kind || null,
    membershipYear: raw.membership_year || null,
    currency: raw.currency || null,
    monthlyAmountMinor: Number.isInteger(raw.monthly_amount_minor) ? raw.monthly_amount_minor : null,
    instalmentCount: Number.isInteger(raw.instalment_count) ? raw.instalment_count : null,
    activationRule: raw.activation_rule || null,
    invoicingMode: raw.invoicing_mode === 'per_instalment' ? 'per_instalment' : 'annual',
  };
}

function supportReason(agreement) {
  if (agreement.agreement_type !== 'member') return 'Only member monthly agreements are supported';
  if (!agreement.metadata?.form_submission_id) return 'Only form-originated monthly agreements are supported';
  if (agreement.provider === 'stripe' && agreement.metadata?.card?.kind === 'monthly_card') {
    return ['payment_setup_required', 'first_payment_pending', 'active'].includes(agreement.status)
      ? null : `Stripe agreement status ${agreement.status || 'unknown'} is outside the validated recovery path`;
  }
  if (agreement.provider === 'gocardless'
      && agreement.metadata?.dd?.kind === 'monthly_direct_debit') {
    return ['mandate_pending', 'first_payment_pending', 'active'].includes(agreement.status)
      ? null : `GoCardless agreement status ${agreement.status || 'unknown'} is outside the validated recovery path`;
  }
  return 'This is not a validated form-originated monthly agreement';
}

async function loadAgreement(db, tenantId, agreementId) {
  assertId(agreementId);
  const { data, error } = await db.from('membership_billing_agreements')
    .select('id,tenant_id,member_id,agreement_type,provider,status,environment,created_at,metadata,stripe_checkout_session_id,stripe_subscription_id,gocardless_billing_request_id,gocardless_mandate_id')
    .eq('tenant_id', tenantId).eq('id', agreementId).maybeSingle();
  if (error) throw new Error('Failed to load monthly agreement');
  if (!data) fail('Monthly agreement not found', 404, 'NOT_FOUND');
  if (!['stripe', 'gocardless'].includes(data.provider)
      || !['test', 'live', 'sandbox'].includes(data.environment)) {
    fail('Agreement provider or environment is unsupported', 409, 'UNSUPPORTED_AGREEMENT');
  }
  return data;
}

async function loadLocalEvidence(db, agreement) {
  const { data: plans, error: planError } = await db.from('membership_payment_plans')
    .select('id,status,provider,amount_minor,currency,instalments_paid,last_payment_id,last_payment_status,gocardless_subscription_id,stripe_subscription_id')
    .eq('tenant_id', agreement.tenant_id).eq('billing_agreement_id', agreement.id)
    .order('created_at', { ascending: false }).limit(1);
  if (planError) throw new Error('Failed to load local payment plan');
  const plan = plans?.[0] || null;

  const { data: histories, error: historyError } = await db.from('member_membership_history')
    .select('id,status,payment_status,billing_agreement_id')
    .eq('tenant_id', agreement.tenant_id).eq('billing_agreement_id', agreement.id).limit(1);
  if (historyError) throw new Error('Failed to load local membership history');

  const formSubmissionId = agreement.metadata?.form_submission_id;
  const { data: submission, error: submissionError } = await db.from('form_submission')
    .select('id,payment_provider,payment_reference,payment_meta')
    .eq('tenant_id', agreement.tenant_id).eq('id', formSubmissionId).maybeSingle();
  if (submissionError) throw new Error('Failed to verify originating form submission');
  if (!submission) fail('Originating form submission does not belong to this tenant', 409, 'FORM_OWNERSHIP_MISMATCH');
  const expectedProvider = agreement.provider === 'stripe'
    ? 'stripe_monthly_card' : 'gocardless_monthly_dd';
  const association = agreement.provider === 'stripe'
    ? submission.payment_meta?.monthly_card : submission.payment_meta?.monthly_direct_debit;
  const providerReference = agreement.provider === 'stripe'
    ? agreement.stripe_checkout_session_id : agreement.gocardless_billing_request_id;
  if (submission.payment_provider !== expectedProvider
      || String(association?.agreement_id || '') !== String(agreement.id)
      || (association && providerReference
        && ![association.checkout_session_id, association.billing_request_id, submission.payment_reference]
          .filter(Boolean).includes(providerReference))) {
    fail('Form submission association does not match this agreement', 409, 'FORM_OWNERSHIP_MISMATCH');
  }

  let recordedInstalments = 0;
  let accountingIncomplete = false;
  let accountingUnavailable = false;
  if (plan) {
    const table = agreement.provider === 'stripe'
      ? 'membership_instalment_invoices' : 'gocardless_payments';
    const { count, error } = await db.from(table)
      .select('id', { count: 'exact', head: true }).eq('plan_id', plan.id);
    if (error) throw new Error('Failed to load local instalment records');
    recordedInstalments = count || 0;
    const accountingFields = agreement.provider === 'stripe'
      ? 'external_payment_id,accounting_sync_status'
      : 'gocardless_payment_id,status,accounting_sync_status';
    const { data: accountingRows, error: accountingError } = await db.from(table)
      .select(accountingFields).eq('plan_id', plan.id)
      .order('created_at', { ascending: false }).limit(20);
    if (accountingError) throw new Error('Failed to load local instalment accounting status');
    if (termsFor(agreement)?.invoicingMode === 'per_instalment') {
      accountingUnavailable = (accountingRows || []).some(
        (row) => row.accounting_sync_status === 'skipped',
      );
      accountingIncomplete = (accountingRows || []).some((row) => (
        (agreement.provider === 'stripe' || CONFIRMED_GC_PAYMENT_STATUSES.has(row.status))
        && !['posted', 'skipped'].includes(row.accounting_sync_status)
      ));
      if (agreement.provider === 'stripe'
          && Number(plan.instalments_paid || 0) > (accountingRows || []).length) {
        accountingIncomplete = true;
      }
    }
  }
  return {
    plan,
    history: histories?.[0] || null,
    submission,
    recordedInstalments,
    accountingIncomplete,
    accountingUnavailable,
  };
}

export function localRecoveryObligationsIncomplete(_agreement, local) {
  return !local?.plan
    || !local?.history
    || !['partial', 'paid'].includes(local.history.payment_status)
    || local.plan.status === 'first_payment_pending'
    || local.accountingIncomplete;
}

async function defaultStripeConnection(db, tenantId, environment) {
  const { data, error } = await db.from('tenant_integrations')
    .select('credentials,is_enabled').eq('tenant_id', tenantId)
    .eq('integration_type', 'stripe').maybeSingle();
  if (error) throw new Error('Failed to load Stripe connection');
  if (!data?.is_enabled || !data.credentials) fail('Stripe integration is disabled', 409, 'INTEGRATION_DISABLED');
  const credentials = decryptCredentials(data.credentials);
  const key = environment === 'test' ? credentials.test_secret_key : credentials.secret_key;
  const expectedPrefix = environment === 'test' ? 'sk_test_' : 'sk_live_';
  if (!key || !key.startsWith(expectedPrefix)) {
    fail(`No Stripe ${environment} credentials match this agreement`, 409, 'PROVIDER_ENVIRONMENT_MISMATCH');
  }
  const Stripe = (await import('stripe')).default;
  return {
    client: new Stripe(key),
    hasMatchingWebhookSecret: !!(environment === 'test'
      ? credentials.test_membership_webhook_secret : credentials.membership_webhook_secret),
  };
}

async function defaultGcConnection(db, tenantId, environment) {
  const credentials = await getTenantGocardlessCredentials(tenantId, { db });
  if (credentials.environment !== environment) {
    fail(`GoCardless connection is ${credentials.environment}, but agreement is ${environment}`, 409, 'PROVIDER_ENVIRONMENT_MISMATCH');
  }
  return { client: createGocardlessClient(credentials) };
}

function verifyFormOwnership(agreement, metadata, { requireTenant = true } = {}) {
  const submissionId = String(agreement.metadata.form_submission_id);
  if ((requireTenant && metadata?.tenant_id !== String(agreement.tenant_id))
      || metadata?.agreement_id !== String(agreement.id)
      || metadata?.form_submission_id !== submissionId) {
    fail('Provider metadata does not belong to this tenant and agreement', 409, 'PROVIDER_OWNERSHIP_MISMATCH');
  }
}

async function inspectStripe({ agreement, connection }) {
  assertId(agreement.stripe_checkout_session_id, 'Stripe checkout session ID');
  const session = await connection.client.checkout.sessions.retrieve(
    agreement.stripe_checkout_session_id,
    { expand: ['subscription.latest_invoice'] },
  );
  verifyFormOwnership(agreement, session.metadata);
  if (session.livemode !== (agreement.environment === 'live')) {
    fail('Stripe resource environment does not match the agreement', 409, 'PROVIDER_ENVIRONMENT_MISMATCH');
  }
  if (session.mode !== 'subscription' || session.metadata?.kind !== 'monthly_card') {
    fail('Stripe checkout is not a monthly membership subscription', 409, 'UNSUPPORTED_PROVIDER_RESOURCE');
  }
  const invoice = typeof session.subscription?.latest_invoice === 'object'
    ? session.subscription.latest_invoice : null;
  const complete = session.status === 'complete' && !!session.subscription;
  return {
    session,
    safe: {
      setupStatus: session.status || 'unknown',
      subscriptionStatus: session.subscription?.status || null,
      latestInvoiceStatus: invoice?.status || null,
      latestInvoicePaid: invoice?.paid === true || invoice?.status === 'paid',
    },
    canResume: complete,
    proposedWork: complete
      ? ['Replay the validated Stripe checkout completion through the existing monthly-plan processor']
      : [],
    warnings: connection.hasMatchingWebhookSecret
      ? [] : [`Stripe ${agreement.environment} membership webhook signing secret is missing`],
  };
}

async function inspectGc({ agreement, connection, local }) {
  assertId(agreement.gocardless_billing_request_id, 'GoCardless billing request ID');
  const request = await connection.client.getBillingRequest(agreement.gocardless_billing_request_id);
  // GoCardless Billing Request metadata is capped and intentionally contains
  // only these three ownership fields. Tenant ownership is independently
  // proven by the tenant-scoped form submission and tenant-owned credentials.
  verifyFormOwnership(agreement, request.metadata, { requireTenant: false });
  if (request.metadata?.type !== 'form_monthly_direct_debit') {
    fail('GoCardless request is not a monthly membership request', 409, 'UNSUPPORTED_PROVIDER_RESOURCE');
  }
  const mandateId = request.links?.mandate_request_mandate || agreement.gocardless_mandate_id || null;
  const mandate = mandateId ? await connection.client.getMandate(mandateId) : null;
  const paymentId = request.links?.payment_request_payment || null;
  const payment = paymentId ? await connection.client.getPayment(paymentId) : null;
  const paymentMatchesPlan = (candidate) => !!(
    local.plan
    && CONFIRMED_GC_PAYMENT_STATUSES.has(candidate?.status)
    && (!candidate.links?.subscription
      || candidate.links.subscription === local.plan.gocardless_subscription_id)
    && (!candidate.links?.mandate || !mandateId || candidate.links.mandate === mandateId)
    && Number(candidate.amount) === Number(local.plan.amount_minor)
    && String(candidate.currency || '').toUpperCase() === String(local.plan.currency || '').toUpperCase()
    // A confirmed mirror/plan marker is not sufficient proof that downstream
    // membership progress completed. Re-enter the shared idempotent processor
    // while either the agreement, plan, or history obligation is incomplete.
    && (local.plan.last_payment_id !== candidate.id
      || !CONFIRMED_GC_PAYMENT_STATUSES.has(local.plan.last_payment_status)
      || agreement.status === 'first_payment_pending'
      || local.plan.status === 'first_payment_pending'
      || local.history?.payment_status !== 'paid'
      || local.accountingIncomplete)
  );
  let replayPayment = paymentMatchesPlan(payment) ? payment : null;
  if (local.plan?.gocardless_subscription_id && connection.client.listPayments) {
    const providerPayments = await connection.client.listPayments({
      subscriptionId: local.plan.gocardless_subscription_id,
      limit: 20,
    });
    const confirmed = (providerPayments || []).find(paymentMatchesPlan);
    if (confirmed) replayPayment = confirmed;
  }
  const fulfilled = request.status === 'fulfilled';
  const mandateActive = ['active', 'reinstated'].includes(mandate?.status);
  const canResume = fulfilled && mandateActive;
  const proposedWork = canResume
    ? ['Replay the validated GoCardless billing-request fulfilment through the existing monthly-plan processor']
    : [];
  if (canResume && payment && CONFIRMED_GC_PAYMENT_STATUSES.has(payment.status)) {
    proposedWork.push('Replay the verified confirmed initial payment through the existing payment processor if a plan exists');
  }
  return {
    request,
    mandate,
    payment,
    safe: {
      setupStatus: request.status || 'unknown',
      mandateStatus: mandate?.status || null,
      nextPossibleChargeDate: mandate?.next_possible_charge_date || null,
      initialPaymentStatus: payment?.status || null,
      recoverablePaymentStatus: replayPayment?.status || null,
    },
    canResume,
    proposedWork,
    warnings: fulfilled && !mandateActive
      ? ['The GoCardless mandate is not active; recovery is read-only while provider setup is waiting']
      : [],
    replayPayment,
  };
}

function requireHandledOutcome(outcome, operation) {
  const detail = typeof outcome?.detail === 'string' && outcome.detail.length <= 500
    ? outcome.detail : null;
  if (outcome?.conflict) {
    fail(
      detail ? `${operation} found a membership conflict: ${detail}` : `${operation} found a membership conflict`,
      409,
      outcome.code || 'MEMBERSHIP_CONFLICT',
    );
  }
  if (outcome?.blocked) {
    fail(
      detail ? `${operation} was blocked: ${detail}` : `${operation} was blocked`,
      409,
      outcome.code || 'RECOVERY_BLOCKED',
    );
  }
  if (outcome?.retryable) {
    fail(
      detail ? `${operation} is not complete yet: ${detail}` : `${operation} is not complete yet; retry after resolving the provider or form state`,
      503,
      outcome.code || 'RECOVERY_RETRYABLE',
    );
  }
  if (outcome?.handled !== true) {
    fail(
      detail ? `${operation} was not applied: ${detail}` : `${operation} was not applied`,
      outcome?.retryable === false ? 409 : 502,
      outcome?.code || 'RECOVERY_NOT_HANDLED',
    );
  }
  return outcome;
}

export function createMonthlyMembershipRecoveryService({
  db = supabase,
  stripeConnection = defaultStripeConnection,
  gcConnection = defaultGcConnection,
  processStripe = processStripeCardPlanEvent,
  processGc = processGocardlessEvent,
  baseUrl = '',
  resolveTrustedBaseUrl = (tenantId) => getTrustedBaseUrlForTenant(null, db, tenantId),
} = {}) {
  if (!db) throw new Error('Database not configured');

  async function list(tenantId, requestedLimit = 25) {
    const limit = Math.min(Math.max(Number(requestedLimit) || 25, 1), MAX_LIST);
    const { data, error } = await db.from('membership_billing_agreements')
      .select('id,agreement_type,provider,status,environment,created_at,metadata')
      .eq('tenant_id', tenantId)
      .eq('agreement_type', 'member')
      .in('status', DISCOVERABLE_STATUSES)
      .not('metadata->>form_submission_id', 'is', null)
      .or('and(provider.eq.stripe,metadata->card->>kind.eq.monthly_card),and(provider.eq.gocardless,metadata->dd->>kind.eq.monthly_direct_debit)')
      .order('created_at', { ascending: false }).limit(limit);
    if (error) throw new Error('Failed to load monthly recovery agreements');
    return {
      agreements: (data || []).filter((row) => row.metadata?.form_submission_id).map((row) => ({
        id: row.id,
        provider: row.provider,
        status: row.status,
        environment: row.environment,
        createdAt: row.created_at,
        terms: termsFor(row),
        supported: !supportReason(row),
        unsupportedReason: supportReason(row),
      })),
      limit,
    };
  }

  async function preview(tenantId, agreementId) {
    const agreement = await loadAgreement(db, tenantId, agreementId);
    const unsupportedReason = supportReason(agreement);
    const local = await loadLocalEvidence(db, agreement);
    if (unsupportedReason) {
      return {
        agreement: { id: agreement.id, provider: agreement.provider, status: agreement.status, environment: agreement.environment },
        terms: termsFor(agreement), supported: false, unsupportedReason,
        canResume: false, provider: null, local: {
          hasPlan: !!local.plan, planStatus: local.plan?.status || null,
          historyStatus: local.history?.status || null,
          paymentStatus: local.history?.payment_status || null,
          recordedInstalments: local.recordedInstalments,
          accountingIncomplete: local.accountingIncomplete,
           accountingUnavailable: local.accountingUnavailable,
        }, proposedWork: [], warnings: [],
      };
    }
    const connection = agreement.provider === 'stripe'
      ? await stripeConnection(db, tenantId, agreement.environment)
      : await gcConnection(db, tenantId, agreement.environment);
    const inspection = agreement.provider === 'stripe'
      ? await inspectStripe({ agreement, connection })
      : await inspectGc({ agreement, connection, local });
    const terminal = TERMINAL_AGREEMENT_STATUSES.has(agreement.status);
    const localObligationsIncomplete = localRecoveryObligationsIncomplete(agreement, local);
    const scheduleDisclosure = agreement.provider === 'gocardless'
      && !local.plan && ['active', 'reinstated'].includes(inspection.mandate?.status);
    return {
      agreement: { id: agreement.id, provider: agreement.provider, status: agreement.status, environment: agreement.environment },
      terms: termsFor(agreement),
      supported: true,
      canResume: inspection.canResume && !terminal
        && (agreement.status !== 'active' || localObligationsIncomplete),
      provider: inspection.safe,
      local: {
        hasPlan: !!local.plan, planStatus: local.plan?.status || null,
        historyStatus: local.history?.status || null,
        paymentStatus: local.history?.payment_status || null,
        recordedInstalments: local.recordedInstalments,
        accountingIncomplete: local.accountingIncomplete,
        accountingUnavailable: local.accountingUnavailable,
      },
      proposedWork: inspection.proposedWork,
      warnings: [
        ...inspection.warnings,
        ...(local.accountingUnavailable
          ? ['Per-instalment accounting was skipped because no accounting provider is connected; configure accounting before attempting accounting recovery']
          : []),
        ...(terminal ? ['This agreement is terminal and cannot be resumed'] : []),
      ],
      confirmationDisclosure: scheduleDisclosure
        ? 'Confirmation may create the consented GoCardless monthly collection schedule because the mandate is active or reinstated and no local plan exists.'
        : 'Confirmation only replays validated provider events through the existing idempotent monthly-plan processors. It does not manually mark payments paid or create an extra charge.',
    };
  }

  async function resume(tenantId, agreementId, confirmed, { trustedBaseUrl = null } = {}) {
    if (confirmed !== true) fail('confirmed must be true', 400, 'CONFIRMATION_REQUIRED');
    // Re-fetch and re-inspect all local and provider evidence. A prior preview is
    // deliberately not trusted as authorization for a mutation.
    const agreement = await loadAgreement(db, tenantId, agreementId);
    if (TERMINAL_AGREEMENT_STATUSES.has(agreement.status)) {
      fail('Terminal monthly agreements cannot be resumed', 409, 'TERMINAL_AGREEMENT');
    }
    if (supportReason(agreement)) fail(supportReason(agreement), 409, 'UNSUPPORTED_AGREEMENT');
    const localBefore = await loadLocalEvidence(db, agreement);
    const connection = agreement.provider === 'stripe'
      ? await stripeConnection(db, tenantId, agreement.environment)
      : await gcConnection(db, tenantId, agreement.environment);
    const inspection = agreement.provider === 'stripe'
      ? await inspectStripe({ agreement, connection })
      : await inspectGc({ agreement, connection, local: localBefore });
    if (!inspection.canResume) {
      return { resumed: false, waiting: true, providerStatus: inspection.safe.setupStatus };
    }
    if (agreement.status === 'active'
        && !localRecoveryObligationsIncomplete(agreement, localBefore)) {
      return {
        resumed: false,
        waiting: false,
        alreadyComplete: true,
        outcome: 'This active agreement has no incomplete local recovery obligations.',
      };
    }
    const replayBaseUrl = validTrustedBaseUrl(
      trustedBaseUrl || baseUrl || await resolveTrustedBaseUrl(tenantId),
    );
    if (!replayBaseUrl) {
      fail(
        'A trusted canonical tenant URL is required before monthly recovery can run',
        503,
        'TRUSTED_BASE_URL_UNAVAILABLE',
      );
    }

    if (agreement.provider === 'stripe') {
      const outcome = requireHandledOutcome(await processStripe({
        id: `admin-recovery-checkout-${inspection.session.id}`,
        type: 'checkout.session.completed',
        data: { object: inspection.session },
      }, { db, getStripe: async () => connection.client, baseUrl: replayBaseUrl }), 'Stripe monthly recovery');
      return { resumed: true, waiting: false, outcome: outcome.detail || null };
    }

    const request = inspection.request;
    const outcome = requireHandledOutcome(await processGc({
      id: `admin-recovery-request-${request.id}`,
      resource_type: 'billing_requests',
      action: 'fulfilled',
      links: {
        billing_request: request.id,
        mandate_request_mandate: request.links?.mandate_request_mandate || null,
        customer: request.links?.customer || null,
        payment_request_payment: request.links?.payment_request_payment || null,
      },
    }, { db, gc: connection.client, baseUrl: replayBaseUrl }), 'GoCardless agreement recovery');

    const payment = inspection.replayPayment;
    if (payment && CONFIRMED_GC_PAYMENT_STATUSES.has(payment.status)) {
      const localAfter = localBefore.plan ? localBefore : await loadLocalEvidence(db, agreement);
      if (localAfter.plan) {
        if (payment.links?.mandate && request.links?.mandate_request_mandate
            && payment.links.mandate !== request.links.mandate_request_mandate) {
          fail('Confirmed payment mandate does not match the agreement', 409, 'PROVIDER_OWNERSHIP_MISMATCH');
        }
        requireHandledOutcome(await processGc({
          id: `admin-recovery-payment-${payment.id}`,
          resource_type: 'payments',
          action: 'confirmed',
          links: {
            payment: payment.id,
            subscription: payment.links?.subscription || localAfter.plan.gocardless_subscription_id || null,
          },
        }, { db, gc: connection.client, baseUrl: replayBaseUrl }), 'GoCardless confirmed payment recovery');
        if (payment.status === 'paid_out') {
          requireHandledOutcome(await processGc({
            id: `admin-recovery-payment-paid-out-${payment.id}`,
            resource_type: 'payments',
            action: 'paid_out',
            links: {
              payment: payment.id,
              subscription: payment.links?.subscription || localAfter.plan.gocardless_subscription_id || null,
            },
          }, { db, gc: connection.client, baseUrl: replayBaseUrl }), 'GoCardless paid-out accounting recovery');
        }
      }
    }
    return { resumed: true, waiting: false, outcome: outcome.detail || null };
  }

  return { list, preview, resume };
}

export { MAX_LIST };