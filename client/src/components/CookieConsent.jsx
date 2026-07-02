import { useCookieConsent } from '@/hooks/useCookieConsent';
import { Button } from '@/components/ui/button';
import { Cookie } from 'lucide-react';

export default function CookieConsent() {
  const { isLoaded, isPending, acceptCookies, declineCookies } = useCookieConsent();

  // Don't show cookie banner in embedded iframes
  const isEmbedded = typeof window !== 'undefined' && window.self !== window.top;

  if (!isLoaded || !isPending || isEmbedded) {
    return null;
  }

  return (
    <div 
      className="fixed bottom-0 inset-x-0 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-700 shadow-lg"
      style={{ zIndex: 9999, width: '100%', maxWidth: '100vw', overflowX: 'hidden' }}
      role="dialog"
      aria-label="Cookie consent"
      data-testid="banner-cookie-consent"
    >
      <div className="p-3 sm:p-4 w-full">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 sm:gap-4">
          <div className="flex items-start gap-2 sm:gap-3 min-w-0 flex-1">
            <div className="p-1.5 sm:p-2 bg-blue-100 dark:bg-blue-900 rounded-lg shrink-0">
              <Cookie className="w-4 h-4 sm:w-5 sm:h-5 text-blue-600 dark:text-blue-400" />
            </div>
            <div className="text-xs sm:text-sm text-slate-600 dark:text-slate-300 min-w-0 flex-1">
              <p className="font-medium text-slate-900 dark:text-white mb-0.5 sm:mb-1">
                We use cookies
              </p>
              <p className="break-words">
                We use cookies to enhance your experience. By continuing to visit this site you agree to our use of cookies.{' '}
                <a 
                  href="https://www.graduatefutures.org/privacy-policy" 
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 dark:text-blue-400 hover:underline"
                  data-testid="link-privacy-policy"
                >
                  Learn more
                </a>
              </p>
            </div>
          </div>
          
          <div className="flex items-center gap-2 sm:gap-3 shrink-0 w-full sm:w-auto">
            <Button
              variant="outline"
              size="sm"
              onClick={declineCookies}
              className="flex-1 sm:flex-none"
              data-testid="button-decline-cookies"
            >
              Decline
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={acceptCookies}
              className="flex-1 sm:flex-none"
              data-testid="button-accept-cookies"
            >
              Accept
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
