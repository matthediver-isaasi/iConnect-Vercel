import { SalesHttpError } from './salesAccess.js';

const TABLES = {
  categories: 'sales_catalogue_category',
  products: 'sales_catalogue_product',
  bundles: 'sales_catalogue_bundle',
};

export const throwDb = (error) => {
  if (!error) return;
  if (error.code === '23505') {
    const constraint = String(error.constraint || error.details || error.message || '');
    if (constraint.includes('sales_catalogue_category_code_unique')) {
      throw new SalesHttpError(409, 'This category code is already in use, including by an archived category');
    }
    throw new SalesHttpError(409, 'Catalogue code or SKU already exists');
  }
  if (error.code === '23503') throw new SalesHttpError(409, 'Catalogue record is still referenced');
  throw error;
};

export function delegateCapacityFromTicket(ticket) {
  return ticket?.is_group_ticket === true && Number.isInteger(Number(ticket.group_size))
    && Number(ticket.group_size) > 0 ? Number(ticket.group_size) : 1;
}

export async function resolveEventTicketReference(db, tenantId, reference) {
  if (!reference) return null;
  if (reference.kind === 'simple') {
    const result = await db.from('event').select('id,tenant_id,pricing_config')
      .eq('id', reference.eventId).eq('tenant_id', tenantId).maybeSingle();
    throwDb(result.error);
    if (!result.data) throw new SalesHttpError(400, 'Event reference does not belong to this tenant');
    const tickets = Array.isArray(result.data.pricing_config?.ticket_classes)
      ? result.data.pricing_config.ticket_classes : [];
    const ticket = tickets.find((candidate) => String(candidate.id) === reference.ticketTypeId);
    if (!ticket) throw new SalesHttpError(400, 'Ticket type does not belong to the referenced event');
    return { ...reference, delegateCapacity: delegateCapacityFromTicket(ticket) };
  }
  const eventResult = await db.from('complex_event').select('id,tenant_id')
    .eq('id', reference.eventId).eq('tenant_id', tenantId).maybeSingle();
  throwDb(eventResult.error);
  if (!eventResult.data) throw new SalesHttpError(400, 'Complex event reference does not belong to this tenant');
  const ticketResult = await db.from('complex_event_ticket_class')
    .select('id,tenant_id,complex_event_id,is_group_ticket,group_size')
    .eq('id', reference.ticketTypeId).eq('tenant_id', tenantId)
    .eq('complex_event_id', reference.eventId).maybeSingle();
  throwDb(ticketResult.error);
  if (!ticketResult.data) throw new SalesHttpError(400, 'Ticket class does not belong to the referenced complex event');
  return { ...reference, delegateCapacity: delegateCapacityFromTicket(ticketResult.data) };
}

const mapCategory = (row) => ({
  id: row.id, code: row.code, name: row.name, description: row.description,
  displayOrder: row.display_order, isActive: row.is_active, archivedAt: row.archived_at,
  createdAt: row.created_at, updatedAt: row.updated_at,
});
const mapProduct = (row) => ({
  id: row.id, categoryId: row.category_id, code: row.code, sku: row.sku, name: row.name,
  shortDescription: row.short_description, description: row.description, currency: row.currency,
  standardPriceMinor: Number(row.standard_price_minor),
  minimumPriceMinor: row.minimum_price_minor == null ? null : Number(row.minimum_price_minor),
  costMinor: row.cost_minor == null ? null : Number(row.cost_minor),
  taxTreatment: row.tax_treatment, taxRateBps: row.tax_rate_bps,
  availableFrom: row.available_from, availableTo: row.available_to,
  capacityMetadata: row.capacity_metadata || {}, displayOrder: row.display_order,
  eventReference: row.event_reference_kind ? {
    kind: row.event_reference_kind, eventId: row.event_id, ticketTypeId: row.ticket_type_id,
  } : null,
  delegateCapacity: row.delegateCapacity ?? null,
  eventReferenceAvailable: row.event_reference_kind ? row.eventReferenceAvailable !== false : null,
  isActive: row.is_active, archivedAt: row.archived_at, createdAt: row.created_at, updatedAt: row.updated_at,
});
const mapBundle = (row) => ({
  id: row.id, code: row.code, name: row.name, description: row.description, currency: row.currency,
  sellingPriceMinor: Number(row.selling_price_minor),
  minimumPriceMinor: row.minimum_price_minor == null ? null : Number(row.minimum_price_minor),
  presentationMode: row.presentation_mode, availableFrom: row.available_from, availableTo: row.available_to,
  displayOrder: row.display_order, items: row.items || [], isActive: row.is_active,
  archivedAt: row.archived_at, createdAt: row.created_at, updatedAt: row.updated_at,
});
const mapper = (type) => ({ categories: mapCategory, products: mapProduct, bundles: mapBundle }[type]);

