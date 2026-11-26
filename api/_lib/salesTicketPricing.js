import { SalesHttpError } from './salesAccess.js';
import { resolveTicketPrice } from './complexEventPricing.js';
import { listCatalogueTaxOptions } from './salesCatalogueTaxOptions.js';

// Sales proposal ticket lines take their commercial terms from the ticket.
// Event ticket prices are final, VAT-inclusive checkout amounts (see the event
// invoice producer), so proposal lines use the equivalent net unit price.

function throwDb(error) { if (error) throw error; }

function pricingConfigTickets(pricingConfig) {
  let config = pricingConfig;
  if (typeof config === 'string') {
    try { config = JSON.parse(config); } catch { return []; }
  }
  return Array.isArray(config?.ticket_classes) ? config.ticket_classes : [];
}

/**
 * Synced provider codes are optional for this projection. A tenant without an
 * accounting provider still sees the ticket VAT rate, just without a code.
 */
export async function loadSalesTicketTaxOptions(db, tenantId, dependencies = {}) {
  try {
    return await listCatalogueTaxOptions(db, tenantId, dependencies);
  } catch (error) {
    if (error instanceof SalesHttpError && error.status === 409) return null;
    throw error;
  }
}

export function salesTicketPricing(ticket, { currency, taxOptions } = {}) {
  const resolved = resolveTicketPrice([ticket], ticket?.id);
  const ticketCurrency = String(resolved.currency || 'gbp').toUpperCase();
  const price = Number(resolved.price);
  const percentageValue = ticket?.vat_rate_percentage;
  const percentage = percentageValue == null || percentageValue === '' ? 0 : Number(percentageValue);
  const key = ticket?.vat_rate_key ? String(ticket.vat_rate_key) : null;
  const vat = {
    key, label: ticket?.vat_rate_label || null,
    percentage: percentageValue == null || percentageValue === '' ? null : percentage,
    rateBps: Number.isFinite(percentage) ? Math.round(percentage * 100) : null,
  };
  let unavailableReason = null;
  if (!resolved.found) unavailableReason = 'This ticket type is unavailable.';
  else if (!Number.isFinite(price) || price < 0 || !Number.isSafeInteger(Math.round(price * 100))) unavailableReason = 'This ticket price is invalid.';
  else if (!Number.isFinite(percentage) || percentage < 0 || vat.rateBps > 100000) unavailableReason = 'This ticket VAT setting is invalid.';
  else if (currency && String(currency).toUpperCase() !== ticketCurrency) {
    unavailableReason = `This ticket is priced in ${ticketCurrency}, but the proposal currency is ${String(currency).toUpperCase()}.`;
  }
  const grossUnitPriceMinor = unavailableReason ? null : Math.round(price * 100);
  const unitPriceMinor = unavailableReason ? null
    : Math.round(grossUnitPriceMinor * 10000 / (10000 + vat.rateBps));
  const match = key && Array.isArray(taxOptions?.items)
    ? taxOptions.items.find(item => item.id === key && item.selectable !== false) : null;
  const taxCode = match ? { provider: taxOptions.provider, id: match.id, name: match.name, rateBps: match.rateBps } : null;
  return {
    priceCurrency: ticketCurrency, grossUnitPriceMinor, unitPriceMinor,
    isEarlyBird: !unavailableReason && !ticket?.is_free && price !== Number(ticket?.price || 0),
    vat, taxCode, taxRateBps: taxCode ? taxCode.rateBps : vat.rateBps,
    // A selector is only meaningful when synced provider codes exist.
    taxCodeRequired: !taxCode && Boolean(taxOptions?.items?.length),
    priceUnavailableReason: unavailableReason,
  };
}

/** Adds ticket price and VAT details to the Sales ticket discovery projection. */
export async function enrichSalesTicketEventOptions(db, tenantId, data, { currency, dependencies } = {}) {
  const items = Array.isArray(data?.items) ? data.items : [];
  const simpleIds = items.filter(item => item.kind === 'simple').map(item => item.id);
  const complexIds = items.filter(item => item.kind === 'complex').map(item => item.id);
  if (!simpleIds.length && !complexIds.length) return data;
  const [simple, complex, taxOptions] = await Promise.all([
    simpleIds.length ? db.from('event').select('id,pricing_config').eq('tenant_id', tenantId).in('id', simpleIds) : { data: [] },
    complexIds.length ? db.from('complex_event_ticket_class').select('*').eq('tenant_id', tenantId).in('complex_event_id', complexIds) : { data: [] },
    loadSalesTicketTaxOptions(db, tenantId, dependencies),
  ]);
  throwDb(simple.error);
  throwDb(complex.error);
  const tickets = new Map();
  for (const event of simple.data || []) {
    for (const ticket of pricingConfigTickets(event.pricing_config)) tickets.set(`simple:${event.id}:${ticket.id}`, ticket);
  }
  for (const ticket of complex.data || []) tickets.set(`complex:${ticket.complex_event_id}:${ticket.id}`, ticket);
  return {
    ...data,
    items: items.map(item => ({
      ...item,
      ticketOptions: (item.ticketOptions || []).map(option => {
        const ticket = tickets.get(`${item.kind}:${item.id}:${option.id}`);
        return ticket ? { ...option, ...salesTicketPricing(ticket, { currency, taxOptions }) }
          : { ...option, unitPriceMinor: null, priceUnavailableReason: 'This ticket price could not be loaded.' };
      }),
    })),
  };
}

/** Server-authoritative ticket terms for a proposal ticket line. */
export async function resolveSalesTicketLinePricing(db, tenantId, reference, currency, dependencies = {}) {
  let eventTitle;
  let ticket;
  if (reference.kind === 'simple') {
    const result = await db.from('event').select('id,tenant_id,title,pricing_config')
      .eq('id', reference.eventId).eq('tenant_id', tenantId).maybeSingle();
    throwDb(result.error);
    if (!result.data) throw new SalesHttpError(400, 'Event reference does not belong to this tenant');
    eventTitle = result.data.title;
    ticket = pricingConfigTickets(result.data.pricing_config).find(item => String(item.id) === String(reference.ticketTypeId));
  } else {
    const eventResult = await db.from('complex_event').select('id,tenant_id,title')
      .eq('id', reference.eventId).eq('tenant_id', tenantId).maybeSingle();
    throwDb(eventResult.error);
    if (!eventResult.data) throw new SalesHttpError(400, 'Complex event reference does not belong to this tenant');
    eventTitle = eventResult.data.title;
    const ticketResult = await db.from('complex_event_ticket_class').select('*')
      .eq('id', reference.ticketTypeId).eq('tenant_id', tenantId)
      .eq('complex_event_id', reference.eventId).maybeSingle();
    throwDb(ticketResult.error);
    ticket = ticketResult.data;
  }
  if (!ticket) throw new SalesHttpError(400, 'Ticket type does not belong to the referenced event');
  const taxOptions = await loadSalesTicketTaxOptions(db, tenantId, dependencies);
  const pricing = salesTicketPricing(ticket, { currency, taxOptions });
  if (pricing.priceUnavailableReason) throw new SalesHttpError(400, pricing.priceUnavailableReason);
  return { ...pricing, eventTitle: eventTitle || 'Event', ticketName: ticket.name || 'Ticket' };
}
