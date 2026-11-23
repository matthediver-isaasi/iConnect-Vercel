/** A genuinely absent legacy price config is not an empty/private ticket list. */
export function funnelSimpleTickets(event) {
  if (event?.pricing_config == null || event.pricing_config === '') {
    const price = event.ticket_price == null ? 0 : Number(event.ticket_price);
    if (!Number.isFinite(price) || price < 0) throw new Error('Legacy event pricing is unavailable.');
    return [{ id: 'default', name: 'Admission', price, currency: event.currency || 'gbp',
      is_free: price === 0, visibility_mode: 'members_and_public', is_unlimited_tickets: true }];
  }
  const config = typeof event.pricing_config === 'string' ? JSON.parse(event.pricing_config) : event.pricing_config;
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || config.ticket_classes != null && !Array.isArray(config.ticket_classes)) throw new Error('Event ticket configuration is invalid.');
  return config.ticket_classes || [];
}
