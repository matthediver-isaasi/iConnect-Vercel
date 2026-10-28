import React, { createContext, useContext, useRef, useState } from "react";
import { Button as UiButton } from "@/components/ui/button";
import { CardContent as UiCardContent } from "@/components/ui/card";
import { Dialog as UiDialog, DialogContent as UiDialogContent } from "@/components/ui/dialog";
import { RefreshCw } from "lucide-react";

const SaveContext = createContext(null);

export function EventSettingsSaveBoundary({ children, unavailable = false }) {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const run = async (action, event) => {
    if (lock.current || unavailable) return;
    lock.current = true;
    setBusy(true);
    try { await action(event); }
    finally { lock.current = false; setBusy(false); }
  };
  return <SaveContext.Provider value={{ busy, unavailable, run }}>
    {busy && <div role="status" className="fixed bottom-4 right-4 z-[100] flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-3 text-white shadow-lg">
      <RefreshCw className="h-4 w-4 animate-spin" /> Saving… Please wait.
    </div>}
    {children}
  </SaveContext.Provider>;
}

export function Button({ onClick, children, disabled, ...props }) {
  const context = useContext(SaveContext);
  const [pending, setPending] = useState(false);
  const isSave = onClick?.constructor?.name === 'AsyncFunction';
  const click = isSave ? (event) => context.run(async () => {
    setPending(true);
    try { await onClick(event); } finally { setPending(false); }
  }, event) : onClick;
  return <UiButton {...props} disabled={disabled || context?.busy || context?.unavailable} onClick={click}>
    {pending ? <><RefreshCw className="mr-2 h-4 w-4 animate-spin" />Saving…</> : children}
  </UiButton>;
}

function LockedControls({ children }) {
  const context = useContext(SaveContext);
  const locked = context?.busy || context?.unavailable;
  return <fieldset disabled={locked} inert={locked ? '' : undefined} aria-busy={context?.busy || undefined} className="min-w-0">
    {children}
  </fieldset>;
}

export function CardContent({ children, ...props }) {
  return <UiCardContent {...props}><LockedControls>{children}</LockedControls></UiCardContent>;
}

export function DialogContent({ children, ...props }) {
  const context = useContext(SaveContext);
  return <UiDialogContent {...props}
    onEscapeKeyDown={event => { if (context?.busy) event.preventDefault(); }}
    onInteractOutside={event => { if (context?.busy) event.preventDefault(); }}>
    <LockedControls>{children}</LockedControls>
  </UiDialogContent>;
}

export function Dialog({ onOpenChange, ...props }) {
  const context = useContext(SaveContext);
  return <UiDialog {...props} onOpenChange={open => { if (!context?.busy) onOpenChange?.(open); }} />;
}
