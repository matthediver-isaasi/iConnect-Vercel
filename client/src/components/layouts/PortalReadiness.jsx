import React from 'react';

// Keep the content subtree mounted when readiness closes (for example after
// an explicit permission invalidation). Only its visibility changes.
export default function PortalReadiness({ ready, error, onRetry, children }) {
  return (
    <>
      {!ready && (
        <div className="min-h-screen flex items-center justify-center bg-background">
          <div role={error ? 'alert' : 'status'} aria-live="polite" className="text-center space-y-3">
            <p>{error ? error.message : 'Loading portal…'}</p>
            {error && onRetry && (
              <button type="button" className="underline" onClick={onRetry}>Try again</button>
            )}
          </div>
        </div>
      )}
      <div hidden={!ready} aria-hidden={!ready || undefined}>{children}</div>
    </>
  );
}