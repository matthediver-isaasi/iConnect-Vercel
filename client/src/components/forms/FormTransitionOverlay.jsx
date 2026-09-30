import { Loader2 } from 'lucide-react';

const TRANSITION_MESSAGE = 'Please hold tight for a few seconds…';

export default function FormTransitionOverlay({ active, children, className = '' }) {
  return (
    <div
      className={`relative ${className}`}
      aria-busy={active ? 'true' : undefined}
      data-form-transition-surface
    >
      <div
        inert={active ? '' : undefined}
        aria-hidden={active ? 'true' : undefined}
        className={active ? 'pointer-events-none select-none blur-[1px]' : undefined}
        data-form-transition-content
      >
        {children}
      </div>
      {active && (
        <div
          className="absolute inset-0 z-50 flex min-h-[160px] cursor-wait items-center justify-center bg-white/55 p-4 backdrop-blur-[2px]"
          data-testid="form-transition-overlay"
        >
          <div
            className="flex max-w-sm flex-col items-center rounded-xl bg-white/95 px-6 py-5 text-center shadow-lg ring-1 ring-slate-200"
            role="status"
            aria-live="polite"
          >
            <Loader2
              className="mb-3 h-8 w-8 animate-spin text-blue-600 motion-reduce:animate-none"
              aria-hidden="true"
            />
            <p className="text-sm font-medium text-slate-700">{TRANSITION_MESSAGE}</p>
          </div>
        </div>
      )}
    </div>
  );
}