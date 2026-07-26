// GoCardless service module (Task — GoCardless Phase 1).
//
// Single contained seam between application code and the GoCardless API
// (mirrors the accountingProvider.js style: no other module talks to the
// GoCardless HTTP surface directly). Server-only: credentials never reach
// the frontend.
//
// Credentials are PER TENANT (tenant_integrations, integration_type
// 'gocardless' — see gocardlessCredentials.js) with the platform-level
// GOCARDLESS_* env vars as fallback:
//   GOCARDLESS_ENVIRONMENT        'sandbox' (default) | 'live'
//   GOCARDLESS_ACCESS_TOKEN       API access token (sandbox or live — must
//                                 match GOCARDLESS_ENVIRONMENT)
//   GOCARDLESS_WEBHOOK_SECRET     webhook endpoint secret (HMAC-SHA256)
//   GOCARDLESS_REDIRECT_BASE_URL  base URL for Billing Request Flow
//                                 redirect/exit URIs
//   GOCARDLESS_CREDITOR_ID        optional creditor pin (multi-creditor accounts)
//
// Usage:
//   - Tenant-scoped (preferred): `const gc = await gocardlessForTenant(tenantId)`
//     then `gc.createBillingRequest(...)` etc.
//   - The top-level function exports operate on the platform env credentials
//     (fallback/single-account mode) and keep the same signatures.
//
// Conventions:
//   - All amounts are integer minor units (pence). Never floats.
//   - Every mutating call carries an Idempotency-Key. Deterministic keys
//     are built via buildIdempotencyKey() from stable local identifiers.
//   - Tokens are never logged; logGc() redacts anything token-shaped.

import crypto from 'node:crypto';
import { envGocardlessCredentials, getGocardlessCredentials } from './gocardlessCredentials.js';

const API_VERSION = '2015-07-06';
const DEFAULT_TIMEOUT_MS = 15_000;

export function getGocardlessEnvironment() {
  const env = (process.env.GOCARDLESS_ENVIRONMENT || 'sandbox').toLowerCase();
  return env === 'live' ? 'live' : 'sandbox';
}

export function isGocardlessConfigured() {
  return !!process.env.GOCARDLESS_ACCESS_TOKEN;
}

function baseUrlFor(creds) {
  return creds.environment === 'live'
    ? 'https://api.gocardless.com'
    : 'https://api-sandbox.gocardless.com';
}

function accessTokenFor(creds) {
  const token = creds.accessToken;
  if (!token) throw new Error('GoCardless access token is not configured');
  // Guardrail: sandbox tokens start with "sandbox_", live tokens with "live_".
  if (creds.environment === 'live' && token.startsWith('sandbox_')) {
    throw new Error('GoCardless environment=live but the access token is a sandbox token');
  }
  if (creds.environment === 'sandbox' && token.startsWith('live_')) {
    throw new Error('GoCardless environment=sandbox but the access token is a live token');
  }
  return token;
}

