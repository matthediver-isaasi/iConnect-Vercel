import { useCookieConsent } from '@/hooks/useCookieConsent';
import { Button } from '@/components/ui/button';
import { Cookie } from 'lucide-react';

export default function CookieConsent() {
  const { isLoaded, isPending, acceptCookies, declineCookies } = useCookieConsent();

  if (!isLoaded || !isPending) {
    return null;
  }

  return (
    <div 
      className="fixed bottom-0 left-0 right-0 p-4 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-700 shadow-lg"
      style={{ zIndex: 9999 }}
      role="dialog"
      aria-label="Cookie consent"
      data-testid="banner-cookie-consent"
    >
      <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-start gap-3 flex-1">
          <div className="p-2 bg-blue-100 dark:bg-blue-900 rounded-lg shrink-0">
            <Cookie className="w-5 h-5 text-blue-600 dark:text-blue-400" />
          </div>
          <div className="text-sm text-slate-600 dark:text-slate-300">
            <p className="font-medium text-slate-900 dark:text-white mb-1">
              We use cookies
            </p>
            <p>
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
        
        <div className="flex items-center gap-3 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={declineCookies}
            data-testid="button-decline-cookies"
          >
            Decline
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={acceptCookies}
            data-testid="button-accept-cookies"
          >
            Accept
          </Button>
        </div>
      </div>
    </div>
  );
}
