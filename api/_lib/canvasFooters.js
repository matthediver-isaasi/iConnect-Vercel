import { supabase } from './database.js';

export const EMPTY_CANVAS_FOOTER_DESIGN = {
  version: 1,
  root: { background: null, sections: [] },
};

export function normalizeCanvasFooterDesign(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const design = JSON.parse(JSON.stringify(value));
  if (!Number.isFinite(Number(design.version))) design.version = 1;
  if (!design.root || typeof design.root !== 'object' || Array.isArray(design.root)) {
    design.root = {};
  }
  if (!Array.isArray(design.root.sections)) design.root.sections = [];
  if (design.root.background === undefined) design.root.background = null;
  return design;
}

export function isRenderableCanvasFooterDesign(value) {
  const design = normalizeCanvasFooterDesign(value);
  return !!design && Array.isArray(design.root.sections);
}

export function footerRecordForPayload(row) {
  if (!row || !isRenderableCanvasFooterDesign(row.design)) return null;
  return {
    id: row.id,
    name: row.name,
    design: normalizeCanvasFooterDesign(row.design),
  };
}

export function chooseEffectiveFooterSelection(tenantData, microsite = null) {
  const mainSource = tenantData?.footer_source === 'canvas' ? 'canvas' : 'configured';
  if (!microsite) {
    return { source: mainSource, footerId: tenantData?.canvas_footer_id || null };
  }
  if (microsite.footer_source === 'inherit') {
    return { source: mainSource, footerId: tenantData?.canvas_footer_id || null };
  }
  if (microsite.footer_source === 'canvas') {
    return { source: 'canvas', footerId: microsite.canvas_footer_id || null };
  }
  return { source: 'configured', footerId: null };
}

async function loadFooter(tenantId, footerId) {
  if (!supabase || !tenantId || !footerId) return null;
  const { data, error } = await supabase
    .from('canvas_footer')
    .select('id, tenant_id, name, design')
    .eq('id', footerId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) {
    // Legacy databases without the migration must behave exactly as before.
    if (error.code !== '42P01' && error.code !== '42703') {
      console.error('[Canvas footers] load failed:', error.message || error.code);
    }
    return null;
  }
  return footerRecordForPayload(data);
}

/**
 * Resolve only a valid, tenant-owned Canvas footer. Any missing, malformed,
 * deleted, or inaccessible selection returns configured mode.
 */
export async function resolveEffectiveCanvasFooter(tenantData, microsite = null) {
  const { source, footerId } = chooseEffectiveFooterSelection(tenantData, microsite);

  if (source !== 'canvas' || !footerId) {
    return { source: 'configured', footer: null };
  }
  const footer = await loadFooter(tenantData.id, footerId);
  return footer
    ? { source: 'canvas', footer }
    : { source: 'configured', footer: null };
}