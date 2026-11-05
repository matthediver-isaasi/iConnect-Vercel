import React, { useCallback, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import CanvasPageRenderer from "@/components/canvas/CanvasPageRenderer";
import { Button } from "@/components/ui/button";
import { popupConfig } from "@/lib/cmsPopups";
import { popupExternalInterferenceActive } from "@/lib/popupInterference";
import { popupDiagnostic } from "@/lib/popupDiagnostics";

export default function PopupModal({ popup, open, onClose, preview = false, previewWidth, restoreFocusOnCloseRef, children }) {
  const observer = useRef(null);
  const restoreFocus = useRef(typeof document !== "undefined" ? document.activeElement : null);
  const [width, setWidth] = useState(0);
  const modal = popupConfig(popup).modal;
  // Radix portals can attach after the host's initial layout effect. A callback
  // ref observes the actual content mount, including the very first opening.
  const measure = useCallback((node) => {
    observer.current?.disconnect();
    if (!node) return;
    popupDiagnostic("modal_content_mounted");
    observer.current = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.current.observe(node);
  }, []);
  const breakpoint = width < 640 ? "mobile" : width < 1024 ? "tablet" : "desktop";
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[70]" style={{ background: modal.overlay }} />
      <Dialog.Content aria-describedby={undefined} data-cms-popup-modal
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          // Radix schedules this after unmount. Do not steal focus from a new
          // modal/critical flow or a control the visitor has already focused.
          const active = document.activeElement;
          if (restoreFocusOnCloseRef?.current === false || popupExternalInterferenceActive()
            || (active && active !== document.body && !active.closest("[data-cms-popup-modal]"))) return;
          if (restoreFocus.current?.isConnected) restoreFocus.current.focus?.({ preventScroll: true });
        }}
        className="fixed left-1/2 top-1/2 z-[71] flex -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden outline-none"
        style={{ width: `min(${previewWidth || modal.width}px, calc(100vw - 24px))`,
          maxHeight: `min(${modal.max_height}dvh, calc(100dvh - 24px))`,
          background: modal.background, border: `${modal.border_width}px solid ${modal.border_color}`,
          borderRadius: modal.radius, boxShadow: ({ none: "none", sm: "0 2px 8px #0f172a24", md: "0 8px 20px #0f172a30", lg: "0 20px 55px #0f172a40", xl: "0 28px 80px #0f172a55" })[modal.shadow] }}>
        <div className="flex shrink-0 items-center gap-3 border-b px-3 py-2"
          style={{ flexDirection: modal.close_position === "left" ? "row" : "row-reverse" }}>
          <Dialog.Close asChild><Button aria-label="Close popup" size="icon" variant="ghost"><X className="h-4 w-4" /></Button></Dialog.Close>
          <Dialog.Title className={preview ? "text-sm font-medium" : "sr-only"}>{preview ? `Preview — ${popup.name} · ${breakpoint}` : popup.name || "Announcement"}</Dialog.Title>
        </div>
        <div className="min-h-0 overflow-auto overscroll-contain" style={{ padding: modal.padding }}>
          <div ref={measure} className="min-w-0">
            {width > 0 && <CanvasPageRenderer embedded contentWidth={width} forceBreakpoint={breakpoint}
              editorPreview={preview} micrositeId={popup.microsite_id} symbols={popup.symbols || []}
              page={{ id: popup.id, canvas_design: popup.design }} />}
          </div>
          {children}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
