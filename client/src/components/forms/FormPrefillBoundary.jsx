import { createContext, useContext, useLayoutEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

const FormPrefillContext = createContext(false);
export const useFormPrefillLocked = () => useContext(FormPrefillContext);

export function blockPrefillInteraction(event) {
  event.preventDefault();
  event.stopPropagation();
}

// Keep the actual form mounted while data is applied. Inert handles tab order
// and native controls; capture handlers also guard React-portalled pickers.
export default function FormPrefillBoundary({ state, children, className = '', contentClassName = '', style }) {
  const locked = !!state?.locked;
  const contentRef = useRef(null);
  useLayoutEffect(() => {
    if (locked && contentRef.current?.contains(document.activeElement)) {
      document.activeElement?.blur?.();
    }
  }, [locked]);
  const guard = locked ? blockPrefillInteraction : undefined;
  return (
    <FormPrefillContext.Provider value={locked}>
      <div className={`relative ${className}`} style={style} aria-busy={locked && !state?.error ? 'true' : undefined} data-form-prefill-surface>
        <div ref={contentRef} inert={locked ? '' : undefined}
          onClickCapture={guard} onPointerDownCapture={guard}
          onKeyDownCapture={guard} onSubmitCapture={guard}
          onFocusCapture={locked ? event => { event.target.blur?.(); } : undefined}
          className={`${contentClassName} ${locked ? 'pointer-events-none select-none' : ''}`}
          data-form-prefill-content>
          {children}
        </div>
        {locked && (
          <div className="absolute inset-0 z-50 flex min-h-[160px] items-start justify-center bg-white/70 p-4"
            data-testid="form-prefill-overlay">
            <div className="sticky top-4 my-4 flex max-w-sm flex-col items-center rounded-xl bg-white/95 px-6 py-5 text-center shadow-lg ring-1 ring-slate-200">
              {state?.error ? (
                <>
                  <p role="alert" className="text-sm text-slate-700">{state.error.message}</p>
                  <Button type="button" variant="outline" className="mt-3"
                    onClick={() => state.error.retry?.()}>Retry loading data</Button>
                </>
              ) : (
                <div role="status" aria-live="polite" aria-atomic="true">
                  <Loader2 aria-hidden="true" className="mx-auto mb-3 h-8 w-8 animate-spin text-blue-600 motion-reduce:animate-none" />
                  <p className="text-sm font-medium text-slate-700">Please wait while we load some data</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </FormPrefillContext.Provider>
  );
}