async function hydrateProduct(db, tenantId, row) {
  if (!row.event_reference_kind) return mapProduct(row);
  try {
    const reference = await resolveEventTicketReference(db, tenantId, {
      kind: row.event_reference_kind, eventId: row.event_id, ticketTypeId: row.ticket_type_id,
    });
    return mapProduct({
      ...row,
      delegateCapacity: reference.delegateCapacity,
      eventReferenceAvailable: true,
    });
  } catch (error) {
    // Ticket definitions can be retired independently of the catalogue. Keep
    // historical products readable, but mark the stale reference unavailable
    // so downstream quote creation can fail closed.
    if (error instanceof SalesHttpError && error.status === 400) {
      return mapProduct({ ...row, eventReferenceAvailable: false });
    }
    throw error;
  }
}

async function hydrateBundles(db, tenantId, rows) {
  if (!rows.length) return [];
  const itemResult = await db.from('sales_catalogue_bundle_item')
    .select('id,bundle_id,product_id,quantity,display_order')
    .eq('tenant_id', tenantId).in('bundle_id', rows.map((row) => row.id))
    .order('display_order', { ascending: true });
  throwDb(itemResult.error);
  return rows.map((row) => mapBundle({
    ...row,
    items: (itemResult.data || []).filter((item) => item.bundle_id === row.id).map((item) => ({
      id: item.id, productId: item.product_id, quantity: item.quantity, displayOrder: item.display_order,
    })),
  }));
}

export async function listCatalogue(db, tenantId, type, options = {}) {
  let query = db.from(TABLES[type]).select('*').eq('tenant_id', tenantId);
  if (!options.includeInactive) query = query.eq('is_active', true);
  if (options.q) query = query.or(`name.ilike.%${options.q.replace(/[%_,()]/g, '')}%,code.ilike.%${options.q.replace(/[%_,()]/g, '')}%`);
  query = query.order('display_order', { ascending: true });
  const result = await query;
  throwDb(result.error);
  if (type === 'products') return Promise.all((result.data || []).map((row) => hydrateProduct(db, tenantId, row)));
  if (type === 'bundles') return hydrateBundles(db, tenantId, result.data || []);
  return (result.data || []).map(mapper(type));
}

/**
 * This is deliberately a read-only projection of the Event ticket models.
 * It does not recreate availability or registration rules: group capacity is
 * read from the ticket data exactly as product reference validation does.
 */
