import { createHmac, timingSafeEqual } from 'node:crypto';
import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../_lib/tenantContext.js';
import { settleFormStripeInvoice } from '../_lib/formStripeInvoiceSettlement.js';

const TABLES = new Set(['member_membership_history', 'organisation_membership_history']);
const PLAN_TTL_MS = 15 * 60 * 1000;

function planIdentity(tenantId, submissionId, recordId, table, result, annotationOnly = false) {
  return JSON.stringify([
    tenantId, submissionId, recordId, table, result.invoice_id,
    result.stripe_payment_intent_id, result.amount, result.currency,
    result.account, result.balance, result.provider_context || null,
    annotationOnly ? 'annotation_only' : 'settlement',
  ]);
}

export function signSettlementPlan(identity, secret, now = Date.now()) {
  if (!secret) throw new Error('Recovery confirmation signing is not configured');
  const signature = createHmac('sha256', secret).update(`${now}:${identity}`).digest('hex');
  return `${now}.${signature}`;
}

export function verifySettlementPlan(token, identity, secret, now = Date.now()) {
  if (!secret || typeof token !== 'string') return false;
  const [timestamp, signature, extra] = token.split('.');
  const age = now - Number(timestamp);
  if (extra || !/^\d+$/.test(timestamp || '') || !/^[a-f0-9]{64}$/.test(signature || '')
      || age < 0 || age > PLAN_TTL_MS) return false;
  const expected = signSettlementPlan(identity, secret, Number(timestamp)).split('.')[1];
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

export function createFormInvoiceSettlementHandler({
  db = supabase,
  getContext = getTenantContext,
  isAdmin = hasAdminAccess,
  hasFinance = hasFeatureAccess,
  settle = settleFormStripeInvoice,
  signingSecret = () => process.env.SESSION_SECRET,
} = {}) {
  return async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    try {
      const context = await getContext(req);
      if (!context?.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
      if (!context.tenantId || !await isAdmin(context)) {
        return res.status(403).json({ error: 'Tenant admin access required' });
      }
      if (context.roleId && !await hasFinance(context.roleId, 'commerce.monthly-finance-report')) {
        return res.status(403).json({ error: 'Accounting recovery requires finance permission' });
      }
      const { recordId, table, submissionId: requestedSubmissionId, execute, planToken, expectedAccount, annotationOnly, expectedProviderContext } = req.body || {};
      if (execute != null && typeof execute !== 'boolean') {
        return res.status(400).json({ error: 'execute must be a boolean' });
      }
      if (annotationOnly != null && typeof annotationOnly !== 'boolean') {
        return res.status(400).json({ error: 'annotationOnly must be a boolean' });
      }
      if (!requestedSubmissionId && (!recordId || !TABLES.has(table))) {
        return res.status(400).json({ error: 'Supply submissionId, or recordId and a valid membership table' });
      }
      const tenantId = context.tenantId;
      let query = db.from('form_submission')
        .select('id,payment_meta').eq('tenant_id', tenantId)
        .eq('payment_provider', 'stripe').eq('payment_status', 'paid');
      query = requestedSubmissionId
        ? query.eq('id', requestedSubmissionId)
        : query.filter('payment_meta->membership_result->>history_id', 'eq', recordId);
      const { data: submission, error } = await query.maybeSingle();
      if (error) throw new Error('Could not uniquely resolve the originating form submission');
      if (!submission) return res.status(404).json({ error: 'Paid Stripe form membership submission not found' });
      const progress = submission.payment_meta?.membership_result;
      const resolvedTable = submission.payment_meta?.membership?.quote?.target === 'member'
        ? 'member_membership_history' : 'organisation_membership_history';
      if (!progress?.history_id || (recordId && recordId !== progress.history_id)
          || (table && table !== resolvedTable) || (progress.table && progress.table !== resolvedTable)) {
        return res.status(409).json({ error: 'Submission membership linkage does not match the requested record' });
      }
      const args = { supabase: db, tenantId, submissionId: submission.id };
      // Always read Stripe and accounting evidence again, including on execution.
      // A signed preview cannot authorize a changed invoice/account/balance.
      // Both modes inspect the same accounting evidence. Only their signed
      // write authority differs; a note-only token cannot authorize payment.
      const preview = await settle({ ...args, dryRun: true });
      const identityFor = (noteOnly) => planIdentity(
        tenantId, submission.id, progress.history_id, resolvedTable, preview, noteOnly,
      );
      if (execute !== true) {
        return res.status(200).json({
          ok: true, dryRun: true, submissionId: submission.id, result: preview,
          planToken: signSettlementPlan(identityFor(annotationOnly === true), signingSecret()),
          ...(annotationOnly === true ? {} : {
            annotationPlanToken: signSettlementPlan(identityFor(true), signingSecret()),
          }),
        });
      }
      if (!verifySettlementPlan(planToken, identityFor(annotationOnly === true), signingSecret())) {
        return res.status(409).json({ error: 'Run a new inspection first; the preview expired or accounting evidence changed.' });
      }
      if (!preview.provider_context
          || JSON.stringify(expectedProviderContext) !== JSON.stringify(preview.provider_context)) {
        return res.status(409).json({ error: 'Confirm the accounting company shown in the inspection before executing.' });
      }
      if (annotationOnly !== true && (typeof expectedAccount !== 'string' || !expectedAccount.trim()
          || expectedAccount.trim() !== String(preview.account || ''))) {
        return res.status(409).json({ error: 'Confirm the exact configured tenant Stripe clearing account before executing.' });
      }
      if (annotationOnly !== true && preview.settlement_state === 'blocked') {
        return res.status(409).json({ error: preview.error || 'Accounting settlement is blocked', result: preview });
      }
      const result = await settle({
        ...args, dryRun: false, annotationOnly: annotationOnly === true,
        expectedAccount: annotationOnly === true ? undefined : expectedAccount.trim(),
        expectedProviderContext: preview.provider_context,
      });
      return res.status(200).json({ ok: true, dryRun: false, submissionId: submission.id, result });
    } catch (error) {
      // Never return credentials, client secrets, or raw provider response bodies.
      console.error('[form-invoice-settlement]', String(error?.message || error).replace(/pi_[A-Za-z0-9]+_secret_[A-Za-z0-9]+/g, '[redacted]'));
      return res.status(503).json({
        error: 'Accounting inspection or recovery could not finish. The Stripe payment remains successful; do not charge again. Check accounting diagnostics and retry.',
        retryable: true,
      });
    }
  };
}

export default createFormInvoiceSettlementHandler();