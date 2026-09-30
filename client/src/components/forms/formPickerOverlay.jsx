import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { PopoverContent as SharedPopoverContent } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import {
  readFormPickerViewport,
  getFormPickerPlacement,
  formPickerCollisionPadding,
  formPickerDialogStyle,
  subscribeFormPickerViewport,
} from '@/lib/formPickerGeometry';
import './formPickerOverlay.css';

const PickerContext = React.createContext(null);

function isEmbedded() {
  return typeof window !== 'undefined' && window.parent !== window;
}

export function Popover({ open: controlledOpen, defaultOpen = false, onOpenChange, children, ...props }) {
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
  const open = controlledOpen ?? internalOpen;
  const openRef = React.useRef(open);
  openRef.current = open;
  const dialogId = React.useId();
  const trigger = React.useRef(null);
  const [geometry, setGeometry] = React.useState(null);
  const [dialog, setDialog] = React.useState(false);
  const embedded = isEmbedded();
  const changeOpen = React.useCallback(next => {
    if (next && embedded && trigger.current) {
      const viewport = readFormPickerViewport();
      const placement = getFormPickerPlacement(trigger.current.getBoundingClientRect(), viewport, { searchable: true });
      setGeometry({ viewport, ...placement });
      setDialog(placement.dialog);
    }
    setInternalOpen(next);
    onOpenChange?.(next);
  }, [embedded, onOpenChange]);
  React.useLayoutEffect(() => {
    if (!open || !embedded || !trigger.current) return;
    return subscribeFormPickerViewport(trigger.current, (viewport, rect) => {
      const placement = getFormPickerPlacement(rect, viewport, { searchable: true });
      setGeometry({ viewport, ...placement });
      // Latch until close: focusing search may open the software keyboard.
      // Switching back while it dismisses would remount/focus search again.
      if (placement.dialog) setDialog(true);
      if (!dialog && (rect.bottom <= viewport.top || rect.top >= viewport.bottom)) changeOpen(false);
    });
  }, [open, embedded, dialog, changeOpen]);
  const context = { embedded, open, openRef, dialogId, changeOpen, trigger, geometry, dialog };
  return (
    <PickerContext.Provider value={context}>
      <PopoverPrimitive.Root {...props} open={open && !(embedded && dialog)} onOpenChange={changeOpen}>
        {children}
      </PopoverPrimitive.Root>
    </PickerContext.Provider>
  );
}

export const PopoverTrigger = React.forwardRef(function FormPopoverTrigger(props, ref) {
  const context = React.useContext(PickerContext);
  const setRef = React.useCallback(node => {
    context.trigger.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  }, [context.trigger, ref]);
  return <PopoverPrimitive.Trigger {...props} ref={setRef} aria-expanded={context.open} aria-haspopup="dialog"
    {...(context.embedded && context.dialog ? { 'aria-controls': context.open ? context.dialogId : undefined } : {})} />;
});

export const PopoverContent = React.forwardRef(function FormPopoverContent(
  { children, className, style, ...props }, ref,
) {
  const context = React.useContext(PickerContext);
  const { embedded, geometry, dialog, trigger, open, changeOpen } = context;
  if (!embedded || !geometry) {
    return <SharedPopoverContent {...props} ref={ref} className={className} style={style}>{children}</SharedPopoverContent>;
  }
  const label = trigger.current?.getAttribute('aria-label')
    || trigger.current?.textContent?.trim() || 'Choose options';
  const restoreFocus = event => {
    event.preventDefault();
    // Popover unmounts when the keyboard makes a dialog necessary. Do not
    // steal focus back from the replacement dialog during that handoff.
    if (!context.openRef.current) trigger.current?.focus({ preventScroll: true });
  };
  if (dialog) {
    return (
      <DialogPrimitive.Root open={open} onOpenChange={changeOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed z-[60] bg-black/20" style={{
            left: geometry.viewport.left, top: geometry.viewport.top,
            width: geometry.viewport.width, height: geometry.viewport.height,
          }} />
          <DialogPrimitive.Content
            ref={ref}
            id={context.dialogId}
            aria-describedby={undefined}
            onCloseAutoFocus={restoreFocus}
            onOpenAutoFocus={event => {
              const input = event.currentTarget?.querySelector?.('[cmdk-input]');
              if (input) {
                event.preventDefault();
                input.focus({ preventScroll: true });
              }
            }}
            className={cn('form-picker-content z-[61] rounded-md border bg-popover text-popover-foreground shadow-md', className)}
            style={{ ...style, ...formPickerDialogStyle(geometry.viewport) }}
            data-form-picker-dialog=""
          >
            <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
              <DialogPrimitive.Title className="min-w-0 truncate text-sm font-medium">{label}</DialogPrimitive.Title>
              <DialogPrimitive.Close className="shrink-0 rounded border px-2 py-1 text-sm">Done</DialogPrimitive.Close>
            </div>
            {children}
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    );
  }
  return (
    <SharedPopoverContent
      {...props}
      ref={ref}
      className={cn(className, 'form-picker-content')}
      style={{
        ...style,
        width: 'var(--radix-popover-trigger-width)',
        maxWidth: Math.max(0, geometry.viewport.width - 16),
        maxHeight: geometry.maxHeight,
      }}
      side={geometry.side}
      sideOffset={4}
      collisionPadding={formPickerCollisionPadding(geometry.viewport)}
      updatePositionStrategy="always"
      sticky="always"
      onCloseAutoFocus={restoreFocus}
      data-form-picker-menu=""
    >{children}</SharedPopoverContent>
  );
});