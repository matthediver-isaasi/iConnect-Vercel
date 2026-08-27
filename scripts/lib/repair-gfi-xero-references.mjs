import crypto from 'node:crypto';

export const REPAIR_KIND = 'gfi-xero-membership-reference-repair';
export const REPORT_VERSION = 1;
export const TARGET_TENANT_SLUG = 'gfi';
export const TARGET_TENANT_NAME = 'Graduate Futures Institute';
export const PROPOSED_REFERENCE = 'TBC';

export async function authenticateRepairConnection({
  tenantId,
  connections,
  getAccessToken,
}) {
  if (!Array.isArray(connections) || connections.length !== 1) {
    throw new Error('Expected exactly one saved GFI Xero connection. Reconnect Xero before rerunning the repair.');
  }
  if (connections[0]?.tenant_id === 'PENDING_SELECTION') {
    throw new Error('The GFI Xero connection is incomplete. Select a Xero organisation before rerunning the repair.');
  }
  const expiresAt = new Date(connections[0]?.expires_at).getTime();
  const refreshRequired = !Number.isFinite(expiresAt) || expiresAt <= Date.now() + 5 * 60 * 1000;
  try {
    return await getAccessToken(tenantId);
  } catch (error) {
    if (!refreshRequired) throw error;
    throw new Error(
      `The saved GFI Xero connection could not be refreshed. Reconnect Xero before rerunning the repair. ${error.message}`,
      { cause: error },
    );
  }
}

export function isLegacyMembershipReference(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(/^Membership (\d{4})(?:\/(\d{2}|\d{4}))?$/);
  if (!match) return false;
  if (!match[2]) return true;
  const start = Number(match[1]);
  const end = match[2].length === 2
    ? Math.floor(start / 100) * 100 + Number(match[2])
    : Number(match[2]);
  return end === start + 1;
}

export function isUnpaidInvoice(invoice) {
  const status = String(invoice?.Status || '').toUpperCase();
  const amountDue = Number(invoice?.AmountDue);
  return String(invoice?.Type || '').toUpperCase() === 'ACCREC'
    && Number.isFinite(amountDue)
    && amountDue > 0
    && !['PAID', 'VOIDED', 'DELETED'].includes(status);
}

export function classifyInvoice(invoice) {
  if (String(invoice?.Type || '').toUpperCase() !== 'ACCREC') return 'unrelated-or-genuine-po';
  if (!isLegacyMembershipReference(invoice?.Reference)) {
    if (String(invoice?.Reference || '').trim().toUpperCase() === PROPOSED_REFERENCE) {
      return 'already-correct';
    }
    return 'unrelated-or-genuine-po';
  }
  if (!isUnpaidInvoice(invoice)) {
    const status = String(invoice?.Status || '').toUpperCase();
    if (status === 'PAID' || Number(invoice?.AmountDue) === 0) return 'paid';
    if (status === 'VOIDED') return 'voided';
    if (status === 'DELETED') return 'deleted';
    return 'not-unpaid';
  }
  return 'selected';
}

export function invoiceSnapshot(invoice) {
  return {
    invoiceId: invoice.InvoiceID,
    invoiceNumber: invoice.InvoiceNumber || null,
    type: invoice.Type || null,
    status: invoice.Status || null,
    amountDue: Number(invoice.AmountDue),
    total: Number(invoice.Total),
    currencyCode: invoice.CurrencyCode || null,
    contact: {
      contactId: invoice.Contact?.ContactID || null,
      name: invoice.Contact?.Name || null,
    },
    date: invoice.DateString || invoice.Date || null,
    dueDate: invoice.DueDateString || invoice.DueDate || null,
    originalReference: invoice.Reference,
    proposedReference: PROPOSED_REFERENCE,
  };
}

function signedManifestPayload(manifest) {
  return JSON.stringify({
    repairKind: manifest.repairKind,
    reportVersion: manifest.reportVersion,
    mode: manifest.mode,
    generatedAt: manifest.generatedAt,
    target: manifest.target,
    mutationCount: manifest.mutationCount,
    summary: manifest.summary,
    selected: manifest.selected,
    skipped: manifest.skipped,
  });
}

export function signManifest(manifest, secret) {
  if (!secret) throw new Error('Manifest signing secret is required');
  return crypto.createHmac('sha256', secret).update(signedManifestPayload(manifest)).digest('hex');
}

export function validateManifest(manifest, expected, signingSecret) {
  const errors = [];
  if (!manifest || manifest.repairKind !== REPAIR_KIND) errors.push('unexpected repair kind');
  if (manifest?.reportVersion !== REPORT_VERSION) errors.push('unsupported report version');
  if (manifest?.mode !== 'dry-run') errors.push('report is not a dry-run manifest');
  if (manifest?.target?.tenantSlug !== TARGET_TENANT_SLUG) errors.push('wrong tenant slug');
  if (manifest?.target?.tenantName !== TARGET_TENANT_NAME) errors.push('wrong tenant name');
  if (manifest?.target?.tenantId !== expected.tenantId) errors.push('tenant ID does not match live GFI tenant');
  if (manifest?.target?.xeroTenantId !== expected.xeroTenantId) errors.push('Xero organisation does not match current connection');
  if (!Array.isArray(manifest?.selected)) errors.push('selected invoices are missing');
  const ids = new Set();
  for (const item of manifest?.selected || []) {
    if (!item.invoiceId || !isLegacyMembershipReference(item.originalReference)) {
      errors.push(`invalid selected invoice ${item.invoiceId || '<missing id>'}`);
    }
    if (item.proposedReference !== PROPOSED_REFERENCE) {
      errors.push(`invalid proposed reference for ${item.invoiceId || '<missing id>'}`);
    }
    if (ids.has(item.invoiceId)) errors.push(`duplicate selected invoice ${item.invoiceId}`);
    ids.add(item.invoiceId);
  }
  const expectedSignature = signManifest(manifest, signingSecret);
  const actualSignature = typeof manifest?.signature === 'string' ? manifest.signature : '';
  if (actualSignature.length !== expectedSignature.length
      || !crypto.timingSafeEqual(Buffer.from(actualSignature), Buffer.from(expectedSignature))) {
    errors.push('manifest signature is invalid');
  }
  if (errors.length) throw new Error(`Manifest validation failed: ${errors.join('; ')}`);
  return true;
}

