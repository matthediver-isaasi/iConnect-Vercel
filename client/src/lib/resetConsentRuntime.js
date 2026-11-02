import {resetCookieYes} from '@cookieyes/react';
export function resetConsentRuntime(runtime) {
  runtime?.manager?.dispose();
  resetCookieYes();
}
