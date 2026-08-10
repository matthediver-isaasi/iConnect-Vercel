/**
 * Form payment reconciliation (Task #3483) — mirrors the job-posting
 * reconciler: sweeps form_submission rows stuck in payment_status='pending'
 * whose provider-side payment actually succeeded (browser closed before the
 * confirm call, network drop after Stripe charged, GC redirect never
 * landed), marks them paid via the shared CAS and runs finalisation exactly
 * once. Also re-runs finalisation for paid rows whose side effects never
 * completed (payment_meta.finalized missing).
 *
 * Idempotent and race-proof: the CAS in markFormSubmissionPaid means a
 * concurrent browser confirm and this sweep can never double-process.
 */
import { retrieveTenantPaymentIntent } from './stripeCredentials.js';
import { gocardlessForTenant } from './gocardless.js';
import { markFormSubmissionPaid, finalizeFormSubmission } from './formPaymentFinalize.js';

const FORM_COLUMNS = 'id, name, tenant_id, fields, pages, visibility_rules, entity_pipelines, field_mappings, application_level, submission_emails, submission_email_template_id, submission_email_recipient, submission_email_cc, submission_email_bcc, submission_email_field_mapping, form_type';

// Only look at rows old enough that the browser confirm is clearly not
// coming, and young enough to be worth polling.
const MIN_AGE_MS = 10 * 60 * 1000;
const MAX_AGE_DAYS = 14;

export async function reconcileFormPayments(supabase, { baseUrl = null, limit = 50 } = {}) {
  const results = { checked: 0, paid: 0, failed: 0, finalized: 0, errors: [] };
  const now = Date.now();
  const minCreated = new Date(now - MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const maxCreated = new Date(now - MIN_AGE_MS).toISOString();

  let rows = [];
  try {
    const { data, error } = await supabase
      .from('form_submission')
      .select('*')
      .eq('payment_status', 'pending')
      .not('payment_reference', 'is', null)
      .gte('created_date', minCreated)
      .lte('created_date', maxCreated)
      .order('created_date', { ascending: true })
      .limit(limit);
    if (error) throw error;
    rows = data || [];
  } catch (err) {
    // Pre-migration DB (42703) or transient failure — nothing to do.
    console.warn('[formPaymentReconciliation] Pending sweep query failed:', err?.message);
    return results;
  }

  const formCache = new Map();
  const loadForm = async (formId, tenantId) => {
    const key = `${tenantId}:${formId}`;
    if (!formCache.has(key)) {
      const { data } = await supabase
        .from('form')
        .select(FORM_COLUMNS)
        .eq('id', formId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      formCache.set(key, data || null);
    }
    return formCache.get(key);
  };

  for (const row of rows) {
    results.checked += 1;
    try {
      if (row.payment_provider === 'stripe') {
        const found = await retrieveTenantPaymentIntent(row.tenant_id, 'forms', row.payment_reference);
        if (!found) continue;
        const pi = found.paymentIntent;
        const metadataMatches = pi.metadata?.type === 'form_payment'
          && pi.metadata?.form_submission_id === String(row.id)
          && pi.metadata?.tenant_id === String(row.tenant_id);
        if (!metadataMatches && row.payment_reference !== pi.id) continue;
        if (pi.status === 'succeeded') {
          const receivedMinor = pi.amount_received ?? pi.amount;
          const { updated, row: paidRow } = await markFormSubmissionPaid(supabase, row.id, {
            amount: receivedMinor != null ? receivedMinor / 100 : null,
            reference: pi.id,
          });
          if (updated) results.paid += 1;
          const form = await loadForm(row.form_id, row.tenant_id);
          if (form) {
            const fin = await finalizeFormSubmission({
              supabase,
              submission: paidRow || { ...row, payment_status: 'paid' },
              form,
              baseUrl,
            });
            if (fin.finalized && !fin.alreadyFinalized) results.finalized += 1;
          }
        } else if (pi.status === 'canceled') {
          await supabase.from('form_submission')
            .update({ payment_status: 'failed' })
            .eq('id', row.id).eq('payment_status', 'pending');
          results.failed += 1;
        }
      } else if (row.payment_provider === 'gocardless') {
        const gc = await gocardlessForTenant(row.tenant_id);
        if (!gc.isConfigured()) continue;
        const br = await gc.getBillingRequest(row.payment_reference);
        const brMeta = br?.metadata || {};
        if (brMeta.type !== 'form_payment' || brMeta.form_submission_id !== String(row.id)) continue;
        if (br.status === 'fulfilled') {
          const { updated, row: paidRow } = await markFormSubmissionPaid(supabase, row.id, { reference: br.id });
          if (updated) results.paid += 1;
          const form = await loadForm(row.form_id, row.tenant_id);
          if (form) {
            const fin = await finalizeFormSubmission({
              supabase,
              submission: paidRow || { ...row, payment_status: 'paid' },
              form,
              baseUrl,
            });
            if (fin.finalized && !fin.alreadyFinalized) results.finalized += 1;
          }
        } else if (br.status === 'cancelled' || br.status === 'failed') {
          await supabase.from('form_submission')
            .update({ payment_status: 'failed' })
            .eq('id', row.id).eq('payment_status', 'pending');
          results.failed += 1;
        }
      }
    } catch (err) {
      console.error(`[formPaymentReconciliation] Row ${row.id} failed:`, err?.message);
      results.errors.push({ id: row.id, error: err?.message });
    }
  }

  // Second sweep: paid rows whose finalisation never completed.
  try {
    const { data: unfinalized } = await supabase
      .from('form_submission')
      .select('*')
      .eq('payment_status', 'paid')
      .gte('created_date', minCreated)
      .filter('payment_meta->finalized', 'is', null)
      .limit(20);
    for (const row of unfinalized || []) {
      const form = await loadForm(row.form_id, row.tenant_id);
      if (!form) continue;
      const fin = await finalizeFormSubmission({ supabase, submission: row, form, baseUrl });
      if (fin.finalized && !fin.alreadyFinalized) results.finalized += 1;
    }
  } catch (err) {
    console.warn('[formPaymentReconciliation] Unfinalized sweep failed:', err?.message);
  }

  return results;
}
