// Admin-only: replace the recorded current organisation membership year.
// POST { action: 'preview' | 'execute' | 'retry', organizationId, ... }
import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { getAccountingProvider, getAccountingProviderByName } from '../_lib/accountingProvider.js';
import { simulateMembershipForOrg } from '../_lib/membershipSimulation.js';
import { getConfigForOrganisation } from '../_lib/membershipConfigResolver.js';
import { calculateMembershipYearWindow } from '../_lib/membershipYear.js';
import { hasActiveMonthlyBillingAgreement } from '../_lib/annualRenewalPolicy.js';
import { getMembershipAddonSettings, loadAddonLines } from '../_lib/membershipAddons.js';
import { sendMembershipInvoiceEmail } from '../_lib/membershipInvoiceEmail.js';
import { resolveInvoiceAddress } from '../_lib/invoiceAddressResolver.js';
import { resolveMembershipNominalCode } from '../_lib/membershipNominalCode.js';
import { readQuickBooksInvoiceCreditEvidence } from '../_lib/quickbooks.js';
import { readXeroInvoiceCreditEvidence } from '../_lib/xero.js';
import {
  createOrganisationMembershipReplacementService,
  normalizeReplacementOverride,
  ReplacementError,
} from '../_lib/organisationMembershipReplacement.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildDefaultReplacementService() {
  return createOrganisationMembershipReplacementService({
    db: supabase,
    simulate: simulateMembershipForOrg,
    getConfig: (tenantId, organizationId) => getConfigForOrganisation(tenantId, organizationId, {}, null, { strict: true }),
    currentYearLabel: (config) => calculateMembershipYearWindow(config)?.label || null,
    getActiveProvider: getAccountingProvider,
    getProviderByName: getAccountingProviderByName,
    hasActiveCollectionPlan: (tenantId, organizationId) => hasActiveMonthlyBillingAgreement(supabase, { tenantId, organizationId }),
    loadApprovedAddonLines: loadAddonLines,
    getAddonSettings: getMembershipAddonSettings,
    sendInvoiceEmail: sendMembershipInvoiceEmail,
    resolveInvoiceAddress: (config, organizationId) => resolveInvoiceAddress(supabase, config, organizationId, 'organization'),
    resolveNominalCode: (tenantId, sim) => resolveMembershipNominalCode(supabase, tenantId, sim),
    readInvoiceCreditEvidence: (providerName, tenantId, invoiceId) => (providerName === 'quickbooks'
      ? readQuickBooksInvoiceCreditEvidence(tenantId, invoiceId)
      : readXeroInvoiceCreditEvidence(tenantId, invoiceId)),
  });
}

export default async function handler(req, res, { service: injected } = {}) {
  if (!supabase && !injected) return res.status(500).json({ error: 'Database not configured' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const tenantContext = await getTenantContext(req);
    if (!tenantContext?.tenantId) return res.status(401).json({ error: 'Unauthorized' });
    if (!await hasAdminAccess(tenantContext)) return res.status(403).json({ error: 'Administrator access required' });
    const { tenantId } = tenantContext;
    const body = req.body || {};
    const { action, organizationId, recordId, operationId } = body;
    if (!UUID.test(organizationId || '')) return res.status(400).json({ error: 'Organisation is required' });
    const service = injected || buildDefaultReplacementService();

    if (action === 'retry') {
      if (!UUID.test(operationId || '')) return res.status(400).json({ error: 'Replacement is required' });
      const operation = await service.retry({ tenantId, organizationId, operationId });
      return res.json({ success: operation.sync_state === 'complete', operation });
    }

    if (!UUID.test(recordId || '')) return res.status(400).json({ error: 'Membership year is required' });
    const override = normalizeReplacementOverride(body.override);
    const addonLines = Array.isArray(body.addonLines) ? body.addonLines : undefined;

    if (action === 'preview') {
      const preview = await service.preview({ tenantId, organizationId, recordId, override, addonLines });
      return res.json({ success: true, preview });
    }
    if (action === 'execute') {
      const result = await service.execute({
        tenantId, organizationId, recordId, override, addonLines,
        reason: body.reason,
        period: body.period,
        idempotencyKey: body.idempotencyKey,
        actorId: tenantContext.memberId || tenantContext.tenantUserId || null,
      });
      return res.json({ success: result.operation?.sync_state === 'complete', ...result });
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (error) {
    if (error instanceof ReplacementError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    console.error('[Org Membership Replace] Error:', error);
    return res.status(500).json({ error: 'Could not replace the membership year' });
  }
}
