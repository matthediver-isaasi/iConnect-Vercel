import { useState, useEffect } from 'react';
import { AlertTriangle, RefreshCw, LogIn } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * StaleTenantOverlay
 *
 * Shown when the server detects that the session's active organisation no
 * longer matches the organisation this tab was opened for (TENANT_CONTEXT_CHANGED).
 * The overlay is intentionally blocking — it cannot be dismissed without
 * reloading or signing in again, preventing further mutations against the
 * wrong tenant.
 */
export default function StaleTenantOverlay() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    function handleTenantContextChanged() {
      setVisible(true);
    }
    window.addEventListener('tenant-context-changed', handleTenantContextChanged);
    return () => {
      window.removeEventListener('tenant-context-changed', handleTenantContextChanged);
    };
  }, []);

  if (!visible) return null;

  const handleReload = () => {
    window.location.reload();
  };

  const handleSignIn = () => {
    const path = window.location.pathname;
    const isAdminPath = path.startsWith('/admin');
    window.location.href = isAdminPath ? '/admin/login' : '/login';
  };

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="stale-tenant-title"
      aria-describedby="stale-tenant-desc"
      style={{ zIndex: 99999 }}
      className="fixed inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <div className="bg-background border rounded-md shadow-lg max-w-md w-full mx-4 p-8 flex flex-col items-center gap-5 text-center">
        <div className="rounded-full bg-warning/10 p-3">
          <AlertTriangle className="h-7 w-7 text-warning" />
        </div>

        <div className="flex flex-col gap-2">
          <h2
            id="stale-tenant-title"
            className="text-lg font-semibold text-foreground"
          >
            Your session has switched organisations
          </h2>
          <p
            id="stale-tenant-desc"
            className="text-sm text-muted-foreground"
          >
            Another tab or window switched to a different organisation.
            This tab is now out of date and cannot make changes until you
            reload it.
          </p>
        </div>

        <div className="flex flex-col gap-2 w-full">
          <Button
            data-testid="button-stale-tenant-reload"
            onClick={handleReload}
            className="w-full"
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            Reload this tab
          </Button>
          <Button
            data-testid="button-stale-tenant-signin"
            variant="outline"
            onClick={handleSignIn}
            className="w-full"
          >
            <LogIn className="h-4 w-4 mr-2" />
            Sign in again
          </Button>
        </div>
      </div>
    </div>
  );
}
