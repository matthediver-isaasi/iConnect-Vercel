import {
  SALES_QUOTE_TRANSITIONS, calculateQuoteLine, calculateQuoteTotals,
} from '../../shared/salesContracts.js';
import { SalesHttpError } from './salesAccess.js';
import { resolveSalesTaxCode } from './salesCatalogueTaxOptions.js';

const VERSION_SELECT = '*,sales_quote_line(*,sales_quote_bundle_component(*))';

async function one(db, table, tenantId, id, label) {
  const { data, error } = await db.from(table).select('*')
    .eq('tenant_id', tenantId).eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw new SalesHttpError(400, `${label} was not found in this tenant`);
  return data;
}

async function snapshotReferences(db, tenantId, actor, draft) {
  const opportunity = draft.opportunityId ? await one(db, 'opportunity', tenantId, draft.opportunityId, 'Opportunity') : null;
  const organisationId = draft.organisationId || opportunity?.organization_id || null;
  const salespersonId = draft.salespersonId || draft.salesperson?.id || null;
  const [organisation, customer, billing, salesperson, settings] = await Promise.all([
    organisationId ? one(db, 'organization', tenantId, organisationId, 'Organisation') : null,
    draft.customerContactId ? one(db, 'member', tenantId, draft.customerContactId, 'Customer contact') : null,
    draft.billingContactId ? one(db, 'member', tenantId, draft.billingContactId, 'Billing contact') : null,
    salespersonId ? one(db, 'member', tenantId, salespersonId, 'Salesperson') : null,
    db.from('sales_settings').select('default_terms').eq('tenant_id', tenantId).maybeSingle(),
  ]);
  if (settings.error) throw settings.error;
  let event = draft.event || (draft.eventId ? { id: draft.eventId, kind: 'simple' } : null);
  if (event?.id) {
    const table = event.kind === 'complex' ? 'complex_event' : 'event';
    event = await one(db, table, tenantId, event.id, 'Event');
  }
  return {
    organisationSnapshot: organisation,
    customerContactSnapshot: customer, billingContactSnapshot: billing,
    addressSnapshot: draft.address || null,
    eventSnapshot: event,
    termsSnapshot: { text: draft.terms ?? settings.data?.default_terms ?? '' },
    salespersonSnapshot: salesperson || { id: actor.actorId, type: actor.actorType },
  };
}

async function resolveLine(db, tenantId, line, index, allowPriceOverride, previous) {
  const preserveTax = previous && previous.catalogue_kind === line.kind
    && (previous.catalogue_id || null) === (line.catalogueId || null)
    && (!line.taxCode || (line.taxCode.provider === previous.catalogue_snapshot?.tax_code?.provider
      && line.taxCode.id === previous.catalogue_snapshot?.tax_code?.id));
  if (line.kind === 'free_text') {
    const taxCode = preserveTax ? previous.catalogue_snapshot?.tax_code || null
      : line.taxCode ? await resolveSalesTaxCode(db, tenantId, line.taxCode) : null;
    if (preserveTax || taxCode) line = { ...line, taxRateBps: preserveTax ? Number(previous.tax_rate_bps) : taxCode.rateBps };
    if ((line.standardUnitPriceMinor !== line.quotedUnitPriceMinor || (line.discountBps || 0) !== 0) && !allowPriceOverride) {
      throw new SalesHttpError(403, 'Catalogue price override capability required');
    }
    const amounts = calculateQuoteLine(line);
    return { kind: 'free_text', catalogueId: null, catalogueSnapshot: taxCode ? { tax_code: taxCode } : null, description: line.description || '',
      quantity: amounts.quantity, standardUnitPriceMinor: line.standardUnitPriceMinor,
      quotedUnitPriceMinor: line.quotedUnitPriceMinor, priceOverridden: line.standardUnitPriceMinor !== line.quotedUnitPriceMinor,
      discountBps: line.discountBps || 0, taxRateBps: line.taxRateBps || 0, ...amounts, components: [] };
  }
  const table = line.kind === 'bundle' ? 'sales_catalogue_bundle' : 'sales_catalogue_product';
  const item = await one(db, table, tenantId, line.catalogueId, line.kind === 'bundle' ? 'Bundle' : 'Product');
  if (!item.is_active) throw new SalesHttpError(400, `Quote line ${index + 1} references an archived catalogue item`);
  if (item.currency !== line.currency && line.currency) throw new SalesHttpError(400, `Quote line ${index + 1} currency mismatch`);
  const standard = Number(line.kind === 'bundle' ? item.selling_price_minor : item.standard_price_minor);
  if (!Number.isSafeInteger(standard) || standard < 0) {
    throw new SalesHttpError(400, `Quote line ${index + 1} catalogue price exceeds the supported safe minor-unit range`);
  }
  const quoted = line.quotedUnitPriceMinor ?? standard;
  const overridden = quoted !== standard || (line.discountBps || 0) !== 0;
  if (overridden && !allowPriceOverride) throw new SalesHttpError(403, 'Catalogue price override capability required');
  const minimum = item.minimum_price_minor == null ? null : Number(item.minimum_price_minor);
  if (minimum != null && (!Number.isSafeInteger(minimum) || minimum < 0)) {
    throw new SalesHttpError(400, `Quote line ${index + 1} minimum price is invalid`);
  }
  const discounted = calculateQuoteLine({
    quantity: '1', quotedUnitPriceMinor: quoted, discountBps: line.discountBps || 0, taxRateBps: 0,
  }).discountedUnitPriceMinor;
  if (minimum != null && discounted < minimum) throw new SalesHttpError(400, `Quote line ${index + 1} is below its minimum price`);
  // Catalogue tax is authoritative. A quote editor may display and submit the
  // rate it read from the catalogue, but it must not be able to alter the
  // financial tax treatment of a catalogue-backed line.
  const taxCode = preserveTax ? previous.catalogue_snapshot?.tax_code || null : line.kind === 'product'
    ? item.tax_code ? await resolveSalesTaxCode(db, tenantId, item.tax_code) : null
    : line.taxCode ? await resolveSalesTaxCode(db, tenantId, line.taxCode) : null;
  const taxRateBps = preserveTax ? Number(previous.tax_rate_bps) : taxCode ? taxCode.rateBps : line.kind === 'product' ? Number(item.tax_rate_bps) : 0;
  if (!Number.isInteger(taxRateBps) || taxRateBps < 0 || taxRateBps > 100000) {
    throw new SalesHttpError(400, `Quote line ${index + 1} catalogue tax rate is invalid`);
  }
  const amounts = calculateQuoteLine({ quantity: line.quantity, quotedUnitPriceMinor: quoted, discountBps: line.discountBps || 0, taxRateBps });
  let components = [];
  if (line.kind === 'bundle') {
    const { data, error } = await db.from('sales_catalogue_bundle_item').select('*')
      .eq('tenant_id', tenantId).eq('bundle_id', item.id).order('display_order');
    if (error) throw error;
    components = await Promise.all((data || []).map(async (component) => ({
      productId: component.product_id,
      quantity: component.quantity,
      productSnapshot: await one(db, 'sales_catalogue_product', tenantId, component.product_id, 'Bundle product'),
    })));
  }
  return {
    kind: line.kind, catalogueId: item.id, catalogueSnapshot: { ...item, tax_code: taxCode },
    description: line.description ?? item.description ?? item.name,
    quantity: amounts.quantity, standardUnitPriceMinor: standard, quotedUnitPriceMinor: quoted,
    priceOverridden: overridden, discountBps: line.discountBps || 0, taxRateBps, ...amounts, components,
  };
}