export async function listCatalogueEventOptions(db, tenantId, search = '') {
  const [simpleResult, complexResult, ticketResult] = await Promise.all([
    db.from('event').select('id,title,pricing_config').eq('tenant_id', tenantId),
    db.from('complex_event').select('id,title').eq('tenant_id', tenantId),
    db.from('complex_event_ticket_class').select('id,name,complex_event_id,is_group_ticket,group_size')
      .eq('tenant_id', tenantId),
  ]);
  throwDb(simpleResult.error);
  throwDb(complexResult.error);
  throwDb(ticketResult.error);
  const term = String(search || '').trim().toLowerCase();
  const matches = (...values) => !term || values.some((value) => String(value || '').toLowerCase().includes(term));
  const simple = (simpleResult.data || []).map((event) => ({
    id: event.id, eventId: event.id, name: event.title, kind: 'simple',
    ticketOptions: (Array.isArray(event.pricing_config?.ticket_classes) ? event.pricing_config.ticket_classes : [])
      .map((ticket) => ({
        id: String(ticket.id), name: ticket.name || 'Unnamed ticket',
        isGroupTicket: ticket.is_group_ticket === true,
        groupSize: ticket.is_group_ticket === true ? Number(ticket.group_size) || null : null,
        delegateCapacity: delegateCapacityFromTicket(ticket),
      }))
      .filter((ticket) => matches(event.title, ticket.name)),
  })).filter((event) => event.ticketOptions.length > 0 && matches(event.name, ...event.ticketOptions.map((ticket) => ticket.name)));
  const byEvent = new Map((ticketResult.data || []).reduce((groups, ticket) => {
    const values = groups.get(ticket.complex_event_id) || [];
    values.push({
      id: ticket.id, name: ticket.name || 'Unnamed ticket',
      isGroupTicket: ticket.is_group_ticket === true,
      groupSize: ticket.is_group_ticket === true ? Number(ticket.group_size) || null : null,
      delegateCapacity: delegateCapacityFromTicket(ticket),
    });
    groups.set(ticket.complex_event_id, values);
    return groups;
  }, new Map()));
  const complex = (complexResult.data || []).map((event) => ({
    id: event.id, eventId: event.id, name: event.title, kind: 'complex',
    ticketOptions: (byEvent.get(event.id) || []).filter((ticket) => matches(event.title, ticket.name)),
  })).filter((event) => event.ticketOptions.length > 0 && matches(event.name, ...event.ticketOptions.map((ticket) => ticket.name)));
  return [...simple, ...complex];
}

const categoryRow = (value) => ({
  code: value.code, name: value.name.trim(), description: value.description ?? null,
  ...(value.displayOrder !== undefined ? { display_order: value.displayOrder } : {}),
});
const productRow = (value) => ({
  code: value.code, sku: value.sku ?? null, name: value.name.trim(),
  short_description: value.shortDescription ?? null, description: value.description ?? null,
  category_id: value.categoryId ?? null, currency: value.currency,
  standard_price_minor: value.standardPriceMinor, minimum_price_minor: value.minimumPriceMinor ?? null,
  cost_minor: value.costMinor ?? null, tax_treatment: value.taxTreatment,
  tax_rate_bps: value.taxRateBps ?? 0, available_from: value.availableFrom ?? null,
  available_to: value.availableTo ?? null, capacity_metadata: value.capacityMetadata ?? {},
  display_order: value.displayOrder ?? 0,
  event_reference_kind: value.eventReference?.kind ?? null, event_id: value.eventReference?.eventId ?? null,
  ticket_type_id: value.eventReference?.ticketTypeId ?? null,
});
const bundleRow = (value) => ({
  code: value.code, name: value.name.trim(), description: value.description ?? null,
  currency: value.currency, selling_price_minor: value.sellingPriceMinor,
  minimum_price_minor: value.minimumPriceMinor ?? null, presentation_mode: value.presentationMode,
  available_from: value.availableFrom ?? null, available_to: value.availableTo ?? null,
  display_order: value.displayOrder ?? 0,
});

async function ensureCategory(db, tenantId, id) {
  if (!id) return;
  const result = await db.from(TABLES.categories).select('id,is_active').eq('tenant_id', tenantId).eq('id', id).maybeSingle();
  throwDb(result.error);
  if (!result.data) throw new SalesHttpError(400, 'Category does not belong to this tenant');
  if (!result.data.is_active) throw new SalesHttpError(400, 'Active products require an active category');
}

async function ensureBundleProducts(db, tenantId, items) {
  if (!items) return;
  const result = await db.from(TABLES.products).select('id,is_active').eq('tenant_id', tenantId)
    .in('id', items.map((item) => item.productId));
  throwDb(result.error);
  if ((result.data || []).length !== items.length) throw new SalesHttpError(400, 'Bundle contains a product from another tenant or an unknown product');
  if (result.data.some((row) => !row.is_active)) throw new SalesHttpError(400, 'New bundle composition cannot contain inactive products');
}

async function replaceBundleItems(db, tenantId, bundleId, items) {
  const result = await db.rpc('replace_sales_catalogue_bundle_items', {
    p_tenant_id: tenantId,
    p_bundle_id: bundleId,
    p_items: items,
  });
  throwDb(result.error);
}

