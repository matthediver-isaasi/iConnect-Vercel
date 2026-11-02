import React from 'react';
import {createRoot} from 'react-dom/client';
import {initCookieYes,CookieBanner,CookiePreferences,RecallButton} from '@cookieyes/react';
import '@cookieyes/react/styles.css';
import {CONSENT_CATEGORIES,CONSENT_DEFAULTS} from '../../shared/cookieConsent.js';
let config=CONSENT_DEFAULTS;
try { config={...config,...JSON.parse(decodeURIComponent(location.hash.slice(1))).config}; } catch {}
initCookieYes({mode:'cookie-only',regulation:'GDPR',categories:CONSENT_CATEGORIES,
  i18n:{locale:'en',messages:{en:{bannerTitle:config.title,bannerDescription:config.description}}}});
createRoot(document.getElementById('root')).render(<><CookieBanner/><CookiePreferences/><RecallButton/></>);
