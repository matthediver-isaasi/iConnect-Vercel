import { getAccountingProviderByName } from './accountingProvider.js';
import { retrieveTenantPaymentIntent } from './stripeCredentials.js';

export const FORM_STRIPE_SETTLEMENT_CLAIM_TTL_MS = 15 * 60 * 1000;
export const MAX_FORM_STRIPE_SETTLEMENT_ATTEMPTS = 12;

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function accountingProviderContext(providerName, tokenSummary) {
  if (providerName === 'xero' && tokenSummary?.tenantId) {
    return { xero_tenant_id: String(tokenSummary.tenantId) };
  }
  if (providerName === 'quickbooks' && (tokenSummary?.realmId || tokenSummary?.tenantId)) {
    return {
      quickbooks_realm_id: String(tokenSummary.realmId || tokenSummary.tenantId),
      environment: tokenSummary.environment || null,
    };
  }
  return null;
}

export function accountingProviderContextsEqual(left, right) {
  return !!left && !!right && canonicalJson(left) === canonicalJson(right);
}

function currencyExponent(currency) {
  return new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'])
    .has(String(currency || '').toUpperCase()) ? 0 : 2;
}

export function formMembershipQuoteAmountMinor(quote) {
  const major = Number(quote?.total_with_vat ?? quote?.final_cost);
  if (!Number.isFinite(major)) return null;
  return Math.round(major * (10 ** currencyExponent(quote?.currency || 'GBP')));
}

export async function mergeFormMembershipProgress(supabase, {
  tenantId,
  submissionId,
  patch,
  expected = {},
}) {
  const { data, error } = await supabase.rpc('merge_form_membership_result', {
    p_tenant_id: tenantId,
    p_submission_id: submissionId,
    p_patch: patch,
    p_expected: expected,
  });
  if (error) throw new Error(`persist membership progress failed: ${error.message}`);
  if (!data?.ok) {
    return {
      updated: false,
      conflict: data?.code === 'PROGRESS_CHANGED',
      result: data?.membership_result || null,
      code: data?.code || 'PROGRESS_NOT_PERSISTED',
    };
  }
  return { updated: true, result: data.membership_result };
}

async function findHistory(supabase, submission, historyId, tableHint) {
  const target = submission.payment_meta?.membership?.quote?.target;
  const expectedTable = target === 'member'
    ? 'member_membership_history'
    : target === 'organization' ? 'organisation_membership_history' : null;
  if (!expectedTable || tableHint !== expectedTable) {
    throw new Error('Membership history table does not match the immutable quote target');
  }
  const { data, error } = await supabase.from(expectedTable).select('*')
    .eq('id', historyId).eq('tenant_id', submission.tenant_id).maybeSingle();
  if (error) throw new Error(`load membership invoice failed: ${error.message}`);
  return { table: expectedTable, row: data };
}

function stableResult(providerResult, identity) {
  return {
    settlement_state: providerResult?.settlement_state || 'retry',
    payment_recorded: providerResult?.payment_recorded === true,
    annotation_recorded: providerResult?.annotation_recorded === true,
    error: providerResult?.error || null,
    invoice_id: providerResult?.invoice_id || identity.invoiceId,
    invoice_number: providerResult?.invoice_number || identity.invoiceNumber || null,
    balance: providerResult?.balance ?? null,
    account: providerResult?.account || identity.account || null,
    provider_context: providerResult?.provider_context || identity.providerContext || null,
    stripe_payment_intent_id: identity.paymentIntentId,
    amount: identity.amount,
    currency: identity.currency,
    paid_at: identity.paidAt,
    payment: {
      stripe_payment_intent_id: identity.paymentIntentId,
      amount: identity.amount,
      currency: identity.currency,
      paid_at: identity.paidAt,
    },
  };
}

/**
 * Settle an already-linked Stripe form-membership invoice.
 *
 * This is deliberately not a workflow replay. It only operates on an existing,
 * tenant-scoped paid submission and existing membership/invoice linkage.
 * dryRun defaults true so admin repair callers must opt in to provider writes.
 */
