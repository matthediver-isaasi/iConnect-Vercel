// Accounting writes require explicit source and destination mode authority.
// Xero has no isolated sandbox endpoint; a demo company is still real Xero.
export function instalmentSourceMode(environment) {
  if (environment === 'live') return 'live';
  if (environment === 'test' || environment === 'sandbox') return 'test';
  throw new Error('Instalment accounting requires an explicit provider environment');
}

export function assertInstalmentAccountingMode({ agreement, providerName, accountingEnvironment }) {
  const sourceMode = instalmentSourceMode(agreement?.environment);
  const destinationMode = providerName === 'xero' ? 'live'
    : providerName === 'quickbooks' && accountingEnvironment === 'production' ? 'live'
      : providerName === 'quickbooks' && accountingEnvironment === 'sandbox' ? 'test' : null;
  if (!destinationMode || sourceMode !== destinationMode) {
    throw new Error('Instalment provider mode does not match the accounting environment; accounting write blocked');
  }
}

export async function assertInstalmentProviderMode(agreement, provider) {
  const connection = provider?.name === 'quickbooks'
    ? await provider.getRawAccessToken?.(agreement.tenant_id) : null;
  assertInstalmentAccountingMode({
    agreement, providerName: provider?.name, accountingEnvironment: connection?.environment,
  });
  return connection ? { environment: connection.environment, quickbooks_realm_id: connection.realmId } : null;
}

export function assertAccountingCustomerIdentity({ name, email, member = false }) {
  const normalizedName = String(name || '').trim();
  const normalizedEmail = String(email || '').trim();
  if (!normalizedName || (member && !normalizedEmail)
    || /^(deleted|anonymi[sz]ed)(?:\s+member)?$/i.test(normalizedName)
    || /^deleted_.*@deleted\.local$/i.test(normalizedEmail)) {
    throw new Error('Missing or anonymised customer identity; accounting write blocked');
  }
}

// Query the current tenant-owned identity even on linked-invoice payment retries.
// Never revive an anonymised customer using an old purchaser/address snapshot.
export async function resolveInstalmentCustomerIdentity({ agreement, db }) {
  if (!agreement?.tenant_id) throw new Error('Instalment customer tenant is required');
  const member = !!agreement.member_id;
  const table = member ? 'member' : 'organization';
  const id = member ? agreement.member_id : agreement.organization_id;
  if (!id) throw new Error('agreement has neither member nor organisation');
  const { data, error } = await db.from(table)
    .select(member ? 'first_name, last_name, email' : 'name, invoicing_email')
    .eq('id', id).eq('tenant_id', agreement.tenant_id).maybeSingle();
  if (error) throw new Error(`load ${table} failed: ${error.message}`);
  if (!data) throw new Error(`Instalment ${table} identity not found in agreement tenant`);
  const name = member ? [data.first_name, data.last_name].filter(Boolean).join(' ') : data.name;
  const email = member ? data.email : data.invoicing_email;
  assertAccountingCustomerIdentity({ name, email, member });
  return { contactName: name.trim(), invoicingEmail: email?.trim() || null,
    entityId: id, entityType: table };
}

export function assertDdInstalmentPaymentEvidence({ agreement, payment, expectedPayment = payment }) {
  const mode = instalmentSourceMode(agreement?.environment);
  if (!payment || agreement.provider !== 'gocardless'
    || payment.tenant_id !== agreement.tenant_id
    || instalmentSourceMode(payment.environment) !== mode
    || !['confirmed', 'paid_out'].includes(payment.status)
    || !agreement.gocardless_mandate_id
    || payment.gocardless_mandate_id !== agreement.gocardless_mandate_id
    || !payment.gocardless_payment_id
    || payment.gocardless_payment_id !== expectedPayment?.gocardless_payment_id
    || !/^[A-Z]{3}$/.test(payment.currency || '')
    || (agreement.metadata?.dd?.currency
      && payment.currency !== String(agreement.metadata.dd.currency).toUpperCase())
    || payment.amount_minor !== expectedPayment?.amount_minor
    || !Number.isSafeInteger(payment.amount_minor) || payment.amount_minor <= 0) {
    throw new Error('GoCardless instalment lacks matching confirmed tenant/provider-mode evidence');
  }
}