function redact(str) {
  if (!str) return str;
  return String(str)
    .replace(/(sandbox|live)_[A-Za-z0-9_-]+/g, '$1_[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
}

function logGc(msg, extra) {
  const safeExtra = extra === undefined ? '' : ` ${redact(typeof extra === 'string' ? extra : JSON.stringify(extra))}`;
  console.log(`[gocardless] ${redact(msg)}${safeExtra}`);
}

/**
 * Deterministic idempotency key from stable parts, e.g.
 *   buildIdempotencyKey('subscription', tenantId, planId)
 * Same inputs always produce the same key so a retried local operation
 * cannot double-create the remote resource.
 */
export function buildIdempotencyKey(...parts) {
  if (!parts.length || parts.some((p) => p === undefined || p === null || p === '')) {
    throw new Error('buildIdempotencyKey requires non-empty parts');
  }
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

export class GocardlessApiError extends Error {
  constructor(message, { status, type, errors, requestId } = {}) {
    super(message);
    this.name = 'GocardlessApiError';
    this.status = status || null;
    this.type = type || null;
    this.errors = errors || null;
    this.requestId = requestId || null;
  }
}

async function gcRequest(creds, method, path, { body, idempotencyKey, timeoutMs = DEFAULT_TIMEOUT_MS, query } = {}) {
  const url = new URL(baseUrlFor(creds) + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const headers = {
    Authorization: `Bearer ${accessTokenFor(creds)}`,
    'GoCardless-Version': API_VERSION,
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new GocardlessApiError(`GoCardless request timed out after ${timeoutMs}ms: ${method} ${path}`, {});
    }
    throw new GocardlessApiError(`GoCardless request failed: ${method} ${path}: ${redact(err.message)}`, {});
  } finally {
    clearTimeout(timer);
  }

  const requestId = res.headers.get('requestid') || res.headers.get('x-request-id') || null;
  let json = null;
  const text = await res.text();
  if (text) {
    try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
  }

  if (!res.ok) {
    // 409 idempotent_creation_conflict → fetch and return the original resource.
    const gcError = json?.error;
    const conflict = (gcError?.errors || []).find((e) => e.reason === 'idempotent_creation_conflict');
    if (res.status === 409 && conflict?.links) {
      const linkKey = Object.keys(conflict.links)[0];
      const existingId = conflict.links[linkKey];
      logGc(`idempotent conflict on ${method} ${path}; fetching existing ${linkKey}=${existingId}`);
      const resourcePath = path.replace(/\?.*$/, '');
      return gcRequest(creds, 'GET', `${resourcePath}/${existingId}`);
    }
    throw new GocardlessApiError(
      `GoCardless ${method} ${path} failed (${res.status}): ${redact(gcError?.message || text || res.statusText)}`,
      { status: res.status, type: gcError?.type, errors: gcError?.errors, requestId },
    );
  }
  return json;
}

// ---------------------------------------------------------------------------
// Client factory — every API method bound to one set of credentials
// ---------------------------------------------------------------------------

export function createGocardlessClient(creds) {
  const request = (method, path, opts) => gcRequest(creds, method, path, opts);

  return {
    credentials: { source: creds.source, tenantId: creds.tenantId || null, environment: creds.environment },
    getGocardlessEnvironment: () => creds.environment,
    isConfigured: () => !!creds.accessToken,

    // --- Billing Requests + Flows (hosted payment pages) ---

    /**
     * Create a Billing Request with a mandate request (and optional payment
     * request for a first collection). `metadata` should carry local linkage
     * (tenant_id, agreement_id) so webhooks can be resolved back.
     */
    async createBillingRequest({ idempotencyKey, mandateScheme = 'bacs', currency = 'GBP', paymentAmountMinor = null, paymentDescription = null, metadata = {} }) {
      const billing_requests = {
        mandate_request: { scheme: mandateScheme, currency },
        metadata,
      };
      if (creds.creditorId) {
        billing_requests.links = { creditor: creds.creditorId };
      }
      if (paymentAmountMinor != null) {
        if (!Number.isInteger(paymentAmountMinor) || paymentAmountMinor <= 0) {
          throw new Error('paymentAmountMinor must be a positive integer (minor units)');
        }
        billing_requests.payment_request = {
          amount: paymentAmountMinor,
          currency,
          description: paymentDescription || undefined,
        };
      }
      const json = await request('POST', '/billing_requests', { body: { billing_requests }, idempotencyKey });
      logGc(`created billing request ${json.billing_requests?.id}`);
      return json.billing_requests;
    },

    async getBillingRequest(billingRequestId) {
      const json = await request('GET', `/billing_requests/${billingRequestId}`);
      return json.billing_requests;
    },

    /**
     * Create a hosted Billing Request Flow for a billing request. Returns the
     * flow (including `authorisation_url` the payer is sent to).
     */
    async createBillingRequestFlow({ billingRequestId, redirectUri, exitUri, prefilledCustomer = null, idempotencyKey }) {
      const base = creds.redirectBaseUrl || '';
      const body = {
        billing_request_flows: {
          redirect_uri: redirectUri || (base ? `${base.replace(/\/$/, '')}/membership/direct-debit/complete` : undefined),
          exit_uri: exitUri || (base ? `${base.replace(/\/$/, '')}/membership/direct-debit/cancelled` : undefined),
          links: { billing_request: billingRequestId },
          ...(prefilledCustomer ? { prefilled_customer: prefilledCustomer } : {}),
        },
      };
      const json = await request('POST', '/billing_request_flows', { body, idempotencyKey });
      logGc(`created billing request flow for ${billingRequestId}`);
      return json.billing_request_flows;
    },

    // --- Subscriptions ---

    async createSubscription({ mandateId, amountMinor, currency = 'GBP', intervalUnit = 'monthly', dayOfMonth = null, name = null, startDate = null, count = null, metadata = {}, idempotencyKey }) {
      if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
        throw new Error('amountMinor must be a positive integer (minor units)');
      }
      if (!idempotencyKey) throw new Error('idempotencyKey is required for createSubscription');
      const subscriptions = {
        amount: amountMinor,
        currency,
        interval_unit: intervalUnit,
        links: { mandate: mandateId },
        metadata,
      };
      if (dayOfMonth != null) subscriptions.day_of_month = dayOfMonth;
      if (name) subscriptions.name = name;
      if (startDate) subscriptions.start_date = startDate;
      if (count != null) subscriptions.count = count;
      const json = await request('POST', '/subscriptions', { body: { subscriptions }, idempotencyKey });
      logGc(`created subscription ${json.subscriptions?.id} on mandate ${mandateId}`);
      return json.subscriptions;
    },

    async getSubscription(subscriptionId) {
      const json = await request('GET', `/subscriptions/${subscriptionId}`);
      return json.subscriptions;
    },

    async cancelSubscription(subscriptionId) {
      const json = await request('POST', `/subscriptions/${subscriptionId}/actions/cancel`, { body: {} });
      logGc(`cancelled subscription ${subscriptionId}`);
      return json.subscriptions;
    },

    async pauseSubscription(subscriptionId, { pauseCycles = null } = {}) {
      const body = { data: {} };
      if (pauseCycles != null) body.data.pause_cycles = pauseCycles;
      const json = await request('POST', `/subscriptions/${subscriptionId}/actions/pause`, { body });
      logGc(`paused subscription ${subscriptionId}`);
      return json.subscriptions;
    },

    async resumeSubscription(subscriptionId) {
      const json = await request('POST', `/subscriptions/${subscriptionId}/actions/resume`, { body: {} });
      logGc(`resumed subscription ${subscriptionId}`);
      return json.subscriptions;
    },

    // --- Mandates, customers, payments ---

    async getMandate(mandateId) {
      const json = await request('GET', `/mandates/${mandateId}`);
      return json.mandates;
    },

    async cancelMandate(mandateId) {
      const json = await request('POST', `/mandates/${mandateId}/actions/cancel`, { body: {} });
      logGc(`cancelled mandate ${mandateId}`);
      return json.mandates;
    },

    async getCustomer(customerId) {
      const json = await request('GET', `/customers/${customerId}`);
      return json.customers;
    },

    async getPayment(paymentId) {
      const json = await request('GET', `/payments/${paymentId}`);
      return json.payments;
    },

    async retryPayment(paymentId, { idempotencyKey } = {}) {
      const json = await request('POST', `/payments/${paymentId}/actions/retry`, { body: {}, idempotencyKey });
      logGc(`retried payment ${paymentId}`);
      return json.payments;
    },

    async listPayments({ subscriptionId, mandateId, limit = 50 } = {}) {
      const query = { limit };
      if (subscriptionId) query.subscription = subscriptionId;
      if (mandateId) query.mandate = mandateId;
      const json = await request('GET', '/payments', { query });
      return json.payments || [];
    },

    // --- Refunds (Phase 4) ---

    async createRefund({ paymentId, amountMinor, totalAmountConfirmationMinor, reference = null, metadata = {}, idempotencyKey }) {
      if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
        throw new Error('amountMinor must be a positive integer (minor units)');
      }
      if (!idempotencyKey) throw new Error('idempotencyKey is required for createRefund');
      const refunds = {
        amount: amountMinor,
        total_amount_confirmation: totalAmountConfirmationMinor ?? amountMinor,
        links: { payment: paymentId },
        metadata,
      };
      if (reference) refunds.reference = reference;
      const json = await request('POST', '/refunds', { body: { refunds }, idempotencyKey });
      logGc(`created refund ${json.refunds?.id} on payment ${paymentId}`);
      return json.refunds;
    },

    async getRefund(refundId) {
      const json = await request('GET', `/refunds/${refundId}`);
      return json.refunds;
    },

    async listRefunds({ paymentId, limit = 50 } = {}) {
      const query = { limit };
      if (paymentId) query.payment = paymentId;
      const json = await request('GET', '/refunds', { query });
      return json.refunds || [];
    },

    // --- Payouts (Phase 4 — finance/reconciliation) ---

    async getPayout(payoutId) {
      const json = await request('GET', `/payouts/${payoutId}`);
      return json.payouts;
    },

    async listPayoutItems({ payoutId, limit = 500 } = {}) {
      if (!payoutId) throw new Error('payoutId is required for listPayoutItems');
      const items = [];
      let after = null;
      for (let page = 0; page < 20; page++) {
        const query = { payout: payoutId, limit: Math.min(limit, 500) };
        if (after) query.after = after;
        const json = await request('GET', '/payout_items', { query });
        const batch = json.payout_items || [];
        items.push(...batch);
        after = json.meta?.cursors?.after || null;
        if (!after || batch.length === 0 || items.length >= limit) break;
      }
      return items;
    },
  };
}

