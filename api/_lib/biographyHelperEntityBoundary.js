import { BIOGRAPHY_HELPER_SETTING_KEY } from '../../shared/biographyHelperText.js';

// All generic writes (including admin writes) use the dedicated endpoint so
// validation cannot be bypassed by renaming, deleting or replacing a row.
export async function rejectGenericBiographyHelperWrite({ entity, id, req, res, context, db }) {
  if (String(entity).replace(/[-_]/g, '').toLowerCase() !== 'systemsettings' || req.method === 'GET') return false;
  const containsKey = value => value && typeof value === 'object'
    && (value.setting_key === BIOGRAPHY_HELPER_SETTING_KEY || Object.values(value).some(containsKey));
  let protectedKey = containsKey(req.body);
  if (id && !protectedKey) {
    if (!context?.isAuthenticated || context.tenantMismatch || !context.tenantId) {
      res.status(403).json({ error: 'Valid tenant authentication required.' });
      return true;
    }
    const { data, error } = await db.from('system_settings').select('setting_key')
      .eq('id', id).eq('tenant_id', context.tenantId).maybeSingle();
    if (error) {
      res.status(503).json({ error: 'Unable to verify biography helper settings.' });
      return true;
    }
    protectedKey = data?.setting_key === BIOGRAPHY_HELPER_SETTING_KEY;
  }
  if (!protectedKey) return false;
  res.status(403).json({ error: 'Use the Professional Biography helper-text settings control.' });
  return true;
}
