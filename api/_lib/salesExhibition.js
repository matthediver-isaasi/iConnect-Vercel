import { randomUUID } from 'node:crypto';
import { exhibitionSlots, validateExhibitionSelections } from '../../shared/salesExhibitionContract.js';
import { SalesHttpError } from './salesAccess.js';

export function exhibitionError(error) {
  if (!error) return;
  if (['40001','23505','40P01'].includes(error.code)) throw new SalesHttpError(409, error.message);
  if (error.code === 'P0002') throw new SalesHttpError(404, error.message);
  if (['22023','23514','23503','22P02','23502'].includes(error.code)) throw new SalesHttpError(400, error.message);
  throw error;
}

export async function prepareExhibitionLine(db, tenantId, line, input, previous) {
  const same = previous?.catalogue_kind === line.kind && previous?.catalogue_id === line.catalogueId;
  const old = same ? previous?.catalogue_snapshot?.exhibition : null;
  const lineKey = old?.lineKey || randomUUID();
  const components = line.components.map(c => ({
    logicalComponentId: old?.componentKeys?.[c.productId] || randomUUID(),
    productId: c.productId, quantity: c.quantity,
    ...(c.productSnapshot.space_requirement_id ? { spaceRequirement: { requirementId: c.productSnapshot.space_requirement_id, units: 1 } } : {}),
  }));
  let slots;
  try {
    slots = exhibitionSlots([{ kind: line.kind, logicalLineId: lineKey, quantity: line.quantity,
      ...(line.catalogueSnapshot?.space_requirement_id ? { spaceRequirement: { requirementId: line.catalogueSnapshot.space_requirement_id, units: 1 } } : {}),
      components }]);
  } catch (error) { throw new SalesHttpError(400, error.message); }
  if (!slots.length) return line;
  const wanted = input.exhibitionSelections ?? (old?.selections || []).filter(p => slots.some(s => s.key === p.slotKey));
  try { validateExhibitionSelections(slots, wanted); }
  catch (error) { throw new SalesHttpError(400, error.message); }
  const selections = [];
  for (const pick of wanted) {
    if (input.exhibitionSelections === undefined && old?.selections?.some(p => p.slotKey === pick.slotKey && p.spaceId === pick.spaceId)) {
      const held = await db.from('sales_space_allocation').select('id').eq('tenant_id', tenantId)
        .eq('slot_key', pick.slotKey).eq('space_id', pick.spaceId).eq('state', 'reserved').maybeSingle();
      exhibitionError(held.error);
      if (!held.data) throw new SalesHttpError(409, 'This reservation was released. Explicitly select an available space again or clear the selection.');
    }
    const result = await db.from('sales_exhibition_overview').select('id,reference,price_minor,currency,requirement_id')
      .eq('tenant_id', tenantId).eq('id', pick.spaceId).maybeSingle();
    exhibitionError(result.error);
    if (!result.data) throw new SalesHttpError(409, 'Selected space is no longer available');
    const saved = old?.selections?.find(p => p.slotKey === pick.slotKey && p.spaceId === pick.spaceId);
    selections.push({ slotKey: pick.slotKey, spaceId: pick.spaceId, reference: result.data.reference,
      priceMinor: saved?.priceMinor ?? Number(result.data.price_minor), currency: result.data.currency });
  }
  return { ...line, catalogueSnapshot: { ...line.catalogueSnapshot, exhibition: {
    lineKey, componentKeys: Object.fromEntries(components.map(c => [c.productId, c.logicalComponentId])), slots, selections,
  } } };
}
