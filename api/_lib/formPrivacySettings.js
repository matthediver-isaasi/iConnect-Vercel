import { createHash } from 'node:crypto';
import { FORM_PRIVACY_SETTINGS_KEY, safeFormPrivacyUrl } from '../../shared/formConsentSettings.js';

export async function saveFormPrivacyUrl(db, tenantId, value) {
  if (typeof value !== 'string' || (value.trim() && !safeFormPrivacyUrl(value))) {
    throw Object.assign(new Error('Enter a valid HTTP or HTTPS Privacy Settings URL.'), { status: 400 });
  }
  const { data: rows, error } = await db.from('system_settings').select('id')
    .eq('tenant_id', tenantId).eq('setting_key', FORM_PRIVACY_SETTINGS_KEY).limit(2);
  if (error) throw error;
  if (!rows || rows.length > 1) throw new Error('Ambiguous privacy settings; administrator repair required');
  const privacy_settings_url = value.trim();
  let result;
  if (rows.length) {
    result = await db.from('system_settings').update({ setting_value: privacy_settings_url })
      .eq('id', rows[0].id).eq('tenant_id', tenantId).select('id').single();
  } else {
    // The existing primary key serializes simultaneous first saves, even on
    // legacy databases without a unique (tenant_id, setting_key) constraint.
    const hex = createHash('sha256').update(`system_settings:${tenantId}:${FORM_PRIVACY_SETTINGS_KEY}`).digest('hex');
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    result = await db.from('system_settings').insert({
      id, tenant_id: tenantId, setting_key: FORM_PRIVACY_SETTINGS_KEY,
      setting_value: privacy_settings_url, description: 'Optional form Privacy Settings URL',
    }).select('id').single();
    // Report conflicts rather than claiming a losing first save succeeded.
  }
  if (result.error || !result.data) throw result.error || new Error('Privacy Settings URL was not saved');
  return { privacy_settings_url };
}
