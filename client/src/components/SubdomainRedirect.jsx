import { useEffect } from 'react';

export default function SubdomainRedirect() {
  useEffect(() => {
    async function checkRedirect() {
      try {
        const host = window.location.hostname.toLowerCase();
        
        if (host === 'localhost' || host === '127.0.0.1' || 
            host.includes('.replit.dev') || host.includes('.repl.co')) {
          return;
        }
        
        if (!host.endsWith('.iconn.app')) {
          return;
        }
        
        if (host === 'iconn.app' || host === 'www.iconn.app') {
          return;
        }
        
        const parts = host.replace('.iconn.app', '').split('.');
        if (parts.length !== 1 || parts[0] === 'www' || parts[0] === 'iconn') {
          return;
        }
        
        const slug = parts[0];
        
        const response = await fetch(`/api/public/tenant-redirect?slug=${encodeURIComponent(slug)}`);
        if (!response.ok) {
          return;
        }
        
        const data = await response.json();
        const customDomain = data.redirectTo;
        
        if (!customDomain) {
          return;
        }
        
        if (customDomain.toLowerCase() === host) {
          return;
        }
        
        if (customDomain.endsWith('.iconn.app')) {
          const customParts = customDomain.replace('.iconn.app', '').split('.');
          if (customParts.length === 1 && customParts[0] === slug) {
            return;
          }
        }
        
        const redirectUrl = `https://${customDomain}${window.location.pathname}${window.location.search}`;
        
        const link = document.querySelector('link[rel="canonical"]');
        if (link) {
          link.href = redirectUrl;
        } else {
          const newLink = document.createElement('link');
          newLink.rel = 'canonical';
          newLink.href = redirectUrl;
          document.head.appendChild(newLink);
        }
        
        window.location.replace(redirectUrl);
        
      } catch (err) {
        console.error('[SubdomainRedirect] Error:', err);
      }
    }
    
    checkRedirect();
  }, []);
  
  return null;
}
