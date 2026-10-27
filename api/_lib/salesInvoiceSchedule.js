import { randomUUID } from 'node:crypto';
import { SalesHttpError } from './salesAccess.js';
import { buildInvoice, customerFrom, buildSalesProviderIdempotencyKey, mapSalesInvoiceLink } from './salesAccounting.js';
import { productAccountingQueueEnabled, prepareSalesAccountingEnvelope } from './accountingProductProducer.js';
import { resolveAccountingQueueBinding } from './accountingQueueIntegration.js';
import { getActiveAccountingProvider, getAccountingProviderByName } from './accountingProvider.js';
import { sendTenantEmail } from './tenantEmailService.js';

export const SALES_SCHEDULE_SOURCE = 'sales_invoice_schedule';
export const salesScheduleEnabled = () => process.env.SALES_INVOICE_SCHEDULE_ENABLED === 'true'
  && productAccountingQueueEnabled(SALES_SCHEDULE_SOURCE);
const failure = (code, message, status = 409) => Object.assign(new SalesHttpError(status, message), { code });
const result = async query => {
  const { data, error } = await (typeof query?.abortSignal === 'function' ? query.abortSignal(AbortSignal.timeout(5000)) : query);
  if (error) throw error;
  return data;
};
async function boundedOperation(operation, timeoutMs = 10000) {
  let timer;
  try {
    return await Promise.race([operation(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(failure('SCHEDULE_OPERATION_TIMEOUT', 'Operation timed out; review any uncertain delivery outcome')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
export function scheduleLocalDate(timezone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now);
  return ['year', 'month', 'day'].map(key => parts.find(part => part.type === key).value).join('-');
}
export function scheduleDueDate(issueDate, days) {
  if (!Number.isSafeInteger(days) || days < 0 || days > 36500) throw failure('INVALID_PAYMENT_TERMS', 'Frozen payment terms are invalid');
  const date = new Date(`${issueDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
export async function getSalesSchedules(db, tenantId, saleId) {
  const rows = await result(db.from('sales_invoice_schedule').select('*').eq('tenant_id', tenantId)
    .eq('sale_id', saleId).order('planned_issue_date').order('id'));
  if (!rows?.length) return [];
  const links = await result(db.from('sales_accounting_invoice_link').select('*')
    .eq('tenant_id', tenantId).eq('sale_id', saleId));
  const requestIds = rows.map(row => row.accounting_request_id).filter(Boolean);
  const requests = requestIds.length ? await result(db.from('accounting_request_queue')
    .select('id,state,last_error,preparation_status,invoice_status').eq('tenant_id', tenantId).in('id', requestIds)) : [];
  return rows.map(row => {
    const { dispatch_claim_token: _dispatchToken, delivery_claim_token: _deliveryToken, ...presentation } = row;
    const link = links?.find(item => item.schedule_id === row.id);
    const request = requests?.find(item => item.id === row.accounting_request_id);
    return { ...presentation, invoice: link ? mapSalesInvoiceLink(link) : null,
      accounting_state: request?.state || null, last_error: row.last_error || request?.last_error || null,
      retry_at: row.status === 'invoiced' && row.delivery_status === 'rejected' ? row.next_attempt_at : null,
      can_retry: (request?.state === 'review' && request.preparation_status === 'pending' && request.invoice_status === 'pending')
        || (row.status === 'invoiced' && row.delivery_status === 'rejected'
          && (!row.next_attempt_at || Date.parse(row.next_attempt_at) <= Date.now()))
        || (salesScheduleEnabled() && !row.accounting_request_id && ['pending', 'blocked'].includes(row.status)
          && row.planned_issue_date <= scheduleLocalDate(row.timezone)),
    };
  });
}

// A group is an already-discounted monetary allocation, not a second sale of its
// component products. Exact line validation rejects unrepresentable tax pennies.
export function scheduleInvoiceLines(snapshot) {
  const entries = snapshot.invoiceLines || (snapshot.linePosition === null ? snapshot.contents : [snapshot]);
  if (!Array.isArray(entries) || !entries.length) throw failure('ACCOUNTING_GROUP_LINES_REQUIRED', 'Frozen remainder invoice lines are missing', 422);
  for (const key of ['netMinor', 'taxMinor', 'grossMinor']) {
    if (!Number.isSafeInteger(snapshot[key]) || snapshot[key] < 0
      || entries.reduce((sum, line) => sum + line[key], 0) !== snapshot[key]) {
      throw failure('ACCOUNTING_GROUP_TOTAL_MISMATCH', 'Frozen group totals do not reconcile', 422);
    }
  }
  return entries.map((line, index) => ({
    description: line.description ?? line.name ?? snapshot.name, quantity: '1', quoted_unit_price_minor: line.netMinor,
    discount_bps: 0, tax_rate_bps: line.taxRateBps, net_minor: line.netMinor,
    tax_minor: line.taxMinor, gross_minor: line.grossMinor, display_order: index,
    catalogue_snapshot: { tax_code: line.taxCode },
  }));
}

export async function dispatchSalesSchedule(db, tenantId, scheduleId, command = {}, dependencies = {}) {
  const schedule = await result(db.from('sales_invoice_schedule').select('*')
    .eq('tenant_id', tenantId).eq('id', scheduleId).maybeSingle());
  if (!schedule) throw failure('SCHEDULE_NOT_FOUND', 'Invoice schedule not found', 404);
  // Existing ownership is never replaced, including when rollout is disabled.
  if (schedule.accounting_request_id) {
    if (command.retry === true) {
      try {
        return await result(db.rpc('retry_sales_invoice_schedule_preparation', {
          p_tenant: tenantId, p_schedule: scheduleId, p_customer: command.providerCustomerId || null,
          p_confirm: command.confirmCustomerMatch === true, p_actor: command.actorId, p_actor_type: command.actorType,
        }));
      } catch (error) {
        const review = failure('SCHEDULE_RETRY_REQUIRES_REVIEW', error.code === 'P0001' ? error.message
          : 'Preparation retry could not be accepted; the original accounting request remains owned');
        review.details = schedule.last_error?.details || {};
        throw review;
      }
    }
    return schedule;
  }
  if (['queued', 'invoiced', 'no_invoice_required', 'attention'].includes(schedule.status)) return schedule;
  if (!(dependencies.enabled || salesScheduleEnabled)()) throw failure('SCHEDULE_DISABLED', 'Scheduled invoice automation is disabled');
  const issueDate = scheduleLocalDate(schedule.timezone, dependencies.now || new Date());
  if (schedule.planned_issue_date > issueDate) throw failure('SCHEDULE_NOT_DUE', 'This group is not due for issuance yet');
  const claimToken = command.dispatchClaimToken || randomUUID();
  if (!command.dispatchClaimToken) {
    const claimed = await result(db.rpc('claim_sales_schedule_dispatch', {
      p_tenant: tenantId, p_schedule: scheduleId, p_token: claimToken,
    }));
    if (claimed !== true) throw failure('SCHEDULE_DISPATCH_IN_PROGRESS', 'Another worker owns this due group; retry after its lease expires');
  } else if (schedule.dispatch_claim_token !== claimToken) {
    throw failure('SCHEDULE_DISPATCH_IN_PROGRESS', 'The dispatch lease has changed');
  }
  try {
    const frozen = schedule.snapshot;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(frozen.recipient?.email || '')) {
      throw failure('SCHEDULE_RECIPIENT_REQUIRED', 'The accepted billing recipient is missing or invalid; review the accepted proposal', 422);
    }
    const version = await result(db.from('sales_quote_version').select('*')
      .eq('tenant_id', tenantId).eq('id', schedule.quote_version_id).maybeSingle());
    if (!version || !['accepted', 'converted'].includes(version.status) || !version.billing_schedule) {
      throw failure('SCHEDULE_NOT_ACCEPTED', 'Only a durably accepted scheduled proposal may be invoiced');
    }
    const provider = await (dependencies.getActiveAccountingProvider || getActiveAccountingProvider)(tenantId);
    if (!['xero', 'quickbooks'].includes(provider)) throw failure('ACCOUNTING_PROVIDER_NONE', 'Configure an active accounting provider');
    const binding = await (dependencies.resolveBinding || resolveAccountingQueueBinding)({ db, tenantId, provider });
    const payload = await (dependencies.buildInvoice || buildInvoice)(db, tenantId, { id: schedule.sale_id },
      { ...version, currency: frozen.currency, net_minor: frozen.netMinor, tax_minor: frozen.taxMinor, gross_minor: frozen.grossMinor },
      scheduleInvoiceLines(frozen), provider, null);
    payload.issueDate = issueDate;
    payload.dueDate = scheduleDueDate(issueDate, frozen.paymentTerms?.days);
    payload.idempotencyKey = buildSalesProviderIdempotencyKey(tenantId, schedule.id, provider);
    // Validate provider representation locally before enqueue/contact creation.
    (dependencies.prepareEnvelope || prepareSalesAccountingEnvelope)({ provider, environment: binding.environment,
      payload: { ...payload, customerId: 'preflight' } });
    return await result(db.rpc('enqueue_sales_invoice_schedule', {
      p_tenant: tenantId, p_schedule: scheduleId, p_provider: provider,
      p_connection: binding.connectionId, p_company: binding.companyId,
      p_claim: claimToken,
      p_snapshot: { version: 1, preparation: true, environment: binding.environment, payment: null,
        invoice: { customer: customerFrom(version), payload, command: {
          providerCustomerId: command.providerCustomerId || null, confirmCustomerMatch: command.confirmCustomerMatch === true,
        } },
        linkage: { scheduleId, saleId: schedule.sale_id, quoteVersionId: version.id,
          actorId: command.actorId || 'sales-schedule-worker', actorType: command.actorType || 'system' },
      },
    }));
  } catch (error) {
    await result(db.from('sales_invoice_schedule').update({ status: 'blocked',
      last_error: { code: error.code || 'SCHEDULE_DISPATCH_FAILED', message: error.message, details: error.details || {} },
      next_attempt_at: new Date(Date.now() + 15 * 60000).toISOString(),
      dispatch_claim_token: null, dispatch_claimed_at: null,
    }).eq('tenant_id', tenantId).eq('id', scheduleId).is('accounting_request_id', null)
      .eq('dispatch_claim_token', claimToken).in('status', ['pending', 'blocked']));
    throw error;
  }
}

const escape = value => String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export async function deliverSalesSchedule(db, schedule, dependencies = {}) {
  const token = randomUUID();
  const claimed = await result(db.rpc('claim_sales_schedule_delivery', {
    p_tenant: schedule.tenant_id, p_schedule: schedule.id, p_token: token,
  }));
  if (!claimed) return { skipped: true };
  let sending = false;
  try {
    const link = await result(db.from('sales_accounting_invoice_link').select('*')
      .eq('tenant_id', schedule.tenant_id).eq('schedule_id', schedule.id).maybeSingle());
    if (!link) throw failure('SCHEDULE_LINK_MISSING', 'Verified invoice linkage is missing');
    const binding = await (dependencies.resolveBinding || resolveAccountingQueueBinding)({
      db, tenantId: schedule.tenant_id, provider: schedule.provider,
    });
    if (binding.companyId !== schedule.provider_company_id) throw failure('SCHEDULE_COMPANY_CHANGED', 'Reconnect the original accounting company before delivery');
    const provider = (dependencies.getProvider || getAccountingProviderByName)(schedule.provider);
    const pdf = await boundedOperation(() => provider.fetchInvoicePdf(link.provider_invoice_id, schedule.tenant_id),
      dependencies.operationTimeoutMs);
    if (!pdf || !Buffer.from(pdf).subarray(0, 5).equals(Buffer.from('%PDF-'))) throw failure('SCHEDULE_PDF_INVALID', 'Provider did not return an invoice PDF');
    const recipient = schedule.snapshot.recipient;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient?.email || '')) throw failure('SCHEDULE_RECIPIENT_REQUIRED', 'Frozen billing recipient is invalid');
    const branding = await (dependencies.loadBranding || (async tenantId => result(db.from('tenant')
      .select('name,logo_url,primary_color').eq('id', tenantId).maybeSingle())))(schedule.tenant_id);
    if (!branding?.name) throw failure('SCHEDULE_BRANDING_REQUIRED', 'Tenant email branding could not be loaded');
    const color = /^#[0-9a-f]{6}$/i.test(branding.primary_color || '') ? branding.primary_color : '#334155';
    const logo = /^https:\/\//i.test(branding.logo_url || '') ? `<img src="${escape(branding.logo_url)}" alt="${escape(branding.name)}" style="max-height:60px" />` : '';
    sending = true;
    const sent = await boundedOperation(() => (dependencies.send || sendTenantEmail)({
      tenantId: schedule.tenant_id, to: recipient.email,
      subject: `Invoice ${link.provider_invoice_number || ''} – ${schedule.snapshot.name}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px">${logo}<h2 style="color:${color}">${escape(branding.name)}</h2><p>Dear ${escape(recipient.name)},</p><p>Your invoice for ${escape(schedule.snapshot.name)} is attached.</p><p>Payment due: ${escape(schedule.due_date)}.</p></div>`,
      attachments: [{ filename: 'invoice.pdf', data: Buffer.from(pdf), contentType: 'application/pdf' }],
    }), dependencies.operationTimeoutMs);
    const status = sent?.success && sent.messageId ? 'sent' : sent?.ambiguousEffect === false ? 'rejected' : 'attention';
    await result(db.rpc('finish_sales_schedule_delivery', { p_tenant: schedule.tenant_id, p_schedule: schedule.id,
      p_token: token, p_status: status, p_message: sent?.messageId || null,
      p_error: status === 'sent' ? null : { code: 'SCHEDULE_EMAIL_FAILED', message: sent?.error || 'Email outcome is unknown; review before any resend' } }));
    return { status };
  } catch (error) {
    await result(db.rpc('finish_sales_schedule_delivery', { p_tenant: schedule.tenant_id, p_schedule: schedule.id,
      p_token: token, p_status: sending ? 'attention' : 'rejected', p_message: null,
      p_error: { code: error.code || 'SCHEDULE_DELIVERY_FAILED', message: error.message } }));
    return { status: sending ? 'attention' : 'rejected' };
  }
}

export async function runSalesInvoiceSchedule({ db, limit = 40 }, dependencies = {}) {
  const enabled = (dependencies.enabled || salesScheduleEnabled)();
  const counts = { enabled, examined: 0, queued: 0, blocked: 0, sent: 0, rejected: 0, attention: 0, deferred: 0 };
  const deadline = Date.now() + 50000;
  const rows = await result(db.rpc('due_sales_invoice_schedules', {
    p_limit: Math.min(100, Math.max(1, limit)), p_dispatch: enabled,
  }));
  for (const row of rows || []) {
    if (Date.now() > deadline - 25000) { counts.deferred = rows.length - counts.examined; break; }
    counts.examined++;
    if (row.status === 'invoiced') {
      try {
        const delivery = await deliverSalesSchedule(db, row, dependencies);
        if (delivery.status) counts[delivery.status]++;
      } catch { counts.attention++; }
      continue;
    }
    if (!enabled) { counts.deferred++; continue; }
    try {
      const dispatched = await dispatchSalesSchedule(db, row.tenant_id, row.id,
        { dispatchClaimToken: row.dispatch_claim_token }, dependencies);
      if (dispatched.status === 'queued') counts.queued++;
    } catch (error) {
      counts.blocked++;
    }
  }
  counts.health = await result(db.rpc('sales_invoice_schedule_health'));
  await result(db.rpc('finish_sales_invoice_schedule_run', { p_counts: counts }));
  return counts;
}