export function changeSinceDryRunReason(reviewed, current) {
  if (!current) return 'deleted-or-not-found';
  if (current.InvoiceID !== reviewed.invoiceId) return 'identity-changed';
  if (current.InvoiceNumber !== reviewed.invoiceNumber) return 'invoice-number-changed';
  if (!isUnpaidInvoice(current)) return 'no-longer-unpaid';
  if (current.Reference !== reviewed.originalReference) return 'reference-changed';
  if (Number(current.AmountDue) !== Number(reviewed.amountDue)) return 'balance-changed';
  if (String(current.Status || '') !== String(reviewed.status || '')) return 'status-changed';
  return null;
}

export async function processReviewedInvoice({
  reviewed,
  fetchInvoice,
  updateInvoice,
  checkpoint,
  now = () => new Date(),
}) {
  const outcome = {
    invoiceId: reviewed.invoiceId,
    invoiceNumber: reviewed.invoiceNumber,
    attempted: false,
    state: 'preflight',
  };
  let before;
  try {
    before = await fetchInvoice(reviewed.invoiceId);
    outcome.rechecked = before ? invoiceSnapshot(before) : null;
    const skipReason = changeSinceDryRunReason(reviewed, before);
    if (skipReason) {
      outcome.state = 'complete';
      outcome.result = 'skipped';
      outcome.reason = skipReason;
      await checkpoint(outcome);
      return outcome;
    }
  } catch (error) {
    outcome.state = 'complete';
    outcome.result = 'error';
    outcome.reason = error.message;
    await checkpoint(outcome);
    return outcome;
  }

  outcome.attempted = true;
  outcome.state = 'updating';
  outcome.updateStartedAt = now().toISOString();
  // Deliberately outside the provider try/catch: journal storage failure is a
  // hard stop and updateInvoice must never be called.
  await checkpoint(outcome);

  try {
    outcome.xeroResponse = await updateInvoice(reviewed.invoiceId);
    const verified = await fetchInvoice(reviewed.invoiceId);
    outcome.verified = verified ? invoiceSnapshot(verified) : null;
    outcome.state = 'complete';
    if (verified?.Reference === PROPOSED_REFERENCE) {
      outcome.result = 'success';
    } else {
      outcome.result = 'error';
      outcome.reason = 'update-unverified';
    }
  } catch (error) {
    // A durable "updating" checkpoint remains if the provider mutation
    // succeeded but the process/reporting path failed. Operators must reconcile
    // it by re-reading Xero; it is never indistinguishable from "not attempted".
    outcome.state = outcome.state === 'updating' ? 'reconciliation-required' : 'complete';
    outcome.result = 'error';
    outcome.reason = error.message;
    if (error.xeroResponse) outcome.xeroResponse = error.xeroResponse;
    try {
      const finalInvoice = await fetchInvoice(reviewed.invoiceId);
      outcome.verified = finalInvoice ? invoiceSnapshot(finalInvoice) : null;
    } catch (verifyError) {
      outcome.verificationError = verifyError.message;
    }
  }
  await checkpoint(outcome);
  return outcome;
}

export async function buildDryRunManifest({
  tenant,
  xeroTenantId,
  invoices,
  loadHistory,
  now = () => new Date(),
  writeReport,
  signingSecret,
}) {
  const selected = [];
  const skipped = [];
  const summary = { scanned: 0, selected: 0, paid: 0, voided: 0, deleted: 0, notUnpaid: 0, alreadyCorrect: 0, unrelatedOrGenuinePo: 0 };
  for (const invoice of invoices) {
    summary.scanned++;
    const reason = classifyInvoice(invoice);
    if (reason === 'selected') {
      const snapshot = invoiceSnapshot(invoice);
      snapshot.membershipHistory = await loadHistory(invoice);
      selected.push(snapshot);
      summary.selected++;
    } else {
      if (reason === 'paid') summary.paid++;
      else if (reason === 'voided') summary.voided++;
      else if (reason === 'deleted') summary.deleted++;
      else if (reason === 'not-unpaid') summary.notUnpaid++;
      else if (reason === 'already-correct') summary.alreadyCorrect++;
      else summary.unrelatedOrGenuinePo++;
      // Persist full context only for legacy references. For unrelated invoices,
      // aggregate counts avoid putting the tenant's full ledger in this report.
      if (isLegacyMembershipReference(invoice.Reference)) {
        skipped.push({ ...invoiceSnapshot(invoice), reason });
      }
    }
  }
  const manifest = {
    repairKind: REPAIR_KIND,
    reportVersion: REPORT_VERSION,
    mode: 'dry-run',
    generatedAt: now().toISOString(),
    target: {
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      tenantName: tenant.name,
      xeroTenantId,
    },
    mutationCount: 0,
    summary,
    selected,
    skipped,
  };
  manifest.signature = signManifest(manifest, signingSecret);
  await writeReport(manifest);
  return manifest;
}
