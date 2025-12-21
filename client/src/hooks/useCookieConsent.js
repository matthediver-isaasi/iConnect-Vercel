import { useState, useEffect, useCallback } from 'react';

const COOKIE_CONSENT_KEY = 'cookie-consent';

export const CONSENT_STATUS = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
};

export function useCookieConsent() {
  const [consentStatus, setConsentStatus] = useState(CONSENT_STATUS.PENDING);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(COOKIE_CONSENT_KEY);
    if (stored === CONSENT_STATUS.ACCEPTED || stored === CONSENT_STATUS.DECLINED) {
      setConsentStatus(stored);
    }
    setIsLoaded(true);
  }, []);

  const acceptCookies = useCallback(() => {
    localStorage.setItem(COOKIE_CONSENT_KEY, CONSENT_STATUS.ACCEPTED);
    setConsentStatus(CONSENT_STATUS.ACCEPTED);
  }, []);

  const declineCookies = useCallback(() => {
    localStorage.setItem(COOKIE_CONSENT_KEY, CONSENT_STATUS.DECLINED);
    setConsentStatus(CONSENT_STATUS.DECLINED);
  }, []);

  const resetConsent = useCallback(() => {
    localStorage.removeItem(COOKIE_CONSENT_KEY);
    setConsentStatus(CONSENT_STATUS.PENDING);
  }, []);

  const hasConsented = consentStatus === CONSENT_STATUS.ACCEPTED;
  const hasDeclined = consentStatus === CONSENT_STATUS.DECLINED;
  const isPending = consentStatus === CONSENT_STATUS.PENDING;

  return {
    consentStatus,
    isLoaded,
    hasConsented,
    hasDeclined,
    isPending,
    acceptCookies,
    declineCookies,
    resetConsent,
  };
}
