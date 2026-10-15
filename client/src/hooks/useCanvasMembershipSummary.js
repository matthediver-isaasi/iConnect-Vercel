import { useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLayoutContext } from '@/contexts/LayoutContext';
import { useTenantBranding } from '@/contexts/TenantBrandingContext';
import { getActiveTenantId, subscribeToActiveTenantId } from '@/api/base44Client';
import { canvasMembershipQueryKey, normalizeCanvasMembershipSummary } from '@/lib/canvasMembershipData';

// Deliberately separate from saved configuration and never used on the public path.
const EDITOR_SAMPLE = {
  membership: { state: 'active', memberSince: '2020-01-01', membershipType: 'Example membership' },
  payment: {
    state: 'active', method: 'monthly_direct_debit', nextPayment: '2030-10-01',
    amount: 18.5, currency: 'GBP', collectionStatus: 'planned',
    nextCollection: { date: '2030-10-01', amount: 18.5, currency: 'GBP', status: 'planned' },
    plannedPayment: { date: '2030-10-01', amount: 18.5, currency: 'GBP' },
    mandateStatus: 'active',
  },
};

export async function fetchCanvasMembershipSummary({ signal, tenantId } = {}) {
  const response = await fetch('/api/membership/canvas-summary', {
    credentials: 'include', cache: 'no-store', signal,
    headers: tenantId ? { 'X-Tenant-Id': tenantId } : {},
  });
  if (!response.ok) {
    const error = new Error('Membership details could not be loaded.');
    error.status = response.status;
    throw error;
  }
  const result = await response.json();
  if (!result || typeof result.membership !== 'object' || !result.membership
    || typeof result.payment !== 'object' || !result.payment) {
    throw new Error('The membership summary response was invalid.');
  }
  return normalizeCanvasMembershipSummary(result);
}

export async function fetchCanvasRenewalPrice({ signal, tenantId } = {}) {
  const response = await fetch('/api/membership/canvas-renewal-price', {
    credentials: 'include', cache: 'no-store', signal,
    headers: tenantId ? { 'X-Tenant-Id': tenantId } : {},
  });
  if (!response.ok) {
    const error = new Error('Renewal price could not be loaded.');
    error.status = response.status;
    throw error;
  }
  const result = await response.json();
  // The separate self-only quote endpoint is the verification boundary. Never
  // source this value from summary.payment or a retained signup/payment record.
  return normalizeCanvasMembershipSummary({ renewal: {
    eligible: true, price: result?.price ? { ...result.price, verified: true } : null,
  } }).renewal.price || null;
}

export function useCanvasMembershipSummary({ asEditor = false } = {}) {
  const { authResolved, sessionValidated, memberInfo } = useLayoutContext();
  const branding = useTenantBranding();
  const activeTenantId = useSyncExternalStore(subscribeToActiveTenantId, getActiveTenantId, () => null);
  const tenantId = activeTenantId || memberInfo?.tenant_id || '';
  const authenticated = authResolved && sessionValidated && !!memberInfo?.id;
  const tenantMismatch = activeTenantId && memberInfo?.tenant_id
    && String(activeTenantId) !== String(memberInfo.tenant_id);
  const enabled = !asEditor && typeof window !== 'undefined' && authenticated && !tenantMismatch;
  const scopeKey = canvasMembershipQueryKey({
    tenantId, tenantSlug: branding?.tenantSlug,
    host: typeof window !== 'undefined' ? window.location.host : '',
    viewerId: authenticated ? memberInfo.id : '',
  });
  const query = useQuery({
    queryKey: scopeKey,
    queryFn: ({ signal }) => fetchCanvasMembershipSummary({ signal, tenantId }),
    enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnMount: 'always',
    // Never hydrate/dehydrate this private response as page or offline data.
    meta: { private: true, persist: false },
  });
  const requestPrice = enabled && query.isSuccess && query.data?.renewal.eligible === true
    && ['upfront', 'card', 'bank_transfer', 'invoice'].includes(query.data?.payment.method);
  const priceQuery = useQuery({
    queryKey: ['canvas-membership-renewal-price', ...scopeKey.slice(1),
      query.data?.membership.termStartDate || '', query.data?.membership.expiryDate || '',
      query.data?.membership.renewalDate || ''],
    queryFn: ({ signal }) => fetchCanvasRenewalPrice({ signal, tenantId }),
    enabled: requestPrice,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnMount: 'always',
    meta: { private: true, persist: false },
  });
  if (asEditor) return { status: 'ready', data: EDITOR_SAMPLE, isSample: true };
  if (!authResolved || typeof window === 'undefined') return { status: 'loading', data: null };
  if (tenantMismatch) return { status: 'denied', data: null };
  if (!authenticated) return { status: 'guest', data: null };
  if (query.isError) return {
    status: query.error?.status === 401 ? 'guest' : query.error?.status === 403 ? 'denied' : 'error',
    data: null,
  };
  if (!query.data) return { status: 'loading', data: null };
  return { status: 'ready', data: { ...query.data, renewal: {
    ...query.data.renewal,
    // Never leak a cached quote through a disabled observer on auth/term change.
    price: requestPrice && priceQuery.isSuccess ? priceQuery.data || undefined : undefined,
    ...(requestPrice ? { priceState: priceQuery.isError ? 'unavailable'
      : priceQuery.isSuccess ? (priceQuery.data ? 'ready' : 'unavailable') : 'loading' } : {}),
  } }, isSample: false };
}