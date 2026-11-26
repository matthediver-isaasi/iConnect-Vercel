import { loadOpportunityValueEvidence, netMinor } from './salesNetProjection.js';

// A commercial-sale receipt pins the converted version, even when the proposal
// is subsequently amended or archived. Draft/issued alternatives never count.
export function opportunityConvertedProjections(opportunities, quotes = [], versions = [], sales = []) {
  const quoteMap = new Map(quotes.map(row => [String(row.id), row]));
  const versionMap = new Map(versions.map(row => [String(row.id), row]));
  const byOpportunity = new Map();
  for (const sale of new Map(sales.map(row => [String(row.id), row])).values()) {
    const opportunityId = sale.opportunity_id || quoteMap.get(String(sale.quote_id))?.opportunity_id;
    if (!opportunityId) continue;
    const key = String(opportunityId);
    if (!byOpportunity.has(key)) byOpportunity.set(key, []);
    byOpportunity.get(key).push(sale);
  }
  return new Map(opportunities.map(opportunity => {
    const confirmed = byOpportunity.get(String(opportunity.id)) || [];
    const seenQuotes = new Set();
    let total = 0;
    let valid = true;
    for (const sale of confirmed) {
      const version = versionMap.get(String(sale.quote_version_id));
      const amount = netMinor(version?.net_minor);
      if (seenQuotes.has(String(sale.quote_id)) || !version
        || String(version.quote_id) !== String(sale.quote_id)
        || !opportunity.currency || version.currency !== opportunity.currency || amount === null) {
        valid = false;
        break;
      }
      seenQuotes.add(String(sale.quote_id));
      total += amount;
      if (!Number.isSafeInteger(total)) { valid = false; break; }
    }
    return [String(opportunity.id), {
      convertedValueMinor: valid ? total : null,
      convertedValueSource: valid ? 'proposal' : 'unavailable',
      convertedProposalCount: confirmed.length,
    }];
  }));
}

export async function loadOpportunityConvertedProjections(db, tenantId, opportunities) {
  const { quotes, versions, sales } = await loadOpportunityValueEvidence(
    db, tenantId, opportunities, { convertedOnly: true },
  );
  return opportunityConvertedProjections(opportunities, quotes, versions, sales);
}
