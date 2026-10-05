import React from 'react';

// Keep the content subtree mounted when readiness closes (for example after
// an explicit permission invalidation). Only its visibility changes.
export default function PortalReadiness({ ready, error, onRetry, retryLabel = 'Try again', recovering = false, offline = false, children }) {
  return (
    <>
      {ready && recovering && (
        <div role="status" aria-live="polite" className="fixed top-3 left-1/2 -translate-x-1/2 z-50 rounded border bg-background px-4 py-2 shadow-sm">
          {offline ? 'You are offline. Unsaved changes remain in this tab; they have not been saved to the server.' : 'Reconnecting to your session…'}
        </div>
      )}
      {!ready && (
        <div className="min-h-screen flex items-center justify-center bg-background">
          <div role={error && !recovering ? 'alert' : 'status'} aria-live="polite" className="text-center space-y-3">
            <p>{recovering ? 'Reconnecting to your session…' : error ? error.message : 'Loading portal…'}</p>
            {(error || recovering) && onRetry && (
              <button type="button" className="underline" disabled={recovering} onClick={onRetry}>{recovering ? 'Retrying…' : retryLabel}</button>
            )}
          </div>
        </div>
      )}
      <div hidden={!ready} aria-hidden={!ready || undefined}>{children}</div>
    </>
  );
}