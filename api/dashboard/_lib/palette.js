import { supabase } from '../../_lib/database.js';
import {
  defaultDashboardWidgetPalette,
  normalizeDashboardWidgetPalette,
} from '../../../shared/dashboardWidgetPalette.js';

export const DASHBOARD_WIDGET_PALETTE_KEY = 'dashboard_widget_palette';

export async function getDashboardWidgetPalette(tenantId) {
  if (!supabase) return defaultDashboardWidgetPalette();
  try {
    let query = supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', DASHBOARD_WIDGET_PALETTE_KEY);
    query = tenantId ? query.eq('tenant_id', tenantId) : query.is('tenant_id', null);
    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    if (!data?.setting_value) return defaultDashboardWidgetPalette();
    const parsed =
      typeof data.setting_value === 'string'
        ? JSON.parse(data.setting_value)
        : data.setting_value;
    return normalizeDashboardWidgetPalette(parsed);
  } catch (err) {
    console.error('[Dashboard Palette] Falling back to defaults:', err);
    return defaultDashboardWidgetPalette();
  }
}

export async function saveDashboardWidgetPalette(tenantId, palette) {
  const serialized = JSON.stringify(palette);
  let query = supabase
    .from('system_settings')
    .select('id')
    .eq('setting_key', DASHBOARD_WIDGET_PALETTE_KEY);
  query = tenantId ? query.eq('tenant_id', tenantId) : query.is('tenant_id', null);
  const { data: existing, error: selectError } = await query;
  if (selectError) throw selectError;

  if (existing?.length) {
    const { error } = await supabase
      .from('system_settings')
      .update({ setting_value: serialized, setting_type: 'json' })
      .eq('id', existing[0].id);
    if (error) throw error;
    return;
  }

  const { error } = await supabase.from('system_settings').insert({
    tenant_id: tenantId || null,
    setting_key: DASHBOARD_WIDGET_PALETTE_KEY,
    setting_value: serialized,
    setting_type: 'json',
    description: 'Tenant dashboard widget colour palette',
  });
  if (error) throw error;
}