import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { publicClient } from '@/api/publicClient';
import { normalizeVoucherSettings, voucherOwnerType } from '../../../../shared/voucherPolicy.js';

// The entity endpoint enforces read ownership; this additional filter implements
// purchase eligibility, not authorization. Never share caches across identities.
export function useBookingVouchers(member, organization, enabled = true) {
  const settingsQuery = useQuery({
    queryKey: ['/api/public/system-settings'],
    queryFn: () => publicClient.listSystemSettings(),
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const settings = normalizeVoucherSettings(settingsQuery.data);
  const roles = organization?.voucher_allowed_role_ids || [];
  const organizationAllowed = !!organization?.id
    && (!roles.length || roles.includes(member?.role_id));
  const query = useQuery({
    queryKey: ['vouchers', organization?.id, member?.tenant_id, member?.id,
      member?.role_id, organizationAllowed, settings.individual_vouchers_enabled],
    queryFn: async () => {
      const rows = await base44.entities.Voucher.list();
      const now = Date.now();
      return (rows || []).filter(v => {
        const type = voucherOwnerType(v);
        const ownerAllowed = type === 'member'
          ? settings.individual_vouchers_enabled && v.member_id === member?.id
          : type === 'organization' && organizationAllowed && v.organization_id === organization?.id;
        return ownerAllowed && v.status === 'active' && Number(v.value) > 0
          && (!v.expires_at || Date.parse(v.expires_at) > now)
          && (!v.valid_from || Date.parse(v.valid_from) <= now);
      });
    },
    enabled: enabled && !!member?.id && settingsQuery.isSuccess,
    staleTime: 0,
    refetchOnMount: true,
  });
  return { ...query, data: settingsQuery.isSuccess ? query.data : [],
    isLoading: settingsQuery.isLoading || query.isLoading,
    error: settingsQuery.error || query.error, settings, organizationAllowed };
}
