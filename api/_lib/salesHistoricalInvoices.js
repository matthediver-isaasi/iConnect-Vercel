import { SalesHttpError } from './salesAccess.js';
import { getQuote } from './salesQuote.js';

export function historicalInvoiceNumber(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new SalesHttpError(400, 'Enter an existing invoice number of up to 100 characters.');
  }
  return value.trim();
}

export async function getHistoricalInvoiceStages(db, tenantId, quoteId) {
  const quote = await getQuote(db, tenantId, quoteId);
  const version = quote.currentVersion;
  const groups = version?.billing_schedule?.groups || version?.billingSchedule?.groups || [];
  if (!version || !groups.length) return { versionId: version?.id, stages: [] };
  const [references, schedules] = await Promise.all([
    db.from('sales_stage_historical_invoice').select('group_id,invoice_number')
      .eq('tenant_id', tenantId).eq('quote_version_id', version.id),
    db.from('sales_invoice_schedule').select('group_id,status,accounting_request_id,dispatch_claim_token')
      .eq('tenant_id', tenantId).eq('quote_version_id', version.id),
  ]);
  if (references.error) throw references.error;
  if (schedules.error) throw schedules.error;
  return { versionId: version.id, stages: groups.map(group => {
    const reference = references.data.find(row => row.group_id === group.id);
    const schedule = schedules.data.find(row => row.group_id === group.id);
    return { groupId: group.id, name: group.name, groupSnapshot: group, invoiceNumber: reference?.invoice_number || null,
      status: reference ? 'complete' : schedule?.status || version.status,
      canRecord: !reference && Number(group.grossMinor) > 0
        && ['draft', 'issued', 'sent', 'accepted', 'converted'].includes(version.status)
        && (!schedule || (['pending', 'blocked'].includes(schedule.status)
          && !schedule.accounting_request_id && !schedule.dispatch_claim_token)) };
  }) };
}

export async function recordHistoricalInvoice(db, actor, quoteId, command) {
  const invoiceNumber = historicalInvoiceNumber(command?.invoiceNumber);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (![quoteId, command?.versionId, command?.groupId].every(value => typeof value === 'string' && uuid.test(value))) {
    throw new SalesHttpError(400, 'Select a saved proposal version and billing stage.');
  }
  if (!command.expectedGroup || typeof command.expectedGroup !== 'object' || Array.isArray(command.expectedGroup)) {
    throw new SalesHttpError(400, 'Reload billing stages before recording an invoice.');
  }
  const { error } = await db.rpc('record_sales_stage_historical_invoice', {
    p_tenant: actor.tenantId, p_quote: quoteId, p_version: command.versionId,
    p_group: command.groupId, p_number: invoiceNumber, p_actor: actor.actorId, p_actor_type: actor.actorType,
    p_expected_group: command.expectedGroup,
  });
  if (error) {
    if (['PT409', '23514', '23505'].includes(error.code)) throw new SalesHttpError(409, error.message);
    throw error;
  }
  return { recorded: true };
}