export async function settleFormStripeInvoice({
  supabase,
  submissionId,
  tenantId,
  dryRun = true,
  expectedAccount,
  expectedProviderContext,
  annotationOnly = false,
  retrievePaymentIntent = retrieveTenantPaymentIntent,
  getProvider = (_tenantId, pinnedProvider) => getAccountingProviderByName(pinnedProvider),
}) {
  if (!supabase || !submissionId || !tenantId) throw new Error('supabase, submissionId and tenantId are required');
  const { data: submission, error: submissionError } = await supabase
    .from('form_submission').select('*').eq('id', submissionId).eq('tenant_id', tenantId).maybeSingle();
  if (submissionError) throw new Error(`load form submission failed: ${submissionError.message}`);
  if (!submission) throw new Error('Form submission not found');
  if (submission.payment_provider !== 'stripe' || submission.payment_status !== 'paid') {
    throw new Error('Form submission is not a paid Stripe payment');
  }

  const meta = asObject(submission.payment_meta);
  const progress = asObject(meta.membership_result);
  const quote = meta.membership?.quote;
  if (!quote || !progress.history_id) throw new Error('Existing membership linkage not found');
  const { table: historyTable, row: history } = await findHistory(supabase, submission, progress.history_id, progress.table);
  if (!history) throw new Error('Linked membership history row not found');
  const expectedEntityId = quote.target === 'member'
    ? submission.created_member_id
    : (submission.organization_id || meta.prefill_organization_id);
  const historyEntityId = quote.target === 'member' ? history.member_id : history.organization_id;
  if (!expectedEntityId || !progress.entity_id
      || String(historyEntityId) !== String(expectedEntityId)
      || String(historyEntityId) !== String(progress.entity_id)) {
    throw new Error('Linked membership entity does not match the form submission');
  }
  if (history.billing_agreement_id || history.payment_method !== 'stripe'
      || history.payment_status !== 'paid') {
    throw new Error('Membership history is not an eligible paid one-off Stripe record');
  }
  let invoiceId = history.accounting_invoice_id || history.xero_invoice_id;
  let invoiceNumber = history.accounting_invoice_number || history.xero_invoice_number || null;
  const pinnedProvider = history.accounting_provider
    || (history.xero_invoice_id ? 'xero' : null)
    || progress.accounting_provider;
  if (!pinnedProvider) throw new Error('Linked accounting provider not found');
  if (progress.accounting_provider && progress.accounting_provider !== pinnedProvider) {
    throw new Error('Recorded accounting provider linkage is inconsistent');
  }
  const recordedProviderContext = progress.provider_context
    || history.accounting_provider_context
    || null;
  if (recordedProviderContext && expectedProviderContext
      && !accountingProviderContextsEqual(recordedProviderContext, expectedProviderContext)) {
    throw new Error('Expected accounting provider context does not match the recorded invoice context');
  }
  if (!recordedProviderContext && !dryRun && !expectedProviderContext) {
    throw new Error('Legacy invoice settlement requires explicit confirmed provider context');
  }
  const providerContext = recordedProviderContext || expectedProviderContext || null;
  const persistDiagnostics = async (errorMessage = null) => {
    if (dryRun) return;
    const { error: historyError } = await supabase.from(historyTable).update({
      accounting_sync_status: errorMessage ? 'failed' : null,
      accounting_sync_error: errorMessage ? String(errorMessage).slice(0, 1000) : null,
    }).eq('id', history.id).eq('tenant_id', tenantId);
    if (historyError) throw new Error(`persist accounting diagnostics failed: ${historyError.message}`);
    if (errorMessage) {
      const { error: noteError } = await supabase.from('form_submission').update({
        processing_notes: `Payment remains paid, but accounting invoice settlement needs attention: ${String(errorMessage).slice(0, 1000)}. Do not charge the applicant again.`,
      }).eq('id', submission.id).eq('tenant_id', tenantId);
      if (noteError) throw new Error(`persist settlement processing note failed: ${noteError.message}`);
    } else {
      // Clear only our own stale diagnostic, and only if no other writer has
      // replaced it since this verified settlement began.
      const note = submission.processing_notes;
      const ownedNote = typeof note === 'string' && [
        'Payment succeeded and the membership was created, but accounting provider preparation failed:',
        'Payment succeeded and the membership was created, but the accounting invoice step failed:',
        'Payment succeeded and the membership was created, but the accounting invoice creation outcome needs review:',
        'Payment succeeded and the membership was created, but accounting invoice settlement did not complete:',
        'Payment remains paid, but accounting invoice settlement needs attention:',
      ].some((prefix) => note.startsWith(prefix));
      if (ownedNote) {
        const { error: noteError } = await supabase.from('form_submission')
          .update({ processing_notes: null })
          .eq('id', submission.id).eq('tenant_id', tenantId).eq('processing_notes', note);
        if (noteError) throw new Error(`clear settlement processing note failed: ${noteError.message}`);
      }
    }
  };
  if (!submission.payment_reference) throw new Error('Stripe PaymentIntent linkage not found');
  if (history.stripe_payment_intent_id !== submission.payment_reference) {
    throw new Error('Membership history Stripe PaymentIntent linkage does not match the submission');
  }

  const stripeFeature = meta.stripe_feature || 'membership';
  const found = await retrievePaymentIntent(tenantId, stripeFeature, submission.payment_reference);
  const pi = found?.paymentIntent;
  if (!pi || pi.id !== submission.payment_reference || pi.status !== 'succeeded') {
    throw new Error('Stripe PaymentIntent is not verified as succeeded');
  }
  const metadataMatches = pi.metadata?.type === 'form_payment'
    && pi.metadata?.tenant_id === String(tenantId)
    && pi.metadata?.form_id === String(submission.form_id)
    && pi.metadata?.form_submission_id === String(submission.id);
  if (!metadataMatches) throw new Error('Stripe PaymentIntent metadata does not match the form submission');

  const currency = String(quote.currency || submission.payment_currency || '').toUpperCase();
  const amountMinor = formMembershipQuoteAmountMinor(quote);
  const receivedMinor = Number(pi.amount_received ?? pi.amount);
  if (!currency || String(pi.currency || '').toUpperCase() !== currency
      || amountMinor === null || receivedMinor !== amountMinor) {
    throw new Error('Stripe PaymentIntent amount/currency does not match the immutable membership quote');
  }
  const amount = amountMinor / (10 ** currencyExponent(currency));
  const paidAtDate = new Date(submission.payment_paid_at);
  if (!submission.payment_paid_at || !Number.isFinite(paidAtDate.getTime())) {
    throw new Error('Persisted form payment paid timestamp is missing');
  }
  const paidAt = paidAtDate.toISOString();
  let provider = null;
  if (!invoiceId) {
    if (progress.invoice_state !== 'processing') throw new Error('Linked accounting invoice not found');
    let discoveryAttempts = Number(progress.invoice_discovery_attempts || 0);
    if (!dryRun) {
      const nextClaimedAt = new Date().toISOString();
      discoveryAttempts += 1;
      const discoveryClaim = await mergeFormMembershipProgress(supabase, {
        tenantId,
        submissionId,
        expected: {
          invoice_state: 'processing',
          invoice_claimed_at: progress.invoice_claimed_at || null,
        },
        patch: {
          invoice_claimed_at: nextClaimedAt,
          invoice_discovery_attempts: discoveryAttempts,
        },
      });
      if (!discoveryClaim.updated) {
        return stableResult({
          settlement_state: 'retry',
          error: 'Invoice discovery claim changed concurrently',
        }, {
          invoiceId: null, invoiceNumber: null, paymentIntentId: pi.id,
          amount, currency, paidAt, account: expectedAccount || null, providerContext,
        });
      }
      progress.invoice_claimed_at = nextClaimedAt;
    }
    provider = await getProvider(tenantId, pinnedProvider);
    if (typeof provider.findFormStripeInvoice !== 'function') {
      throw new Error('Accounting provider does not support safe invoice discovery');
    }
    let discovery;
    try {
      discovery = await provider.findFormStripeInvoice({
        appTenantId: tenantId,
        stripePaymentIntentId: pi.id,
        createdAfter: progress.invoice_created_after || submission.payment_paid_at,
        expectedProviderContext: providerContext,
      });
    } catch (error) {
      if (!dryRun && discoveryAttempts >= MAX_FORM_STRIPE_SETTLEMENT_ATTEMPTS) {
        const blocked = await mergeFormMembershipProgress(supabase, {
          tenantId,
          submissionId,
          expected: {
            invoice_state: 'processing',
            invoice_claimed_at: progress.invoice_claimed_at,
          },
          patch: { invoice_state: 'blocked', accounting_error: String(error?.message || error).slice(0, 1000) },
        });
        if (!blocked.updated) throw new Error(`invoice discovery failure was not persisted (${blocked.code})`);
      }
      throw error;
    }
    const matches = Array.isArray(discovery?.matches)
      ? discovery.matches
      : discovery?.invoice ? [discovery.invoice]
        : (discovery?.found === true || discovery?.invoice_id || discovery?.invoiceId) ? [discovery] : [];
    if (matches.length !== 1) {
      if (!dryRun) {
        const blocked = await mergeFormMembershipProgress(supabase, {
          tenantId,
          submissionId,
          expected: {
            invoice_state: 'processing',
            invoice_claimed_at: progress.invoice_claimed_at || null,
          },
          patch: {
            invoice_state: 'blocked',
            accounting_error: matches.length > 1
              ? 'Invoice discovery returned multiple matches'
              : 'Invoice creation outcome is ambiguous and no exact invoice was found',
          },
        });
        if (!blocked.updated) throw new Error(`ambiguous invoice state was not persisted (${blocked.code})`);
      }
      return stableResult({
        settlement_state: 'blocked',
        error: matches.length > 1
          ? 'Invoice discovery returned multiple matches'
          : 'No unique exact invoice was found',
        account: discovery?.account,
      }, {
        invoiceId: null,
        invoiceNumber: null,
        paymentIntentId: pi.id,
        amount,
        currency,
        paidAt,
        account: expectedAccount || null,
        providerContext,
      });
    }
    const foundInvoice = matches[0];
    const foundContext = foundInvoice.provider_context || discovery?.provider_context || null;
    const foundPi = foundInvoice.stripe_payment_intent_id
      || foundInvoice.payment_intent_id
      || foundInvoice.metadata?.stripe_payment_intent_id
      || pi.id;
    const foundSubmission = foundInvoice.form_submission_id
      || foundInvoice.metadata?.form_submission_id
      || submission.id;
    const foundEntity = foundInvoice.entity_id
      || foundInvoice.member_id
      || foundInvoice.organization_id
      || foundInvoice.metadata?.entity_id
      || expectedEntityId;
    if ((providerContext ? !accountingProviderContextsEqual(foundContext, providerContext) : (!dryRun || !foundContext))
        || foundPi !== pi.id
        || String(foundSubmission) !== String(submission.id)
        || String(foundEntity) !== String(expectedEntityId)
        || Number(foundInvoice.amount ?? foundInvoice.total) !== amount
        || String(foundInvoice.currency || '').toUpperCase() !== currency) {
      throw new Error('Discovered invoice financial or owner identity did not match the form payment');
    }
    invoiceId = foundInvoice.invoice_id || foundInvoice.invoiceId;
    invoiceNumber = foundInvoice.invoice_number || foundInvoice.invoiceNumber || null;
    if (!invoiceId) throw new Error('Discovered invoice has no invoice id');
    if (!dryRun) {
      const { data: linked, error: linkError } = await supabase.rpc('link_recovered_form_membership_invoice', {
      p_tenant_id: tenantId,
      p_submission_id: submission.id,
      p_history_id: history.id,
      p_invoice_id: invoiceId,
      p_invoice_number: invoiceNumber,
      p_provider: pinnedProvider,
      p_provider_context: foundContext,
      p_expected_claimed_at: progress.invoice_claimed_at,
      });
      if (linkError || !linked?.ok) {
        throw new Error(`recovered invoice linkage was not persisted (${linkError?.message || linked?.code || 'unknown'})`);
      }
      progress.invoice_state = 'done';
      progress.settlement_state = 'pending';
    }
  }
  const operationKey = `form-stripe-invoice:${tenantId}:${submission.id}:${invoiceId}:${pi.id}`;
  const identity = {
    invoiceId,
    invoiceNumber,
    paymentIntentId: pi.id,
    amount,
    currency,
    paidAt,
    account: expectedAccount || null,
    providerContext,
  };

  let claim = null;
  let attempt = Number(progress.settlement_attempts || 0);
  if (!dryRun) {
    const hasSettlementState = Object.prototype.hasOwnProperty.call(progress, 'settlement_state');
    const currentState = hasSettlementState ? progress.settlement_state : 'pending';
    if (currentState === 'done') {
      return stableResult({
        settlement_state: 'done',
        payment_recorded: progress.payment_state === 'done',
        annotation_recorded: progress.annotation_state === 'done',
        invoice_id: invoiceId,
        invoice_number: invoiceNumber,
        balance: progress.invoice_balance,
        account: progress.settlement_account,
      }, identity);
    }
    let expected = { settlement_state: hasSettlementState ? currentState : null };
    if (currentState === 'processing') {
      const claimTime = new Date(progress.settlement_claimed_at || 0).getTime();
      if (Number.isFinite(claimTime) && Date.now() - claimTime < FORM_STRIPE_SETTLEMENT_CLAIM_TTL_MS) {
        return stableResult({ settlement_state: 'retry', error: 'Settlement is already in progress' }, identity);
      }
      expected = {
        settlement_state: 'processing',
        settlement_claimed_at: progress.settlement_claimed_at || null,
      };
    }
    const claimedAt = new Date().toISOString();
    attempt += 1;
    claim = await mergeFormMembershipProgress(supabase, {
      tenantId,
      submissionId,
      expected,
      patch: {
        settlement_state: 'processing',
        settlement_claimed_at: claimedAt,
        settlement_attempts: attempt,
        ...(!recordedProviderContext && expectedProviderContext
          ? { provider_context: expectedProviderContext } : {}),
      },
    });
    if (!claim.updated) return stableResult({ settlement_state: 'retry', error: 'Settlement progress changed concurrently' }, identity);
  }

  let providerResult;
  try {
    provider ||= await getProvider(tenantId, pinnedProvider);
    providerResult = await provider.settleFormStripeInvoice({
      appTenantId: tenantId,
      invoiceId,
      stripePaymentIntentId: pi.id,
      amount,
      currency,
      paidAt,
      dryRun,
      expectedAccount,
      expectedProviderContext: providerContext,
      annotationOnly,
      operationKey,
    });
    if (!dryRun && !accountingProviderContextsEqual(providerResult?.provider_context, providerContext)) {
      throw new Error('Settlement response provider context did not match the pinned invoice context');
    }
  } catch (error) {
    if (!dryRun) {
      const failedState = attempt >= MAX_FORM_STRIPE_SETTLEMENT_ATTEMPTS ? 'blocked' : 'retry';
      const failurePersisted = await mergeFormMembershipProgress(supabase, {
        tenantId,
        submissionId,
        expected: { settlement_state: 'processing', settlement_claimed_at: claim.result.settlement_claimed_at },
        patch: { settlement_state: failedState, settlement_error: String(error?.message || error).slice(0, 1000) },
      });
      await persistDiagnostics(error?.message || error);
      if (!failurePersisted.updated) {
        throw new Error(`provider settlement failed (${error?.message || error}) and failure progress was not persisted (${failurePersisted.code})`);
      }
    } else {
      await persistDiagnostics(error?.message || error);
    }
    throw error;
  }

  const normalized = stableResult(providerResult, identity);
  if (!dryRun) {
    let finalState = ['done', 'blocked', 'retry'].includes(normalized.settlement_state)
      ? normalized.settlement_state : 'retry';
    // A note-only repair must not enroll a legacy invoice in the automatic
    // payment sweep. Payment authority requires a separate signed inspection
    // and account confirmation, even when the account happens to be configured.
    if (annotationOnly && !normalized.payment_recorded) {
      finalState = 'blocked';
      normalized.error = normalized.error
        || 'Stripe reference repair only. Payment settlement requires explicit confirmation.';
    }
    if (finalState === 'retry' && attempt >= MAX_FORM_STRIPE_SETTLEMENT_ATTEMPTS) finalState = 'blocked';
    normalized.settlement_state = finalState;
    const persisted = await mergeFormMembershipProgress(supabase, {
      tenantId,
      submissionId,
      expected: { settlement_state: 'processing', settlement_claimed_at: claim.result.settlement_claimed_at },
      patch: {
        settlement_state: finalState,
        payment_state: normalized.payment_recorded ? 'done' : (progress.payment_state || 'pending'),
        annotation_state: normalized.annotation_recorded ? 'done' : (progress.annotation_state || 'pending'),
        settlement_error: normalized.error ? String(normalized.error).slice(0, 1000) : null,
        ...(finalState === 'done' ? { accounting_error: null } : {}),
        settlement_account: normalized.account,
        invoice_balance: normalized.balance,
      },
    });
    if (!persisted.updated) {
      throw new Error(`provider settlement completed but progress was not persisted (${persisted.code})`);
    }
    await persistDiagnostics(finalState === 'done' ? null : (normalized.error || `provider returned ${finalState}`));
  }
  return normalized;
}