// Production clients are lazy: importing the amendment engine has no DB/network effects.
export async function monthlyStripeForTenant(tenantId, environment) {
  const [{ getStripeIntegrationCredentials }, { default: Stripe }] = await Promise.all([
    import('./stripeCredentials.js'), import('stripe'),
  ]);
  const credentials = await getStripeIntegrationCredentials(tenantId);
  const key = credentials?.[environment === 'test' ? 'test_secret_key' : 'secret_key'];
  if (!credentials?.is_enabled || !key) throw new Error('Recorded Stripe environment credentials are unavailable');
  return new Stripe(key, { maxNetworkRetries: 0, timeout: 15000 });
}

export async function monthlyGoCardlessForTenant(tenantId, environment) {
  const { gocardlessForTenant } = await import('./gocardless.js');
  const client = await gocardlessForTenant(tenantId);
  if (client.getGocardlessEnvironment() !== environment) {
    throw new Error('GoCardless credentials do not match the recorded agreement environment');
  }
  return client;
}

export async function allStripeInvoices(stripe, subscriptionId) {
  const rows = [];
  let cursor;
  const seen = new Set();
  for (;;) {
    const page = await stripe.invoices.list({ subscription: subscriptionId, limit: 100,
      ...(cursor ? { starting_after: cursor } : {}) });
    if (!Array.isArray(page.data)) throw new Error('Invalid Stripe invoice page');
    rows.push(...page.data);
    if (!page.has_more) return rows;
    cursor = page.data.at(-1)?.id;
    if (!cursor || seen.has(cursor)) throw new Error('Stripe invoice pagination did not advance');
    seen.add(cursor);
  }
}

export async function allStripeInvoicePayments(stripe, invoiceId) {
  const rows = [];
  const seen = new Set();
  let cursor;
  for (;;) {
    const page = await stripe.invoicePayments.list({ invoice: invoiceId, status: 'paid', limit: 100,
      ...(cursor ? { starting_after: cursor } : {}) });
    if (!Array.isArray(page.data)) throw new Error('Invalid Stripe invoice-payment page');
    rows.push(...page.data);
    if (!page.has_more) return rows;
    cursor = page.data.at(-1)?.id;
    if (!cursor || seen.has(cursor)) throw new Error('Stripe invoice-payment pagination did not advance');
    seen.add(cursor);
  }
}

export async function allGoCardlessPayments(gc, mandateId) {
  const rows = [];
  const seen = new Set();
  let after;
  for (;;) {
    const page = await gc.listPaymentsPage({ mandateId, limit: 100, after });
    if (!Array.isArray(page.payments)) throw new Error('Invalid GoCardless payment page');
    rows.push(...page.payments);
    if (!page.after) return rows;
    if (seen.has(page.after)) throw new Error('GoCardless payment pagination did not advance');
    seen.add(page.after);
    after = page.after;
  }
}
