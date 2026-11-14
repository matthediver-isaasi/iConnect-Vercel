import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router-dom';
import { getTenantSlugFromLocation } from '@/api/publicClient';
import { externalAwardApplicantAuthority, externalAwardApplicantEpoch, subscribeExternalAwardApplicant, syncExternalAwardApplicantRoute } from '@/lib/externalAwardApplicantAccess';

export function useExternalAwardApplicant(applicationId) {
  const location = useLocation();
  const epoch = useSyncExternalStore(subscribeExternalAwardApplicant, externalAwardApplicantEpoch, () => 0);
  const last = useRef(null);
  const context = JSON.stringify([location.pathname, location.search, applicationId]);
  // The existing POP guard temporarily restores browser history before the
  // router commits. Do not unmount a dirty worksheet merely for that transient
  // URL. Its authority still refuses requests until the URL is restored.
  const transient = `${window.location.pathname}${window.location.search}` !== `${location.pathname}${location.search}`;
  const retained = transient && last.current?.context === context && last.current.epoch === epoch ? last.current.authority : null;
  let tenantSlug = null, error = '';
  try { tenantSlug = retained ? retained.tenantSlug : getTenantSlugFromLocation(); } catch { error = 'The organisation could not be resolved. Reopen the original secure link.'; }
  const authority = retained || (error ? null : externalAwardApplicantAuthority(applicationId, tenantSlug, getTenantSlugFromLocation));
  useLayoutEffect(() => {
    if (!transient) syncExternalAwardApplicantRoute();
  }, [transient, epoch, tenantSlug, applicationId, location.pathname, location.search, location.hash]);
  if (authority) last.current = { authority, context, epoch };
  return authority || {
    externalApplicant: true, status: 'error', tenantSlug, scopeKey: `external-unavailable:${epoch}`,
    error: error || 'This secure application link is missing, expired, revoked or no longer matches this organisation/application. Reopen the original link or ask the award administrator to resend it. There is no self-service renewal or member sign-in fallback.',
    assertCurrent() { throw new Error('Reopen the original secure application link.'); },
  };
}
