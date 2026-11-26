import { SalesHttpError } from './salesAccess.js';
import { isTicketClosed } from '../../shared/ticketRelease.js';
import { enrichSalesTicketEventOptions } from './salesTicketPricing.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Sales-only projection: never use this endpoint for public event discovery. */
export async function listSalesTicketEventOptions(db, tenantId, options = {}) {
  const selectedId = options.selectedId || null;
  if (selectedId && (!uuid.test(selectedId) || !['simple', 'complex'].includes(options.kind))) {
    throw new SalesHttpError(400, 'Invalid selected event');
  }
  const page = Math.max(1, Math.min(10000, Number.parseInt(options.page, 10) || 1));
  const { data, error } = await db.rpc('sales_ticket_event_options', {
    p_tenant: tenantId,
    p_search: String(options.search || options.q || '').trim().slice(0, 150),
    p_page: page,
    p_selected: selectedId,
    p_kind: selectedId ? options.kind : null,
  });
  if (error) {
    if (['PGRST202', '42883'].includes(error.code)) {
      throw new SalesHttpError(503, 'Ticket event search requires the proposal ticket discovery database update.');
    }
    throw error;
  }
  if (!data || !Array.isArray(data.items)) throw new SalesHttpError(503, 'Ticket event search is unavailable');
  if (!options.withPricing) return data;
  const currency = /^[A-Za-z]{3}$/.test(String(options.currency || '')) ? String(options.currency).toUpperCase() : null;
  return enrichSalesTicketEventOptions(db, tenantId, data, { currency, dependencies: options.dependencies });
}

export async function assertSalesTicketEventSelectable(db, tenantId, reference) {
  const result = await listSalesTicketEventOptions(db, tenantId, {
    selectedId: reference.eventId, kind: reference.kind,
  });
  const event = result.items[0];
  if (!event || event.eligible !== true) {
    throw new SalesHttpError(400, `${event?.unavailableReason || 'This event is unavailable.'} Choose a future event with tickets.`);
  }
  if (!event.ticketOptions?.some(ticket => String(ticket.id) === String(reference.ticketTypeId) && !isTicketClosed(ticket))) {
    throw new SalesHttpError(400, 'This ticket type is no longer available. Choose another ticket type.');
  }
}
