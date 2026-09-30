import React from "react";

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', this.props.name || 'unnamed', error, info);
  }

  render() {
    if (this.state.error) {
      if (this.props.fallback) {
        return typeof this.props.fallback === 'function'
          ? this.props.fallback(this.state.error)
          : this.props.fallback;
      }
      return (
        <div className="min-h-screen p-8 flex items-start justify-center bg-slate-50">
          <div className="max-w-2xl w-full bg-white border border-red-200 rounded-md p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-red-700 mb-2">
              Something went wrong while loading this page
            </h2>
            <p className="text-sm text-slate-600 mb-4">
              An unexpected error occurred. Please refresh the page or try again later.
            </p>
            <pre className="text-xs text-slate-500 whitespace-pre-wrap break-words bg-slate-50 p-3 rounded border border-slate-200">
              {String(this.state.error?.message || this.state.error)}
            </pre>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