async function audit(db, tenantId, actor, action, type, id, before, after) {
  const result = await db.from('sales_audit_event').insert({
    tenant_id: tenantId, actor_id: actor.actorId, actor_type: actor.actorType,
    action, entity_type: `sales_catalogue_${type.slice(0, -1)}`, entity_id: id,
    before_data: before, after_data: after,
  });
  throwDb(result.error);
}

export async function createCatalogueRecord(db, tenantId, actor, type, value) {
  if (type === 'products') {
    await ensureCategory(db, tenantId, value.categoryId);
    await resolveEventTicketReference(db, tenantId, value.eventReference);
  }
  if (type === 'bundles') await ensureBundleProducts(db, tenantId, value.items);
  const toRow = { categories: categoryRow, products: productRow, bundles: bundleRow }[type];
  const result = await db.from(TABLES[type]).insert({
    tenant_id: tenantId, ...toRow(value), created_by: actor.actorId, updated_by: actor.actorId,
  }).select('*').single();
  throwDb(result.error);
  if (type === 'bundles') {
    try {
      await replaceBundleItems(db, tenantId, result.data.id, value.items);
    } catch (error) {
      await db.from(TABLES.bundles).delete().eq('tenant_id', tenantId).eq('id', result.data.id);
      throw error;
    }
  }
  await audit(db, tenantId, actor, `${type.slice(0, -1)}.created`, type, result.data.id, null, result.data);
  if (type === 'products') return hydrateProduct(db, tenantId, result.data);
  if (type === 'bundles') return (await hydrateBundles(db, tenantId, [result.data]))[0];
  return mapCategory(result.data);
}

export async function updateCatalogueRecord(db, tenantId, actor, type, id, value) {
  const current = await db.from(TABLES[type]).select('*').eq('tenant_id', tenantId).eq('id', id).maybeSingle();
  throwDb(current.error);
  if (!current.data) throw new SalesHttpError(404, 'Catalogue record not found');
  if (type === 'products') {
    await ensureCategory(db, tenantId, value.categoryId);
    if ('eventReference' in value) await resolveEventTicketReference(db, tenantId, value.eventReference);
  }
  if (type === 'bundles') await ensureBundleProducts(db, tenantId, value.items);
  if (type === 'products') {
    const standard = value.standardPriceMinor ?? Number(current.data.standard_price_minor);
    const minimum = 'minimumPriceMinor' in value ? value.minimumPriceMinor
      : current.data.minimum_price_minor == null ? null : Number(current.data.minimum_price_minor);
    const from = 'availableFrom' in value ? value.availableFrom : current.data.available_from;
    const to = 'availableTo' in value ? value.availableTo : current.data.available_to;
    if (minimum != null && minimum > standard) throw new SalesHttpError(400, 'minimumPriceMinor must not exceed standardPriceMinor');
    if (from && to && Date.parse(from) > Date.parse(to)) throw new SalesHttpError(400, 'availableFrom must not be after availableTo');
  }
  if (type === 'bundles') {
    const selling = value.sellingPriceMinor ?? Number(current.data.selling_price_minor);
    const minimum = 'minimumPriceMinor' in value ? value.minimumPriceMinor
      : current.data.minimum_price_minor == null ? null : Number(current.data.minimum_price_minor);
    const from = 'availableFrom' in value ? value.availableFrom : current.data.available_from;
    const to = 'availableTo' in value ? value.availableTo : current.data.available_to;
    if (minimum != null && minimum > selling) throw new SalesHttpError(400, 'minimumPriceMinor must not exceed sellingPriceMinor');
    if (from && to && Date.parse(from) > Date.parse(to)) throw new SalesHttpError(400, 'availableFrom must not be after availableTo');
  }
  const complete = type === 'categories' ? categoryRow({ ...mapCategory(current.data), ...value })
    : type === 'products' ? productRow({ ...mapProduct(current.data), ...value })
      : bundleRow({ ...mapBundle(current.data), ...value });
  const result = await db.from(TABLES[type]).update({ ...complete, updated_by: actor.actorId, updated_at: new Date().toISOString() })
    .eq('tenant_id', tenantId).eq('id', id).select('*').single();
  throwDb(result.error);
  if (type === 'bundles' && value.items) {
    await replaceBundleItems(db, tenantId, id, value.items);
  }
  await audit(db, tenantId, actor, `${type.slice(0, -1)}.updated`, type, id, current.data, result.data);
  if (type === 'products') return hydrateProduct(db, tenantId, result.data);
  if (type === 'bundles') return (await hydrateBundles(db, tenantId, [result.data]))[0];
  return mapCategory(result.data);
}

