import { useEffect, useState } from 'react';
import { CookieBanner, CookiePreferences, RecallButton, initCookieYes } from '@cookieyes/react';
import { resetConsentRuntime } from '../lib/resetConsentRuntime.js';
import { ga4 } from '@cookieyes/scripts';
import '@cookieyes/react/styles.css';
import { CONSENT_CATEGORIES } from '../../../shared/cookieConsent.js';
import { useTenantBranding } from '../contexts/TenantBrandingContext';
import { consentState } from '../lib/consentState.js';
import { disableTracking, enableTracking, trackConsentPage, clearTrackingStorage } from '../lib/consentTracking.js';

export default function CookieConsent() {
  const branding = useTenantBranding();
  const [ready,setReady] = useState(false);
  const [links,setLinks]=useState({});
  useEffect(() => {
    let disposed = false, runtime, scope, granted = false, tagReady = false;
    let initialRevision, initialTenant, initialActive;
    let observedCookie;
    const readScopedCookie=()=>{try{return document.cookie.split(';').find(c=>c.trim().startsWith(`cookieyes-consent-${scope}=`)) || '';}catch{return '';}};
    const startedOnAdmin = /^\/(?:admin|platform)/i.test(location.pathname);
    const abort = new AbortController();
    consentState.deny();
    async function load() {
      try {
        const response = await fetch('/api/public/cookie-consent', { credentials:'omit', cache:'no-store',signal:abort.signal });
        if (!response.ok) throw new Error('Consent configuration unavailable');
        const data = await response.json();
        if (disposed || data.host !== location.hostname) return;
        const requested=new URLSearchParams(location.search);
        if ((requested.get('tenant') && requested.get('tenant')!==data.tenantSlug) ||
            (requested.get('domain') && requested.get('domain')!==data.host)) return;
        if (branding?.branding?.slug && branding.branding.slug !== data.tenantSlug) return;
        initialRevision=data.revision;initialTenant=data.tenantId;initialActive=data.active;
        scope = `${data.tenantId}-${data.revision}`;
        const analytics = data.active && data.config.analyticsEnabled && !/^\/(?:admin|platform)/i.test(location.pathname);
        const id = analytics ? data.ga4MeasurementId : null;
        const publish = () => {
          if (!runtime || disposed) return;
          const s = runtime.getSnapshot();
          observedCookie=readScopedCookie();
          const categories = {...s.committedCategories,analytics:analytics && s.committedCategories.analytics};
          consentState.publish({ready:true,hasActed:s.hasActed,categories},{
            accept:()=>runtime.manager.acceptAll(),
            reject:()=>runtime.manager.rejectAll(),
            open:()=>runtime.manager.showPreferences(),
          });
          if (s.hasActed && categories.analytics) {
            granted = true;
            if (id && tagReady) enableTracking(id);
          } else if (granted) { granted=false; disableTracking(id); }
          else if (!categories.analytics) clearTrackingStorage();
        };
        const preset = id ? ga4({measurementId:id,consentMode:'basic',params:{send_page_view:false}}) : null;
        const integration = preset ? {...preset,async setup(ctx) {
          const cleanup=await preset.setup(ctx);
          tagReady=true;
          if (!disposed && consentState.getSnapshot().categories.analytics) enableTracking(id);
          return cleanup;
        }} : null;
        runtime = initCookieYes({
          mode:'self-hosted',regulation:'GDPR',categories:CONSENT_CATEGORIES,
          theme:{primaryColor:/^#[a-f0-9]{6}$/i.test(data.primaryColor || '') ? data.primaryColor : '#174b72',fontFamily:'inherit'},
          i18n:{locale:'en',messages:{en:{bannerTitle:data.config.title,bannerDescription:data.config.description,preferencesIntro:data.config.description}}},
          backend:{
            storageScope:scope,
            async persist(record) {
              if (disposed || record.domain !== location.hostname) throw new Error('Stale consent context');
              const result = await fetch('/api/public/cookie-consent',{method:'POST',credentials:'omit',
                headers:{'Content-Type':'application/json'},body:JSON.stringify({...record,policyVersion:data.config.policyVersion,policyRevision:data.revision}),keepalive:true});
              if (!result.ok) throw new Error('Consent record not confirmed');
            },
          },
          integrations:integration ? [integration] : [],
          onConsentReady:publish, onConsentUpdate:publish,
        });
        publish();
        setLinks({privacy:data.config.privacyUrl,cookies:data.config.cookieUrl});
        setReady(true);
      } catch (error) {
        if (!disposed) { consentState.deny(); disableTracking(); }
      }
    }
    load();
    const navigation = () => {
      const requested=new URLSearchParams(location.search);
      if (requested.has('tenant') || requested.has('domain')) {
        consentState.deny();disableTracking();location.reload();return;
      }
      if (startedOnAdmin !== /^\/(?:admin|platform)/i.test(location.pathname)) {
        consentState.deny();disableTracking();location.reload();return;
      }
      trackConsentPage();
    };
    window.addEventListener('popstate',navigation);
    const push = history.pushState, replace = history.replaceState;
    history.pushState = function(...args) { push.apply(this,args);navigation(); };
    history.replaceState = function(...args) { replace.apply(this,args);navigation(); };
    const storageChanged = async () => {
      if (scope && observedCookie !== undefined && readScopedCookie() !== observedCookie) {
        consentState.deny();disableTracking();location.reload();return;
      }
      try {
        const response=await fetch('/api/public/cookie-consent',{credentials:'omit',cache:'no-store',signal:abort.signal});
        if (!response.ok) throw Error('Configuration unavailable');
        const current=await response.json();
        if (disposed) return;
        if (initialRevision && (current.revision!==initialRevision || current.tenantId!==initialTenant || current.active!==initialActive)) {
          consentState.deny();disableTracking();location.reload();return;
        }
      } catch {
        if (!disposed) { consentState.deny();disableTracking();resetConsentRuntime(runtime);setReady(false); }
        return;
      }
      if (scope && !document.cookie.split(';').some(c=>c.trim().startsWith(`cookieyes-consent-${scope}=`))) {
        consentState.deny(); disableTracking(); resetConsentRuntime(runtime); setReady(false); load();
      }
    };
    window.addEventListener('focus',storageChanged);
    window.addEventListener('storage',storageChanged);
    const refresh=setInterval(storageChanged,60000);
    return () => {
      disposed=true;abort.abort();setReady(false);consentState.deny();
      window.removeEventListener('popstate',navigation);
      window.removeEventListener('focus',storageChanged);
      window.removeEventListener('storage',storageChanged);
      clearInterval(refresh);
      history.pushState=push;history.replaceState=replace;
      resetConsentRuntime(runtime);
      if (granted) disableTracking();
    };
  },[branding?.tenantSlug]);
  if (!ready) return null;
  return <><CookieBanner /><CookiePreferences /><RecallButton />
    <nav aria-label="Privacy policies" className="fixed bottom-2 right-2 z-[9999] rounded bg-white p-2 text-sm text-slate-900 shadow">
      {links.privacy && <a className="underline mr-3" href={links.privacy}>Privacy policy</a>}
      {links.cookies && <a className="underline" href={links.cookies}>Cookie declaration</a>}
    </nav>
  </>;
}