export async function prepareQuoteDraft(db, tenantId, actor, draft, allowPriceOverride = false, previousLines = new Map()) {
  const snapshots = await snapshotReferences(db, tenantId, actor, draft);
  const lines = await Promise.all(draft.lines.map((line, index) => resolveLine(
    db, tenantId, { ...line, currency: draft.currency }, index, allowPriceOverride, previousLines.get(line.id),
  )));
  return {
    currency: draft.currency, opportunityId: draft.opportunityId || null,
    issueDate: draft.issueDate || null, validUntil: draft.validUntil || null, notes: draft.notes || null,
    purchaseOrderReference: draft.purchaseOrderReference || null, customerReference: draft.customerReference || null,
    taxTreatment: draft.taxTreatment || null, paymentTerms: draft.paymentTerms || null,
    ...snapshots, lines, totals: calculateQuoteTotals(lines),
  };
}

function rpcError(error) {
  if (error?.code === '40001') throw new SalesHttpError(409, 'Quote was updated by another user');
  if (error?.code === 'P0002') throw new SalesHttpError(404, 'Quote not found');
  if (error?.code === '22023' || error?.code === '23514') throw new SalesHttpError(400, error.message);
  throw error;
}

async function quoteRpc(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (error) rpcError(error);
  return Array.isArray(data) ? data[0] : data;
}

export async function saveQuoteDraft(db, tenantId, actor, id, expectedVersion, draft, allowOverride) {
  const previousLines = new Map();
  if (id) {
    const { data: version, error } = await db.from('sales_quote_version').select('id')
      .eq('tenant_id', tenantId).eq('quote_id', id).eq('status', 'draft').maybeSingle();
    if (error) throw error;
    if (version) {
      const result = await db.from('sales_quote_line').select('*').eq('tenant_id', tenantId).eq('quote_version_id', version.id);
      if (result.error) throw result.error;
      for (const line of result.data || []) previousLines.set(line.id, line);
    }
  }
  for (const line of draft.lines) if (line.id && !previousLines.has(line.id)) {
    throw new SalesHttpError(409, 'A quote line is no longer part of this draft. Reload before saving.');
  }
  const payload = await prepareQuoteDraft(db, tenantId, actor, draft, allowOverride, previousLines);
  for (let i = 0; i < payload.lines.length; i++) {
    if (!previousLines.has(draft.lines[i].id) && !payload.lines[i].catalogueSnapshot?.tax_code) {
      throw new SalesHttpError(400, `Select a provider tax code for new quote line ${i + 1}${draft.lines[i].kind === 'product' ? ' on its catalogue product' : ''}.`);
    }
  }
  return quoteRpc(db, 'save_sales_quote_draft', {
    p_tenant_id: tenantId, p_quote_id: id || null, p_expected_version: expectedVersion || null,
    p_payload: payload, p_actor_id: actor.actorId, p_actor_type: actor.actorType,
  });
}

