import { useSyncExternalStore } from 'react';
import { consentState } from '../lib/consentState.js';
export const CONSENT_STATUS = { PENDING:'pending', ACCEPTED:'accepted', DECLINED:'declined' };
export function useCookieConsent() {
  const s = useSyncExternalStore(consentState.subscribe, consentState.getSnapshot, consentState.getSnapshot);
  const hasConsented = s.ready && s.hasActed && s.categories.analytics === true;
  return {
    categories:s.categories, isLoaded:s.ready, hasConsented,
    hasDeclined:s.hasActed && !hasConsented, isPending:!s.hasActed,
    consentStatus:!s.hasActed ? CONSENT_STATUS.PENDING : hasConsented ? CONSENT_STATUS.ACCEPTED : CONSENT_STATUS.DECLINED,
    acceptCookies:() => consentState.act('accept'), declineCookies:() => consentState.act('reject'),
    resetConsent:() => consentState.act('open'),
  };
}
