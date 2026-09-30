import { isIP } from 'node:net';

export const STRIPE_MEMBERSHIP_WEBHOOK_EVENTS = Object.freeze([
  'payment_intent.succeeded',
  'checkout.session.completed',
  'invoice.paid',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
  'invoice.voided',
  'invoice.marked_uncollectible',
  'customer.subscription.deleted',
]);

export const CARD_PLAN_EVENT_TYPES = new Set(
  STRIPE_MEMBERSHIP_WEBHOOK_EVENTS.filter((type) => type !== 'payment_intent.succeeded'),
);

const CARD_PLAN_KIND = 'monthly_card_plan';

function isMembershipPaymentIntent(object) {
  const metadata = object?.metadata || {};
  return Boolean(
    metadata.tenant_id
    && metadata.membership_year
    && (metadata.member_id || metadata.organization_id)
    && !metadata.booking_id
    && !metadata.job_posting_id,
  );
}

function invoiceHasExplicitCardPlanMetadata(invoice) {
  const metadataCandidates = [
    invoice?.metadata,
    invoice?.subscription_details?.metadata,
    invoice?.parent?.subscription_details?.metadata,
    ...(invoice?.lines?.data || []).map((line) => line?.metadata),
  ];
  return metadataCandidates.some((metadata) => (
    metadata?.kind === CARD_PLAN_KIND || Boolean(metadata?.catch_up_intent_key)
  ));
}

export function selectStripeEventModeCredentials(event, credentials = {}) {
  if (typeof event?.livemode !== 'boolean') return null;
  return event.livemode
    ? {
        mode: 'live',
        signingSecret: credentials.membership_webhook_secret || null,
        apiKey: credentials.secret_key || null,
      }
    : {
        mode: 'test',
        signingSecret: credentials.test_membership_webhook_secret || null,
        apiKey: credentials.test_secret_key || null,
      };
}

function invoiceSubscriptionId(invoice) {
  const value = invoice?.parent?.subscription_details?.subscription
    ?? invoice?.subscription_details?.subscription
    ?? invoice?.subscription
    ?? null;
  return typeof value === 'string' ? value : value?.id || null;
}

/**
 * Classify a verified Stripe event before any payload is persisted. Invoice
 * ownership is always read from the authoritative Subscription using the
 * already mode-bound Stripe client; payload metadata is not trusted for it.
 */
export async function classifyStripeMembershipEventTenant(event, {
  expectedTenantId,
  stripe,
} = {}) {
  const type = event?.type;
  const object = event?.data?.object || {};
  let metadata;

  if (type === 'payment_intent.succeeded') {
    if (!isMembershipPaymentIntent(object)) return { status: 'irrelevant' };
    metadata = object.metadata;
  } else if (type === 'checkout.session.completed') {
    if (object?.mode !== 'subscription' || object?.metadata?.kind !== CARD_PLAN_KIND) {
      return { status: 'irrelevant' };
    }
    metadata = object.metadata;
  } else if (type === 'customer.subscription.deleted') {
    if (object?.metadata?.kind !== CARD_PLAN_KIND) return { status: 'irrelevant' };
    metadata = object.metadata;
  } else if (type?.startsWith('invoice.')) {
    const subscriptionId = invoiceSubscriptionId(object);
    if (!subscriptionId) {
      return invoiceHasExplicitCardPlanMetadata(object)
        ? { status: 'unknown', message: 'Stripe membership invoice has no subscription identity.' }
        : { status: 'irrelevant' };
    }
    if (!stripe?.subscriptions?.retrieve) {
      return { status: 'unavailable', message: 'The Stripe API key for this event mode is unavailable.' };
    }
    let subscription;
    try {
      subscription = await stripe.subscriptions.retrieve(subscriptionId);
    } catch {
      return { status: 'unavailable', message: 'Stripe subscription ownership could not be verified.' };
    }
    if (subscription?.metadata?.kind !== CARD_PLAN_KIND) return { status: 'irrelevant' };
    metadata = subscription?.metadata;
  } else {
    return { status: 'unknown', message: 'Stripe event type is not supported by this webhook.' };
  }

  const eventTenantId = typeof metadata?.tenant_id === 'string'
    ? metadata.tenant_id.trim()
    : '';
  if (!eventTenantId) {
    return { status: 'unknown', message: 'Stripe event has no tenant identity.' };
  }
  return eventTenantId === String(expectedTenantId)
    ? { status: 'own' }
    : { status: 'foreign' };
}

