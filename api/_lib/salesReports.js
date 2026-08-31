import { SalesHttpError } from './salesAccess.js';
import { mergeTicketCommercialCapacity } from './eventCommercialCapacity.js';

export const SALES_REPORT_MAX_SCAN = 50000;
export const SALES_REPORT_MAX_PAGE_SIZE = 100;
const SALES_REPORT_READ_PAGE_SIZE = 1000;

const IMMUTABLE_QUOTE_STATUSES = new Set([
  'issued', 'sent', 'accepted', 'declined', 'expired', 'superseded', 'converted',
]);
const REPORT_ALIASES = Object.freeze({
  loss_reasons: 'losses', deal_size: 'deal-size', sales_cycle: 'sales-cycle',
});
const REPORTS = new Set([
  'pipeline', 'quotes', 'sales', 'owners', 'products', 'bundles', 'categories',
  'conversion', 'losses', 'deal-size', 'sales-cycle', 'allocations', 'organisations', 'events',
]);
const dateValue = (value) => value ? Date.parse(value) : NaN;
const number = (value) => {
  const result = Number(value || 0);
  if (!Number.isSafeInteger(result)) throw new SalesHttpError(422, 'A monetary value exceeds the safe minor-unit range');
  return result;
};
const values = (value) => value == null || value === '' ? [] : String(value).split(',').map((part) => part.trim()).filter(Boolean);
const has = (filter, value) => !filter.length || filter.includes(String(value ?? ''));
const dateInRange = (value, filters) => {
  if (!filters.from && !filters.to) return true;
  const time = dateValue(value);
  if (!Number.isFinite(time)) return false;
  return (!filters.from || time >= dateValue(`${filters.from}T00:00:00.000Z`))
    && (!filters.to || time < dateValue(`${filters.to}T00:00:00.000Z`) + 86400000);
};
const byId = (rows) => new Map((rows || []).map((row) => [String(row.id), row]));

export function parseSalesReportQuery(query = {}) {
  const requestedMode = query.mode || query.view || 'dashboard';
  const mode = query.export === 'csv' || query.format === 'csv' ? 'export' : requestedMode;
  if (!['dashboard', 'report', 'organisation', 'organization', 'event', 'export'].includes(mode)) {
    throw new SalesHttpError(400, 'mode must be dashboard, report, organisation, event, or export');
  }
  const requestedReport = query.report || (mode === 'organisation' || mode === 'organization' ? 'organisations'
    : mode === 'event' ? 'events' : mode === 'dashboard' ? 'pipeline' : 'sales');
  const report = REPORT_ALIASES[requestedReport] || requestedReport;
  if (!REPORTS.has(report)) throw new SalesHttpError(400, 'Unknown Sales report');
  const page = Number(query.page || 1);
  const pageSize = Number(query.pageSize || 25);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize)
      || pageSize < 1 || pageSize > SALES_REPORT_MAX_PAGE_SIZE) {
    throw new SalesHttpError(400, `page and pageSize (maximum ${SALES_REPORT_MAX_PAGE_SIZE}) are invalid`);
  }
  const date = (name) => {
    if (query[name] == null || query[name] === '') return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(query[name]))
        || !Number.isFinite(Date.parse(`${query[name]}T00:00:00.000Z`))) {
      throw new SalesHttpError(400, `${name} must be an ISO date`);
    }
    return String(query[name]);
  };
  const from = date('from') || date('dateFrom');
  const to = date('to') || date('dateTo');
  if (from && to && from > to) throw new SalesHttpError(400, 'from must not be after to');
  if (from && to && dateValue(to) - dateValue(from) > 10 * 366 * 86400000) {
    throw new SalesHttpError(400, 'Date range must not exceed ten years');
  }
  const text = (names) => {
    const value = names.map((name) => query[name]).find((item) => item != null);
    if (value != null && String(value).length > 500) throw new SalesHttpError(400, `${names[0]} filter is too long`);
    const result = values(value);
    if (result.length > 50) throw new SalesHttpError(400, `${names[0]} accepts at most 50 values`);
    return result;
  };
  const currency = text(['currency']).map((item) => item.toUpperCase());
  if (currency.some((item) => !/^[A-Z]{3}$/.test(item))) throw new SalesHttpError(400, 'currency must contain ISO-4217 codes');
  return {
    mode, report, requestedReport, page, pageSize, from, to, currency,
    owner: text(['owner', 'ownerId']), organisation: text(['organisation', 'organisationId', 'organizationId']),
    event: text(['event', 'eventId']), product: text(['product', 'productId']),
    bundle: text(['bundle', 'bundleId']), category: text(['category', 'categoryId']),
    stage: text(['stage', 'stageId']), status: text(['status']), lossReason: text(['lossReason', 'lossReasonId']),
  };
}

