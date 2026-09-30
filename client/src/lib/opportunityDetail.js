const asArray = (value) => Array.isArray(value)
  ? value
  : Array.isArray(value?.data)
    ? value.data
    : Array.isArray(value?.items)
      ? value.items
      : [];

const firstCollection = (sources, aliases) => {
  for (const source of sources) {
    for (const alias of aliases) {
      if (source && Object.prototype.hasOwnProperty.call(source, alias)) {
        return asArray(source[alias]);
      }
    }
  }
  return [];
};

/**
 * Normalizes the current flattened fullDetail response and older nested
 * response shapes into the single shape consumed by OpportunityDetail.
 */
export function normalizeOpportunityDetail(response) {
  const value = response?.data || response || {};
  const opportunity = value.opportunity || value;
  const invoiceSource = [value, opportunity].find((source) => Object.prototype.hasOwnProperty.call(source || {}, "invoice"));
  // Wrapper-level collections take precedence, followed by collections
  // flattened onto the opportunity itself.
  const sources = value.opportunity ? [value, opportunity] : [opportunity];
  return {
    opportunity,
    permissions: value.permissions || value.capabilities
      || opportunity.permissions || opportunity.capabilities || {},
    invoice: invoiceSource ? invoiceSource.invoice : null,
    activeProvider: value.activeProvider ?? value.active_provider ?? opportunity.activeProvider ?? opportunity.active_provider ?? null,
    invoices: value.invoices ?? value.invoiceHistory ?? value.invoice_history
      ?? opportunity.invoices ?? opportunity.invoiceHistory ?? opportunity.invoice_history ?? [],
    invoiceQuoteId: value.invoiceQuoteId || value.invoice_quote_id
      || value.acceptedQuoteId || value.accepted_quote_id
      || value.acceptedQuote?.id || value.accepted_quote?.id
      || opportunity.invoiceQuoteId || opportunity.invoice_quote_id
      || opportunity.acceptedQuoteId || opportunity.accepted_quote_id
      || opportunity.acceptedQuote?.id || opportunity.accepted_quote?.id
      || value.invoice?.quoteId || value.invoice?.quote_id
      || value.invoice?.quote?.id
      || opportunity.invoice?.quoteId || opportunity.invoice?.quote_id
      || opportunity.invoice?.quote?.id || null,
    stages: firstCollection(sources, ["stages"]),
    collections: {
      contacts: firstCollection(sources, ["contacts", "contact-roles", "contactRoles", "contact_roles"]),
      collaborators: firstCollection(sources, ["collaborators"]),
      notes: firstCollection(sources, ["notes"]),
      tasks: firstCollection(sources, ["tasks"]),
      documents: firstCollection(sources, ["documents"]),
      activity: firstCollection(sources, ["activity", "activities"]),
      stageHistory: firstCollection(sources, ["stageHistory", "stage_history", "history"]),
    },
  };
}