export const issueQuote = (db, tenantId, actor, id, expectedVersion) => quoteRpc(db, 'issue_sales_quote', {
  p_tenant_id: tenantId, p_quote_id: id, p_expected_version: expectedVersion,
  p_actor_id: actor.actorId, p_actor_type: actor.actorType,
});

export const amendQuote = (db, tenantId, actor, id, expectedVersion) => quoteRpc(db, 'amend_sales_quote', {
  p_tenant_id: tenantId, p_quote_id: id, p_expected_version: expectedVersion,
  p_actor_id: actor.actorId, p_actor_type: actor.actorType,
});

export async function transitionQuote(db, tenantId, actor, id, expectedVersion, status, note) {
  const current = await getQuote(db, tenantId, id);
  if (!SALES_QUOTE_TRANSITIONS[current.currentVersion.status]?.includes(status)) {
    throw new SalesHttpError(409, `Quote cannot transition from ${current.currentVersion.status} to ${status}`);
  }
  return quoteRpc(db, 'transition_sales_quote', {
    p_tenant_id: tenantId, p_quote_id: id, p_expected_version: expectedVersion,
    p_status: status, p_note: note || null, p_actor_id: actor.actorId, p_actor_type: actor.actorType,
  });
}

export async function confirmQuoteSale(db, tenantId, actor, id, input) {
  const { confirmQuoteSale: confirm } = await import('./salesCommercialAllocation.js');
  return confirm(db, tenantId, actor, id, input);
}

export async function listQuotes(db, tenantId, filters = {}) {
  let query = db.from('sales_quote').select('*').eq('tenant_id', tenantId).order('updated_at', { ascending: false });
  if (filters.opportunityId) query = query.eq('opportunity_id', filters.opportunityId);
  const page = Math.max(1, Number(filters.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(filters.pageSize || filters.limit) || 25));
  const { data, error } = await query;
  if (error) throw error;
  const ids = (data || []).map((row) => row.id);
  if (!ids.length) return { items: [], total: 0, page, pageSize, totalPages: 1 };
  const { data: versions, error: versionError } = await db.from('sales_quote_version').select('*').eq('tenant_id', tenantId).in('quote_id', ids);
  if (versionError) throw versionError;
  const filtered = (data || []).map((root) => {
    const currentVersion = (versions || []).find((v) => v.quote_id === root.id && v.version_number === root.current_version);
    return { ...root, ...currentVersion, id: root.id, versionId: currentVersion?.id, currentVersion };
  })
    .filter((row) => !filters.status || row.currentVersion?.status === filters.status)
    .filter((row) => !filters.search || `${row.quote_number || ''} ${row.currentVersion?.customer_reference || ''} ${row.currentVersion?.organisation_snapshot?.name || ''}`.toLowerCase().includes(String(filters.search).toLowerCase()));
  const total = filtered.length;
  const items = filtered.slice((page - 1) * pageSize, page * pageSize);
  return { items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function getQuote(db, tenantId, id) {
  const { data: root, error } = await db.from('sales_quote').select('*')
    .eq('tenant_id', tenantId).eq('id', id).maybeSingle();
  if (error) throw error;
  if (!root) throw new SalesHttpError(404, 'Quote not found');
  const { data: versions, error: versionError } = await db.from('sales_quote_version')
    .select(VERSION_SELECT).eq('tenant_id', tenantId).eq('quote_id', id)
    .order('version_number', { ascending: false });
  if (versionError) throw versionError;
  return { ...root, currentVersion: versions?.find((v) => v.version_number === root.current_version), versions: versions || [] };
}

export async function getQuoteHistory(db, tenantId, id) {
  await one(db, 'sales_quote', tenantId, id, 'Quote');
  const { data, error } = await db.from('sales_quote_status_history').select('*')
    .eq('tenant_id', tenantId).eq('quote_id', id).order('created_at', { ascending: true });
  if (error) throw error;
  const { data: versions, error: versionError } = await db.from('sales_quote_version')
    .select('id,version_number').eq('tenant_id', tenantId).eq('quote_id', id);
  if (versionError) throw versionError;
  const versionById = new Map((versions || []).map((version) => [version.id, version.version_number]));
  return (data || []).map((item) => ({ ...item, version_number: versionById.get(item.quote_version_id) }));
}

export async function compareQuoteVersions(db, tenantId, id, from, to) {
  const quote = await getQuote(db, tenantId, id);
  const left = quote.versions.find((version) => version.version_number === from);
  const right = quote.versions.find((version) => version.version_number === to);
  if (!left || !right) throw new SalesHttpError(404, 'Quote version not found');
  return { from: left, to: right };
}