export const salesReportMetricMetadata = Object.freeze({
  dates: {
    filter: 'inclusive UTC calendar dates',
    pipeline: 'expected_close_date', quotes: 'issued_at (falling back to issue_date)',
    sales: 'sales_commercial_sale.created_at',
  },
  money: {
    unit: 'minor', fields: ['netMinor', 'taxMinor', 'grossMinor', 'valueMinor', 'weightedValueMinor'],
    currencyAggregation: 'separate; values in different currencies are never added',
  },
  pipeline: { source: 'opportunity.value_minor and opportunity_stage.probability', probabilityDenominator: 100 },
  quotes: {
    source: 'latest immutable issued sales_quote_version per sales_quote',
    includedStatuses: ['issued', 'sent', 'accepted', 'declined', 'expired', 'superseded', 'converted'],
    excludedStatuses: ['draft'],
  },
  sales: { source: 'sales_commercial_sale joined to its immutable sales_quote_version' },
  invoices: {
    source: 'sales_accounting_invoice_link.provider_status',
    statuses: ['draft', 'authorised', 'open', 'paid', 'voided', 'deleted', 'unknown'],
  },
  conversion: { denominator: 'commercial sales plus lost opportunities in the filtered cohort' },
  allocation: { source: 'sales_commercial_allocation_totals', availableFormula: 'max(0, remaining - named - reserved)' },
});

export const salesReportDefinitions = Object.freeze({
  description: 'Sales values use accepted commercial records and immutable quote versions. Monetary totals are shown separately by currency and never converted.',
  reports: [
    { key: 'pipeline', description: 'Open opportunities by expected close date; weighted value uses the current stage probability.' },
    { key: 'owners', description: 'Confirmed commercial sales grouped by opportunity owner and currency.' },
    { key: 'products', description: 'Confirmed commercial quote lines grouped by product and currency.' },
    { key: 'bundles', description: 'Confirmed commercial quote lines grouped by bundle and currency.' },
    { key: 'categories', description: 'Confirmed commercial quote lines grouped by catalogue category and currency.' },
    { key: 'organisations', description: 'Confirmed commercial sales grouped by the existing Organisation record.' },
    { key: 'events', description: 'Commercial sales and allocation capacity reconciled with confirmed direct bookings.' },
    { key: 'conversion', description: 'Confirmed commercial sales divided by confirmed sales plus lost opportunities in the selected cohort.' },
    { key: 'loss_reasons', description: 'Lost opportunities grouped by their recorded loss reason.' },
    { key: 'deal_size', description: 'Average confirmed gross sale value, separated by currency.' },
    { key: 'sales_cycle', description: 'Calendar days from opportunity creation to commercial sale confirmation.' },
  ],
});

