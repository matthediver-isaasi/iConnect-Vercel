import { useState, useEffect, useCallback } from 'react';

const COOKIE_CONSENT_KEY = 'cookie-consent';
const consentSubscribers = new Set();

export const CONSENT_STATUS = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
};

function readConsent() {
  try {
    return typeof window !== 'undefined' ? window.localStorage?.getItem(COOKIE_CONSENT_KEY) : null;
  } catch {
    return null;
  }
}

function writeConsent(value) {
  try {
    window.localStorage?.setItem(COOKIE_CONSENT_KEY, value);
  } catch {
    // Privacy mode / blocked storage means consent cannot be persisted.
  }
}

function publishConsentStatus(status) {
  consentSubscribers.forEach((subscriber) => subscriber(status));
}

export function useCookieConsent() {
  const [consentStatus, setConsentStatus] = useState(CONSENT_STATUS.PENDING);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    const handleConsentChange = (status) => {
      if (
        status === CONSENT_STATUS.ACCEPTED
        || status === CONSENT_STATUS.DECLINED
        || status === CONSENT_STATUS.PENDING
      ) {
        setConsentStatus(status);
        setIsLoaded(true);
      }
    };
    consentSubscribers.add(handleConsentChange);

    const stored = readConsent();
    if (stored === CONSENT_STATUS.ACCEPTED || stored === CONSENT_STATUS.DECLINED) {
      setConsentStatus(stored);
    }
    setIsLoaded(true);

    return () => {
      consentSubscribers.delete(handleConsentChange);
    };
  }, []);

  const acceptCookies = useCallback(() => {
    writeConsent(CONSENT_STATUS.ACCEPTED);
    publishConsentStatus(CONSENT_STATUS.ACCEPTED);
  }, []);

  const declineCookies = useCallback(() => {
    writeConsent(CONSENT_STATUS.DECLINED);
    publishConsentStatus(CONSENT_STATUS.DECLINED);
  }, []);

  const resetConsent = useCallback(() => {
    try {
      window.localStorage?.removeItem(COOKIE_CONSENT_KEY);
    } catch {
      // Privacy mode / blocked storage means there is nothing to remove.
    }
    publishConsentStatus(CONSENT_STATUS.PENDING);
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