export async function setCatalogueActive(db, tenantId, actor, type, id, active) {
  const current = await db.from(TABLES[type]).select('*').eq('tenant_id', tenantId).eq('id', id).maybeSingle();
  throwDb(current.error);
  if (!current.data) throw new SalesHttpError(404, 'Catalogue record not found');
  if (!active && type === 'categories') {
    const products = await db.from(TABLES.products).select('id').eq('tenant_id', tenantId)
      .eq('category_id', id).eq('is_active', true).limit(1);
    throwDb(products.error);
    if (products.data?.length) throw new SalesHttpError(409, 'Archive active products in this category first');
  }
  if (!active && type === 'products') {
    const itemResult = await db.from('sales_catalogue_bundle_item').select('bundle_id')
      .eq('tenant_id', tenantId).eq('product_id', id);
    throwDb(itemResult.error);
    const bundleIds = [...new Set((itemResult.data || []).map((item) => item.bundle_id))];
    if (bundleIds.length) {
      const bundles = await db.from(TABLES.bundles).select('id').eq('tenant_id', tenantId)
        .eq('is_active', true).in('id', bundleIds).limit(1);
      throwDb(bundles.error);
      if (bundles.data?.length) throw new SalesHttpError(409, 'Archive active bundles containing this product first');
    }
  }
  if (active && type === 'bundles') {
    const items = await db.from('sales_catalogue_bundle_item').select('product_id').eq('tenant_id', tenantId).eq('bundle_id', id);
    throwDb(items.error);
    if (!items.data?.length) throw new SalesHttpError(409, 'An empty bundle cannot be restored');
    await ensureBundleProducts(db, tenantId, items.data.map((item) => ({ productId: item.product_id })));
  }
  if (active && type === 'products') {
    await ensureCategory(db, tenantId, current.data.category_id);
    if (current.data.event_reference_kind) {
      await resolveEventTicketReference(db, tenantId, {
        kind: current.data.event_reference_kind,
        eventId: current.data.event_id,
        ticketTypeId: current.data.ticket_type_id,
      });
    }
  }
  const result = await db.from(TABLES[type]).update({
    is_active: active, archived_at: active ? null : new Date().toISOString(),
    archived_by: active ? null : actor.actorId, updated_by: actor.actorId, updated_at: new Date().toISOString(),
  }).eq('tenant_id', tenantId).eq('id', id).select('*').single();
  throwDb(result.error);
  await audit(db, tenantId, actor, `${type.slice(0, -1)}.${active ? 'restored' : 'archived'}`, type, id, current.data, result.data);
  if (type === 'products') return hydrateProduct(db, tenantId, result.data);
  if (type === 'bundles') return (await hydrateBundles(db, tenantId, [result.data]))[0];
  return mapCategory(result.data);
}

export async function reorderCatalogue(db, tenantId, actor, type, ids) {
  const found = await db.from(TABLES[type]).select('id').eq('tenant_id', tenantId).in('id', ids);
  throwDb(found.error);
  if ((found.data || []).length !== ids.length) throw new SalesHttpError(400, 'Reorder contains unknown or cross-tenant records');
  for (let index = 0; index < ids.length; index += 1) {
    const result = await db.from(TABLES[type]).update({
      display_order: index, updated_by: actor.actorId, updated_at: new Date().toISOString(),
    }).eq('tenant_id', tenantId).eq('id', ids[index]);
    throwDb(result.error);
  }
  await audit(db, tenantId, actor, `${type.slice(0, -1)}.reordered`, type, ids[0], null, { ids });
  return { ids };
}