export function buildStripeMembershipWebhookUrl(baseUrl, tenantId) {
  let url;
  try {
    url = new URL('/api/webhooks/stripe-membership', baseUrl);
  } catch {
    throw new Error('A trusted production webhook host is not configured');
  }
  const hostname = url.hostname.toLowerCase();
  const unbracketedHostname = hostname.replace(/^\[|\]$/g, '');
  const configuredDevelopmentHost = String(process.env.REPLIT_DEV_DOMAIN || '')
    .trim()
    .toLowerCase();
  if (url.protocol !== 'https:'
      || !hostname
      || hostname === 'localhost'
      || hostname === '127.0.0.1'
      || unbracketedHostname === '::1'
      || isIP(unbracketedHostname) !== 0
      || hostname === configuredDevelopmentHost
      || hostname.endsWith('.replit.dev')
      || url.username
      || url.password) {
    throw new Error('A trusted production HTTPS webhook host is not configured');
  }
  url.search = new URLSearchParams({ tenant: tenantId }).toString();
  return url.toString();
}

function sameWebhookUrl(candidate, expected) {
  try {
    const actualUrl = new URL(candidate);
    const expectedUrl = new URL(expected);
    return actualUrl.origin === expectedUrl.origin
      && actualUrl.pathname === expectedUrl.pathname
      && actualUrl.search === expectedUrl.search;
  } catch {
    return false;
  }
}

function missingEvents(endpoint) {
  const enabledEvents = Array.isArray(endpoint?.enabled_events) ? endpoint.enabled_events : [];
  if (enabledEvents.includes('*')) return [];
  return STRIPE_MEMBERSHIP_WEBHOOK_EVENTS.filter((event) => !enabledEvents.includes(event));
}

export async function checkStripeMembershipWebhookConfiguration({
  stripe,
  mode,
  url,
  secretConfigured,
  maxPages = 10,
}) {
  const livemode = mode === 'live';
  if (!stripe) {
    return {
      mode,
      status: 'incomplete',
      url,
      secret_configured: secretConfigured,
      checks: {
        api_key_configured: false,
        endpoint_found: false,
        endpoint_enabled: false,
        events_complete: false,
      },
      missing_events: [...STRIPE_MEMBERSHIP_WEBHOOK_EVENTS],
      message: 'The Stripe API key for this mode is not configured.',
    };
  }

  let startingAfter;
  const matches = [];
  try {
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const page = await stripe.webhookEndpoints.list({
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      for (const endpoint of page?.data || []) {
        if (endpoint?.livemode === livemode && sameWebhookUrl(endpoint.url, url)) {
          matches.push(endpoint);
        }
      }
      if (!page?.has_more) {
        const best = matches.sort((a, b) => {
          const score = (endpoint) => (endpoint.status === 'enabled' ? 1000 : 0)
            - missingEvents(endpoint).length;
          return score(b) - score(a);
        })[0];
        const missing = best ? missingEvents(best) : [...STRIPE_MEMBERSHIP_WEBHOOK_EVENTS];
        const checks = {
          api_key_configured: true,
          endpoint_found: Boolean(best),
          endpoint_enabled: best?.status === 'enabled',
          events_complete: Boolean(best) && missing.length === 0,
        };
        const configured = secretConfigured && Object.values(checks).every(Boolean);
        return {
          mode,
          status: configured ? 'configured' : 'incomplete',
          url,
          secret_configured: secretConfigured,
          checks,
          missing_events: missing,
          message: configured
            ? 'The Stripe webhook endpoint is configured for this mode.'
            : 'The Stripe webhook configuration is incomplete. This does not verify that the saved signing secret matches Stripe or that events have been delivered.',
        };
      }
      startingAfter = page?.data?.at(-1)?.id;
      if (!startingAfter) throw new Error('Stripe returned an invalid paginated response');
    }
    return {
      mode,
      status: 'unavailable',
      url,
      secret_configured: secretConfigured,
      checks: {
        api_key_configured: true,
        endpoint_found: false,
        endpoint_enabled: false,
        events_complete: false,
      },
      missing_events: [...STRIPE_MEMBERSHIP_WEBHOOK_EVENTS],
      message: `Stripe returned more than ${maxPages * 100} webhook endpoints; configuration could not be checked safely.`,
    };
  } catch {
    return {
      mode,
      status: 'unavailable',
      url,
      secret_configured: secretConfigured,
      checks: {
        api_key_configured: true,
        endpoint_found: false,
        endpoint_enabled: false,
        events_complete: false,
      },
      missing_events: [...STRIPE_MEMBERSHIP_WEBHOOK_EVENTS],
      message: 'Stripe webhook configuration is currently unavailable.',
    };
  }
}