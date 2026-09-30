import React, { Component, Suspense } from 'react';
import { handleStaleChunkError } from '../../lib/staleChunkReload';

export function RouteLoadingStatus() {
  return (
    <div className="flex min-h-48 items-center justify-center p-8" role="status" aria-live="polite">
      Loading page…
    </div>
  );
}

export class RouteErrorBoundary extends Component {
  state = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromProps(props, state) {
    return props.resetKey !== state.resetKey
      ? { error: null, resetKey: props.resetKey }
      : null;
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    // React catches lazy import rejections, so they need not reach the global
    // unhandledrejection handler. Use the same loop-guarded recovery here.
    handleStaleChunkError(error);
  }

  render() {
    if (this.state.error) {
      return (
        <section className="p-8 text-center" role="alert">
          <h1 className="text-lg font-semibold">Unable to load this page</h1>
          <p className="my-3">Check your connection and refresh, or choose another page.</p>
          <button className="rounded border px-4 py-2" type="button" onClick={() => window.location.reload()}>
            Refresh page
          </button>
        </section>
      );
    }
    return this.props.children;
  }
}

export function RouteLoadingBoundary({ children, resetKey }) {
  return (
    <RouteErrorBoundary resetKey={resetKey}>
      <Suspense fallback={<RouteLoadingStatus />}>{children}</Suspense>
    </RouteErrorBoundary>
  );
}