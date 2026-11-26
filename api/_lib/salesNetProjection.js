// Read-side only: conversion historically copied gross into opportunity.value_minor.
// Never mutate that history or infer a tax rate from it.
export function netMinor(value) {
  if (value == null || value === '' || !['number', 'string'].includes(typeof value)) return null;
  const amount = Number(value);
  return Number.isSafeInteger(amount) ? amount : null;
}

export function opportunityNetProjections(opportunities, quotes = [], versions = [], sales = []) {
  const versionMap = new Map(versions.map(row => [String(row.id), row]));
  const currentVersions = new Map(versions.map(row => [`${row.quote_id}:${row.version_number}`, row]));
  const quotesByOpportunity = new Map();
  const salesByOpportunity = new Map();
  const quoteMap = new Map(quotes.map(row => [String(row.id), row]));
  const add = (map, id, row) => {
    if (!id) return;
    const key = String(id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  };
  quotes.forEach(row => add(quotesByOpportunity, row.opportunity_id, row));
  sales.forEach(row => add(salesByOpportunity, row.opportunity_id || quoteMap.get(String(row.quote_id))?.opportunity_id, row));
  return new Map(opportunities.map(opportunity => {
    const linkedQuotes = quotesByOpportunity.get(String(opportunity.id)) || [];
    const confirmed = salesByOpportunity.get(String(opportunity.id)) || [];
    const unavailable = { netValueMinor: null, netValueSource: 'unavailable' };
    let evidence;
    if (confirmed.length) {
      evidence = confirmed.map(row => versionMap.get(String(row.quote_version_id)));
    } else {
      const current = linkedQuotes.filter(row => !row.archived_at);
      // No single proposal owns the estimate when several are linked.
      if (current.length > 1) return [String(opportunity.id), unavailable];
      if (current.length === 1) {
        evidence = [currentVersions.get(`${current[0].id}:${current[0].current_version}`)];
      } else if (linkedQuotes.length) return [String(opportunity.id), unavailable];
    }
    if (evidence) {
      if (evidence.some(row => !row || row.currency !== opportunity.currency || netMinor(row.net_minor) === null)) {
        return [String(opportunity.id), unavailable];
      }
      const total = evidence.reduce((sum, row) => sum + netMinor(row.net_minor), 0);
      return [String(opportunity.id), Number.isSafeInteger(total)
        ? { netValueMinor: total, netValueSource: 'proposal' } : unavailable];
    }
    return [String(opportunity.id), {
      netValueMinor: netMinor(opportunity.value_minor), netValueSource: 'manual',
    }];
  }));
}

// Page every source and batch IDs: PostgREST's row cap must not turn missing
// evidence into a manual estimate. Used only for explicitly requested values.
export async function loadOpportunityValueEvidence(db, tenantId, opportunities, { convertedOnly = false } = {}) {
  const read = async (table, key, ids, columns) => {
    const rows = [];
    for (let start = 0; start < ids.length; start += 100) {
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await db.from(table).select(columns).eq('tenant_id', tenantId)
          .in(key, ids.slice(start, start + 100)).order('id').range(offset, offset + 999);
        if (error) throw error;
        rows.push(...(data || []));
        if (rows.length > 50000) throw new Error('Net value evidence exceeds the maximum scan');
        if ((data || []).length < 1000) break;
      }
    }
    return rows;
  };
  const ids = opportunities.map(row => row.id);
  const [quotes, directSales] = await Promise.all([
    read('sales_quote', 'opportunity_id', ids, 'id,opportunity_id,current_version,archived_at'),
    read('sales_commercial_sale', 'opportunity_id', ids, 'id,opportunity_id,quote_id,quote_version_id'),
  ]);
  const linkedSales = await read('sales_commercial_sale', 'quote_id', quotes.map(row => row.id),
    'id,opportunity_id,quote_id,quote_version_id');
  const sales = [...new Map([...directSales, ...linkedSales].map(row => [String(row.id), row])).values()];
  const versions = await read('sales_quote_version', convertedOnly ? 'id' : 'quote_id',
    [...new Set(convertedOnly ? sales.map(row => row.quote_version_id)
      : [...quotes.map(row => row.id), ...sales.map(row => row.quote_id)])].filter(Boolean),
    'id,quote_id,version_number,net_minor,currency');
  return { quotes, versions, sales };
}

export async function loadOpportunityNetProjections(db, tenantId, opportunities) {
  const { quotes, versions, sales } = await loadOpportunityValueEvidence(db, tenantId, opportunities);
  return opportunityNetProjections(opportunities, quotes, versions, sales);
}

export function netPipelineGroups(rows) {
  return [...new Set(rows.map(row => row.currency))].sort().map(currency => {
    const items = rows.filter(row => row.currency === currency);
    const complete = items.every(row => row.netValueMinor != null);
    return {
      currency, count: items.length, unavailableCount: items.filter(row => row.netValueMinor == null).length,
      valueMinor: complete ? items.reduce((sum, row) => sum + row.netValueMinor, 0) : null,
      weightedValueMinor: complete ? items.reduce((sum, row) =>
        sum + Math.round(row.netValueMinor * Number(row.stage?.probability || 0) / 100), 0) : null,
    };
  });
}
