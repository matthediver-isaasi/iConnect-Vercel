import { voucherDisplayName } from '../../shared/voucherPolicy.js';

export async function loadVoucherOwnerPresentation(db, tenantId) {
  const { data: settings, error } = await db.from('system_settings').select('setting_key, setting_value')
    .eq('tenant_id', tenantId).in('setting_key', ['organization_voucher_display_name', 'member_voucher_display_name']);
  if (error) throw new Error('Unable to load voucher scheme names');
  const names = {};
  for (let offset = 0; ; offset += 1000) {
    const result = await db.from('member').select('id, first_name, last_name, email').eq('tenant_id', tenantId)
      .order('id').range(offset, offset + 999);
    if (result.error) throw new Error('Unable to load voucher member owners');
    for (const member of result.data || []) names[member.id] = [member.first_name, member.last_name].filter(Boolean).join(' ') || member.email || 'Name unavailable';
    if (!result.data || result.data.length < 1000) break;
  }
  return {
    settings: settings || [],
    memberNames: names,
    label(voucher, orgName) {
      const type = voucher?.member_id ? 'member' : 'organization';
      const owner = type === 'member' ? `Individual member · ${names[voucher.member_id] || 'Name unavailable'}` : `Organisation · ${orgName || 'Name unavailable'}`;
      return `${owner} · ${voucherDisplayName(settings, type)}`;
    },
  };
}