/**
 * Tenant-scoped client: resolves the tenant's own GoCardless credentials
 * from tenant_integrations (falling back to platform env vars).
 */
export async function gocardlessForTenant(tenantId, deps = {}) {
  const creds = await getGocardlessCredentials(tenantId, deps);
  return createGocardlessClient(creds);
}

// ---------------------------------------------------------------------------
// Platform-env client (fallback/single-account mode) — the top-level
// function exports keep their original signatures and always read the
// CURRENT env vars (not a snapshot).
// ---------------------------------------------------------------------------

function envClient() {
  return createGocardlessClient(envGocardlessCredentials());
}

export const createBillingRequest = (args) => envClient().createBillingRequest(args);
export const getBillingRequest = (id) => envClient().getBillingRequest(id);
export const createBillingRequestFlow = (args) => envClient().createBillingRequestFlow(args);
export const createSubscription = (args) => envClient().createSubscription(args);
export const getSubscription = (id) => envClient().getSubscription(id);
export const cancelSubscription = (id) => envClient().cancelSubscription(id);
export const pauseSubscription = (id, opts) => envClient().pauseSubscription(id, opts);
export const resumeSubscription = (id) => envClient().resumeSubscription(id);
export const getMandate = (id) => envClient().getMandate(id);
export const cancelMandate = (id) => envClient().cancelMandate(id);
export const getCustomer = (id) => envClient().getCustomer(id);
export const getPayment = (id) => envClient().getPayment(id);
export const retryPayment = (id, opts) => envClient().retryPayment(id, opts);
export const listPayments = (opts) => envClient().listPayments(opts);
export const createRefund = (args) => envClient().createRefund(args);
export const getRefund = (id) => envClient().getRefund(id);
export const listRefunds = (opts) => envClient().listRefunds(opts);
export const getPayout = (id) => envClient().getPayout(id);
export const listPayoutItems = (opts) => envClient().listPayoutItems(opts);

// ---------------------------------------------------------------------------
// Webhook signature verification
// ---------------------------------------------------------------------------

/**
 * Verify a GoCardless `Webhook-Signature` header (HMAC-SHA256 hex digest of
 * the raw request body, keyed by the webhook endpoint secret).
 * Timing-safe. Returns boolean; never throws on bad input.
 *
 * @param {Buffer|string} rawBody
 * @param {string} signatureHeader
 * @param {string} [secret] defaults to GOCARDLESS_WEBHOOK_SECRET
 */
export function verifyWebhookSignature(rawBody, signatureHeader, secret = process.env.GOCARDLESS_WEBHOOK_SECRET) {
  if (!secret || !signatureHeader || rawBody == null) return false;
  try {
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const provided = String(signatureHeader).trim();
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(provided, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