function moneyGroups(rows, value) {
  const groups = new Map();
  for (const row of rows) {
    const currency = row.currency;
    if (!currency) continue;
    const current = groups.get(currency) || { currency, count: 0, netMinor: 0, taxMinor: 0, grossMinor: 0 };
    current.count += 1;
    const amounts = value(row);
    current.netMinor += number(amounts.netMinor);
    current.taxMinor += number(amounts.taxMinor);
    current.grossMinor += number(amounts.grossMinor);
    groups.set(currency, current);
  }
  return [...groups.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

function prepare(data, filters) {
  const stages = byId(data.stages);
  const reasons = byId(data.lossReasons);
  const organisations = byId(data.organisations);
  const opportunities = (data.opportunities || []).map((row) => ({
    ...row, stage: stages.get(String(row.stage_id)) || null,
    lossReason: reasons.get(String(row.loss_reason_id)) || null,
    organisation: organisations.get(String(row.organization_id)) || null,
  }));
  const opportunityMap = byId(opportunities);
  const quotes = byId(data.quotes);
  const versionsByQuote = new Map();
  for (const version of data.versions || []) {
    if (!IMMUTABLE_QUOTE_STATUSES.has(version.status)) continue;
    const previous = versionsByQuote.get(String(version.quote_id));
    if (!previous || Number(version.version_number) > Number(previous.version_number)) {
      versionsByQuote.set(String(version.quote_id), version);
    }
  }
  const linesByVersion = new Map();
  for (const line of data.lines || []) {
    const key = String(line.quote_version_id);
    if (!linesByVersion.has(key)) linesByVersion.set(key, []);
    linesByVersion.get(key).push(line);
  }
  const lineMatches = (version) => {
    if (![filters.product, filters.bundle, filters.category, filters.event].some((item) => item.length)) return true;
    const lines = linesByVersion.get(String(version.id)) || [];
    return lines.some((line) => {
      const snapshot = line.catalogue_snapshot || {};
      const event = snapshot.event_id || snapshot.eventId;
      return has(filters.product, line.product_id)
        && has(filters.bundle, line.bundle_id)
        && has(filters.category, snapshot.category_id || snapshot.categoryId)
        && has(filters.event, event || version.event_snapshot?.id);
    });
  };
  const commonOpportunity = (opportunity) => !opportunity || (
    has(filters.owner, opportunity.owner_id)
    && has(filters.organisation, opportunity.organization_id)
    && has(filters.stage, opportunity.stage_id)
    && has(filters.lossReason, opportunity.loss_reason_id)
  );
  const quoteRows = [...versionsByQuote.entries()].map(([quoteId, version]) => {
    const quote = quotes.get(quoteId) || {};
    const opportunity = opportunityMap.get(String(quote.opportunity_id));
    return {
      id: version.id, quoteId, quoteNumber: quote.quote_number || null,
      opportunityId: quote.opportunity_id || null, organisationId: opportunity?.organization_id
        || version.organisation_snapshot?.id || null,
      organisationName: opportunity?.organisation?.name || version.organisation_snapshot?.name || null,
      ownerId: opportunity?.owner_id || version.salesperson_snapshot?.id || null,
      status: version.status, currency: version.currency, netMinor: number(version.net_minor),
      taxMinor: number(version.tax_minor), grossMinor: number(version.gross_minor),
      date: version.issued_at || version.issue_date || null, eventId: version.event_snapshot?.id || null,
      _version: version, _opportunity: opportunity,
    };
  }).filter((row) => commonOpportunity(row._opportunity)
    && has(filters.organisation, row.organisationId) && has(filters.owner, row.ownerId)
    && has(filters.currency, row.currency) && has(filters.status, row.status)
    && has(filters.event, row.eventId) && dateInRange(row.date, filters) && lineMatches(row._version));
  const invoiceBySale = new Map();
  for (const invoice of data.invoices || []) {
    const list = invoiceBySale.get(String(invoice.sale_id)) || [];
    list.push({ provider: invoice.provider, status: invoice.provider_status, number: invoice.provider_invoice_number || null });
    invoiceBySale.set(String(invoice.sale_id), list);
  }
  const quoteRowByVersion = new Map(quoteRows.map((row) => [String(row.id), row]));
  const sales = (data.sales || []).map((sale) => {
    const version = (data.versions || []).find((item) => String(item.id) === String(sale.quote_version_id));
    const quote = quotes.get(String(sale.quote_id)) || {};
    const opportunity = opportunityMap.get(String(sale.opportunity_id || quote.opportunity_id));
    return {
      id: sale.id, saleId: sale.id, quoteId: sale.quote_id, quoteVersionId: sale.quote_version_id,
      quoteNumber: quote.quote_number || null, opportunityId: sale.opportunity_id || null,
      organisationId: opportunity?.organization_id || version?.organisation_snapshot?.id || null,
      organisationName: opportunity?.organisation?.name || version?.organisation_snapshot?.name || null,
      ownerId: opportunity?.owner_id || version?.salesperson_snapshot?.id || null,
      currency: version?.currency, netMinor: number(version?.net_minor), taxMinor: number(version?.tax_minor),
      grossMinor: number(version?.gross_minor), date: sale.created_at, eventId: version?.event_snapshot?.id || null,
      invoiceStatuses: invoiceBySale.get(String(sale.id)) || [], _opportunity: opportunity, _version: version,
    };
  }).filter((row) => row._version && commonOpportunity(row._opportunity)
    && has(filters.organisation, row.organisationId) && has(filters.owner, row.ownerId)
    && has(filters.currency, row.currency) && has(filters.event, row.eventId)
    && dateInRange(row.date, filters) && lineMatches(row._version));
  return {
    opportunities, quoteRows, sales, quoteRowByVersion, linesByVersion,
    invoiceBySale, opportunityMap, quotes, versionsByQuote,
  };
}

const clean = (row) => Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith('_')));
const stable = (rows) => rows.map(clean).sort((a, b) => String(a.id || a.key).localeCompare(String(b.id || b.key)));
const groupRows = (rows, keyFor, labelFor) => {
  const groups = new Map();
  for (const row of rows) {
    const id = keyFor(row) || 'unassigned';
    const current = groups.get(id) || { id, name: labelFor(row) || 'Unassigned', sales: [] };
    current.sales.push(row);
    groups.set(id, current);
  }
  return [...groups.values()].map((group) => ({
    id: group.id, name: group.name, saleCount: group.sales.length,
    values: moneyGroups(group.sales, (row) => row),
  })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
};

function commercialLineGroups(sales, linesByVersion, kind) {
  const groups = new Map();
  for (const sale of sales) {
    for (const line of linesByVersion.get(String(sale.quoteVersionId)) || []) {
      const snapshot = line.catalogue_snapshot || {};
      let id; let name;
      if (kind === 'products' && line.product_id) {
        id = line.product_id; name = snapshot.name || line.description;
      } else if (kind === 'bundles' && line.bundle_id) {
        id = line.bundle_id; name = snapshot.name || line.description;
      } else if (kind === 'categories') {
        id = snapshot.category_id || snapshot.categoryId;
        name = snapshot.category_name || snapshot.categoryName;
      }
      if (!id) continue;
      const key = `${id}:${sale.currency}`;
      const current = groups.get(key) || {
        id, name: name || id, currency: sale.currency, saleIds: new Set(),
        quantity: 0, netMinor: 0, taxMinor: 0, grossMinor: 0,
      };
      current.saleIds.add(sale.id);
      current.quantity += Number(line.quantity || 0);
      current.netMinor += number(line.net_minor);
      current.taxMinor += number(line.tax_minor);
      current.grossMinor += number(line.gross_minor);
      groups.set(key, current);
    }
  }
  return [...groups.values()].map(({ saleIds, ...row }) => ({ ...row, saleCount: saleIds.size }))
    .sort((a, b) => `${a.id}:${a.currency}`.localeCompare(`${b.id}:${b.currency}`));
}

function ownerGroups(sales) {
  const groups = new Map();
  for (const sale of sales) {
    const id = sale.ownerId || 'unassigned';
    const snapshot = sale._version?.salesperson_snapshot || {};
    const key = `${id}:${sale.currency}`;
    const current = groups.get(key) || {
      id, name: snapshot.name || snapshot.email || id, currency: sale.currency,
      saleCount: 0, netMinor: 0, taxMinor: 0, grossMinor: 0,
    };
    current.saleCount += 1;
    current.netMinor += sale.netMinor; current.taxMinor += sale.taxMinor; current.grossMinor += sale.grossMinor;
    groups.set(key, current);
  }
  return [...groups.values()].sort((a, b) => `${a.id}:${a.currency}`.localeCompare(`${b.id}:${b.currency}`));
}

export function buildSalesReport(data = {}, filters) {
  const prepared = prepare(data, filters);
  const open = prepared.opportunities.filter((row) => !row.stage?.is_won && !row.stage?.is_lost
    && has(filters.owner, row.owner_id) && has(filters.organisation, row.organization_id)
    && has(filters.stage, row.stage_id) && has(filters.currency, row.currency)
    && dateInRange(row.expected_close_date, filters));
  const pipelineRows = stable(open.map((row) => ({
    id: row.id, name: row.name, organisationId: row.organization_id, organisationName: row.organisation?.name || null,
    ownerId: row.owner_id, stageId: row.stage_id, stageName: row.stage?.name || null,
    probability: Number(row.stage?.probability || 0), currency: row.currency,
    valueMinor: number(row.value_minor), weightedValueMinor: Math.round(number(row.value_minor) * Number(row.stage?.probability || 0) / 100),
    expectedCloseDate: row.expected_close_date,
  })));
  const pipeline = [...new Set(pipelineRows.map((row) => row.currency))].sort().map((currency) => ({
    currency, count: pipelineRows.filter((row) => row.currency === currency).length,
    valueMinor: pipelineRows.filter((row) => row.currency === currency).reduce((sum, row) => sum + row.valueMinor, 0),
    weightedValueMinor: pipelineRows.filter((row) => row.currency === currency).reduce((sum, row) => sum + row.weightedValueMinor, 0),
  }));
  const lost = prepared.opportunities.filter((row) => row.stage?.is_lost
    && has(filters.owner, row.owner_id) && has(filters.organisation, row.organization_id)
    && has(filters.lossReason, row.loss_reason_id) && has(filters.currency, row.currency)
    && dateInRange(row.lost_at, filters));
  const losses = [...new Map(lost.map((row) => [String(row.loss_reason_id || 'unspecified'), {
    id: row.loss_reason_id || 'unspecified', name: row.lossReason?.name || 'Unspecified',
  }])).values()].map((reason) => ({
    ...reason, count: lost.filter((row) => String(row.loss_reason_id || 'unspecified') === String(reason.id)).length,
  })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const closed = prepared.sales.length + lost.length;
  const conversion = {
    wonCount: prepared.sales.length, lostCount: lost.length, denominator: closed,
    conversionRateBps: closed ? Math.round(prepared.sales.length * 10000 / closed) : null,
  };
  const dealSize = moneyGroups(prepared.sales, (row) => row).map((group) => ({
    ...group, averageGrossMinor: group.count ? Math.round(group.grossMinor / group.count) : null,
  }));
  const cycles = prepared.sales.filter((row) => row._opportunity?.created_at).map((row) => ({
    id: row.id, saleId: row.id, opportunityId: row.opportunityId, currency: row.currency,
    days: Math.max(0, Math.round((dateValue(row.date) - dateValue(row._opportunity.created_at)) / 86400000)),
  }));
  const salesCycle = {
    count: cycles.length, averageDays: cycles.length
      ? Number((cycles.reduce((sum, row) => sum + row.days, 0) / cycles.length).toFixed(2)) : null,
    items: stable(cycles),
  };
  const allocations = stable((data.allocations || []).filter((row) =>
    has(filters.event, row.event_id)).map((row) => ({
    id: row.allocation_id, allocationId: row.allocation_id, saleId: row.sale_id,
    eventKind: row.event_reference_kind, eventId: row.event_id, ticketTypeId: row.ticket_type_id,
    allocated: Number(row.allocated || 0), named: Number(row.named || 0), reserved: Number(row.reserved || 0),
    released: Number(row.released || 0), cancelled: Number(row.cancelled || 0), remaining: Number(row.remaining || 0),
    available: Math.max(0, Number(row.remaining || 0) - Number(row.named || 0) - Number(row.reserved || 0)),
  })));
  const organisations = groupRows(prepared.sales, (row) => row.organisationId, (row) => row.organisationName);
  const events = groupRows(prepared.sales, (row) => row.eventId, (row) => row._version?.event_snapshot?.title
    || row._version?.event_snapshot?.name);
  for (const allocation of allocations) {
    if (!events.some((event) => String(event.id) === String(allocation.eventId))) {
      events.push({ id: allocation.eventId, name: 'Event', saleCount: 0, values: [] });
    }
  }
  events.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const eventSummaries = events.map((event) => ({
    ...event, allocations: allocations.filter((row) => String(row.eventId) === String(event.id)),
  }));
  const owners = ownerGroups(prepared.sales);
  const products = commercialLineGroups(prepared.sales, prepared.linesByVersion, 'products');
  const bundles = commercialLineGroups(prepared.sales, prepared.linesByVersion, 'bundles');
  const categories = commercialLineGroups(prepared.sales, prepared.linesByVersion, 'categories');
  const details = {
    pipeline: pipelineRows, quotes: stable(prepared.quoteRows), sales: stable(prepared.sales),
    owners, products, bundles, categories,
    conversion: [conversion], losses, 'deal-size': dealSize.map((row) => ({ id: row.currency, ...row })),
    'sales-cycle': salesCycle.items, allocations, organisations, events,
  };
  return {
    summary: {
      pipeline, quotes: moneyGroups(prepared.quoteRows, (row) => row),
      sales: moneyGroups(prepared.sales, (row) => row), conversion, losses, dealSize,
      salesCycle: { count: salesCycle.count, averageDays: salesCycle.averageDays },
    },
    details: details[filters.report],
    organisations, events: eventSummaries, allocations, prepared,
  };
}

export function salesReportFacets(data = {}) {
  const option = (id, name) => ({ id, name: name || id });
  const unique = (rows) => [...new Map(rows.filter((row) => row.id)
    .map((row) => [String(row.id), row])).values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const versions = data.versions || [];
  const lines = data.lines || [];
  return {
    currencies: [...new Set([
      ...(data.opportunities || []).map((row) => row.currency),
      ...versions.map((row) => row.currency),
    ].filter(Boolean))].sort().map((id) => option(id, id)),
    statuses: [...new Set(versions.map((row) => row.status).filter(Boolean))].sort().map((id) => option(id, id)),
    owners: unique((data.opportunities || []).map((row) => option(row.owner_id, row.owner_id))),
    organisations: unique((data.organisations || []).map((row) => option(row.id, row.name))),
    events: unique(versions.map((row) => option(row.event_snapshot?.id,
      row.event_snapshot?.title || row.event_snapshot?.name))),
    products: unique(lines.filter((row) => row.product_id).map((row) =>
      option(row.product_id, row.catalogue_snapshot?.name || row.description))),
  };
}

export function reportColumns(rows) {
  if (!rows.length) return [];
  const keys = [...rows.reduce((set, row) => {
    Object.keys(row).forEach((key) => {
      if (!key.startsWith('_') && !Array.isArray(row[key])) set.add(key);
    });
    return set;
  }, new Set())];
  return keys.map((key) => ({
    key,
    label: key.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()),
    ...(/Minor$/.test(key) ? { type: 'money', description: 'Integer minor units in the row currency' } : {}),
    ...(/Date$|^date$/.test(key) ? { type: 'date' } : {}),
  }));
}

export function reportTotals(rows) {
  const totals = { count: rows.length };
  const currencies = new Set(rows.map((row) => row.currency).filter(Boolean));
  if (currencies.size === 1) totals.currency = [...currencies][0];
  for (const key of ['valueMinor', 'weightedValueMinor', 'netMinor', 'taxMinor', 'grossMinor', 'saleCount']) {
    if (rows.some((row) => typeof row[key] === 'number')) {
      // A single scalar total is safe only where all monetary rows have one currency.
      if (!key.endsWith('Minor') || currencies.size <= 1) {
        totals[key] = rows.reduce((sum, row) => sum + (Number(row[key]) || 0), 0);
      }
    }
  }
  return totals;
}

export function buildSalesDashboard(data, result) {
  const now = Date.now();
  const pipelineByCurrency = result.summary.pipeline;
  const wonByCurrency = result.summary.sales;
  const outstandingQuotes = result.prepared.quoteRows.filter((row) =>
    ['issued', 'sent', 'accepted'].includes(row.status)
    && !result.prepared.sales.some((sale) => String(sale.quoteId) === String(row.quoteId))).map(clean);
  const quoteByCurrency = moneyGroups(outstandingQuotes, (row) => row);
  const currencies = [...new Set([...pipelineByCurrency, ...wonByCurrency, ...quoteByCurrency]
    .map((row) => row.currency))].sort();
  const byCurrency = currencies.map((currency) => {
    const pipeline = pipelineByCurrency.find((row) => row.currency === currency);
    const won = wonByCurrency.find((row) => row.currency === currency);
    const quotes = quoteByCurrency.find((row) => row.currency === currency);
    return {
      currency, value: pipeline?.valueMinor || 0, pipelineValue: pipeline?.valueMinor || 0,
      weightedPipeline: pipeline?.weightedValueMinor || 0, wonValue: won?.grossMinor || 0,
      outstandingQuoteValue: quotes?.grossMinor || 0,
    };
  });
  const primary = byCurrency.length === 1 ? byCurrency[0] : null;
  const recentWins = stable(result.prepared.sales).sort((a, b) => dateValue(b.date) - dateValue(a.date)).slice(0, 8)
    .map((row) => ({ ...row, title: row.quoteNumber || 'Commercial sale', value: row.grossMinor }));
  const recentActivity = (data.activities || []).slice().sort((a, b) =>
    dateValue(b.created_at) - dateValue(a.created_at)).slice(0, 8).map((row) => ({
    id: row.id, title: row.summary, description: row.action, opportunityId: row.opportunity_id,
    date: row.created_at,
  }));
  const expectedCloses = result.details && result.summary.pipeline
    ? stable(result.prepared.opportunities.filter((row) => !row.stage?.is_won && !row.stage?.is_lost
      && row.expected_close_date && dateValue(row.expected_close_date) >= now).map((row) => ({
      id: row.id, title: row.name, opportunityId: row.id, expectedCloseDate: row.expected_close_date,
      date: row.expected_close_date, value: number(row.value_minor), currency: row.currency,
      organizationName: row.organisation?.name,
    }))).sort((a, b) => dateValue(a.date) - dateValue(b.date)).slice(0, 8) : [];
  const overdueTasks = (data.tasks || []).filter((row) => !row.completed_at && row.due_at
    && dateValue(row.due_at) < now).sort((a, b) => dateValue(a.due_at) - dateValue(b.due_at)).slice(0, 8)
    .map((row) => ({ id: row.id, title: row.title, opportunityId: row.opportunity_id, date: row.due_at }));
  return {
    summary: {
      currency: primary?.currency || null, pipelineValue: primary?.pipelineValue ?? null,
      weightedPipeline: primary?.weightedPipeline ?? null, wonValue: primary?.wonValue ?? null,
      outstandingQuoteValue: primary?.outstandingQuoteValue ?? null,
      openOpportunities: pipelineByCurrency.reduce((sum, row) => sum + row.count, 0),
      wonCount: result.prepared.sales.length, outstandingQuotes: outstandingQuotes.length,
    },
    byCurrency, recentActivity, recentWins, expectedCloses, overdueTasks, outstandingQuotes,
  };
}

export function buildOrganisationCommercial(data, result, organisationId) {
  const opportunities = result.prepared.opportunities.filter((row) =>
    String(row.organization_id) === String(organisationId)).map((row) => ({
    id: row.id, title: row.name, opportunityId: row.id, status: row.stage?.name,
    value: number(row.value_minor), currency: row.currency, date: row.updated_at || row.created_at,
  }));
  const quotes = result.prepared.quoteRows.filter((row) =>
    String(row.organisationId) === String(organisationId)).map(clean);
  const sales = result.prepared.sales.filter((row) =>
    String(row.organisationId) === String(organisationId)).map(clean);
  const saleIds = new Set(sales.map((row) => String(row.id)));
  const invoices = (data.invoices || []).filter((row) => saleIds.has(String(row.sale_id))).map((row) => ({
    id: row.id, saleId: row.sale_id, provider: row.provider, status: row.provider_status,
    number: row.provider_invoice_number, date: row.provider_created_at || row.created_at,
  }));
  const allocations = result.allocations.filter((row) => saleIds.has(String(row.saleId)));
  const currencies = moneyGroups(sales, (row) => row);
  const one = currencies.length === 1 ? currencies[0] : null;
  return {
    summary: {
      currency: one?.currency || null, opportunityCount: opportunities.length, quoteCount: quotes.length,
      saleCount: sales.length, invoiceCount: invoices.length, allocationCount: allocations.length,
      salesValue: one?.grossMinor ?? null,
    },
    opportunities: stable(opportunities), quotes: stable(quotes), sales: stable(sales),
    invoices: stable(invoices), allocations: stable(allocations), byCurrency: currencies,
  };
}

export function buildEventCommercial(data, result, eventId) {
  const allocations = result.allocations.filter((row) => String(row.eventId) === String(eventId));
  const simpleEvent = (data.events || []).find((row) => String(row.id) === String(eventId));
  const complexEvent = (data.complexEvents || []).find((row) => String(row.id) === String(eventId));
  const kind = complexEvent ? 'complex' : 'simple';
  const bookings = kind === 'complex' ? data.complexBookings || [] : data.bookings || [];
  const ticketRows = kind === 'complex' ? data.complexTickets || [] : simpleEvent?.pricing_config?.ticket_classes || [];
  const eventTicketRows = kind === 'complex'
    ? ticketRows.filter((row) => String(row.complex_event_id) === String(eventId))
    : ticketRows;
  const ticketIds = new Set([...eventTicketRows.map((row) => String(row.id)),
    ...allocations.map((row) => String(row.ticketTypeId)),
    ...bookings.filter((row) => String(row.event_id) === String(eventId)).map((row) => String(row.ticket_class_id))]);
  const capacity = [...ticketIds].map((ticketTypeId) => {
    const matching = allocations.filter((row) => String(row.ticketTypeId) === ticketTypeId);
    const commercial = matching.reduce((sum, row) => {
      for (const key of ['allocated', 'named', 'reserved', 'released', 'cancelled', 'remaining']) sum[key] += row[key];
      return sum;
    }, { allocated: 0, named: 0, reserved: 0, released: 0, cancelled: 0, remaining: 0 });
    commercial.unused = Math.max(0, commercial.remaining - commercial.named - commercial.reserved);
    const confirmed = bookings.filter((row) => String(row.event_id) === String(eventId)
      && String(row.ticket_class_id) === ticketTypeId && row.status === 'confirmed').length;
    const ticket = eventTicketRows.find((row) => String(row.id) === ticketTypeId) || {};
    const merged = mergeTicketCommercialCapacity(ticket, confirmed, commercial, true);
    return {
      id: ticketTypeId, ticketTypeId, name: ticket.name || 'Ticket', allocated: commercial.allocated,
      named: commercial.named, reserved: commercial.reserved, unused: commercial.unused,
      confirmedBookings: confirmed, trueAvailability: merged.true_available,
      true_available: merged.true_available, available: merged.true_available, isSoldOut: merged.is_sold_out,
    };
  }).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const summary = capacity.reduce((sum, row) => ({
    allocated: sum.allocated + row.allocated, named: sum.named + row.named,
    reserved: sum.reserved + row.reserved, unused: sum.unused + row.unused,
    confirmedBookings: sum.confirmedBookings + row.confirmedBookings,
  }), { allocated: 0, named: 0, reserved: 0, unused: 0, confirmedBookings: 0 });
  summary.trueAvailability = capacity.every((row) => row.trueAvailability !== null)
    ? capacity.reduce((sum, row) => sum + row.trueAvailability, 0) : null;
  summary.true_available = summary.trueAvailability;
  return {
    id: eventId, name: simpleEvent?.title || complexEvent?.title || 'Event', kind,
    allocations, capacity, summary,
  };
}

export function paginateSalesReport(rows, filters) {
  const total = rows.length;
  const from = (filters.page - 1) * filters.pageSize;
  return { items: rows.slice(from, from + filters.pageSize), page: filters.page, pageSize: filters.pageSize, total };
}

export function salesReportCsv(rows) {
  const columns = [...rows.reduce((set, row) => {
    Object.keys(row).forEach((key) => {
      if (!key.startsWith('_')) set.add(key);
    });
    return set;
  }, new Set())];
  const cell = (value) => {
    const raw = value != null && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
    return `"${raw.replace(/"/g, '""')}"`;
  };
  return `${columns.map(cell).join(',')}\r\n${rows.map((row) => columns.map((key) => cell(row[key])).join(',')).join('\r\n')}\r\n`;
}

export async function readSalesReportSource(db, table, tenantId, orderColumn = 'id') {
  const rows = [];
  for (let from = 0; from <= SALES_REPORT_MAX_SCAN; from += SALES_REPORT_READ_PAGE_SIZE) {
    const result = await db.from(table).select('*').eq('tenant_id', tenantId)
      .order(orderColumn, { ascending: true })
      .range(from, Math.min(from + SALES_REPORT_READ_PAGE_SIZE - 1, SALES_REPORT_MAX_SCAN));
    if (result.error) throw result.error;
    const page = result.data || [];
    rows.push(...page);
    if (rows.length > SALES_REPORT_MAX_SCAN) break;
    if (page.length < SALES_REPORT_READ_PAGE_SIZE) return rows;
  }
  throw new SalesHttpError(413, `Report exceeds the maximum scan of ${SALES_REPORT_MAX_SCAN} rows per source; narrow the filters`);
}

export async function loadSalesReportData(db, tenantId, filters = {}) {
  const names = {
    opportunities: 'opportunity', stages: 'opportunity_stage', lossReasons: 'opportunity_loss_reason',
    organisations: 'organization', quotes: 'sales_quote', versions: 'sales_quote_version',
    lines: 'sales_quote_line', sales: 'sales_commercial_sale',
    invoices: 'sales_accounting_invoice_link', allocations: 'sales_commercial_allocation_totals',
    tasks: 'opportunity_task', activities: 'opportunity_activity', events: 'event',
    complexEvents: 'complex_event', complexTickets: 'complex_event_ticket_class',
    bookings: 'booking', complexBookings: 'complex_event_booking',
  };
  const core = ['opportunities', 'stages', 'lossReasons', 'organisations'];
  const commercial = ['quotes', 'versions', 'lines', 'sales', 'invoices', 'allocations'];
  const needed = new Set(core);
  if (filters.mode === 'dashboard') {
    [...commercial, 'tasks', 'activities'].forEach((key) => needed.add(key));
  } else if (filters.mode === 'organisation' || filters.mode === 'organization') {
    commercial.forEach((key) => needed.add(key));
  } else if (filters.mode === 'event' || filters.report === 'events') {
    [...commercial, 'events', 'complexEvents', 'complexTickets', 'bookings', 'complexBookings']
      .forEach((key) => needed.add(key));
  } else if (!['pipeline', 'losses'].includes(filters.report)) {
    commercial.forEach((key) => needed.add(key));
  }
  const orderColumns = { allocations: 'allocation_id' };
  const entries = await Promise.all([...needed].map(async (key) => [
    key, await readSalesReportSource(db, names[key], tenantId, orderColumns[key] || 'id'),
  ]));
  return { ...Object.fromEntries(Object.keys(names).map((key) => [key, []])), ...Object.fromEntries(entries) };
}