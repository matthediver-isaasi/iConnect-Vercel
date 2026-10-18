import { useMemberAccess } from './useMemberAccess';
import { resolveQuoteNaming } from '@shared/salesNaming.js';
import { useSalesSettings as useScopedSalesSettings } from '../components/sales/useSalesSettings';
export { salesSettingsRequest, useSalesSettingsScope } from '../components/sales/useSalesSettings';

// Global navigation observers must not request protected settings for guests.
// Cards/catalogue share the same scoped query via the canonical Sales hook.
export function useSalesSettings(request) {
  const { authResolved, sessionValidated, memberInfo, roleStatus, isFeatureExcluded } = useMemberAccess();
  const enabled = Boolean(authResolved && sessionValidated && memberInfo?.tenant_id
    && roleStatus === 'ready' && !isFeatureExcluded('sales.view'));
  return useScopedSalesSettings(request, { enabled });
}

export function useQuoteNaming() {
  return resolveQuoteNaming(useSalesSettings().data);
}
