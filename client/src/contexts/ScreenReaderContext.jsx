import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useToast } from "@/components/ui/use-toast";

const ScreenReaderContext = createContext({
  optimised: false,
  announce: () => {},
});

export function useScreenReader() {
  return useContext(ScreenReaderContext);
}

/**
 * Provider that exposes the page-level "Screen reader optimised" flag and a
 * single page-level live region. Element renderers can call `announce(message)`
 * to surface async UI changes (form submitted, item added, error etc) to AT
 * users without having to mount their own live region.
 *
 * The live region is mounted unconditionally so children can call announce()
 * even when the optimisation is off — but element-level ARIA branching should
 * key off `optimised`.
 */
export function ScreenReaderProvider({ optimised = false, children }) {
  const [politeMessage, setPoliteMessage] = useState("");
  const [assertiveMessage, setAssertiveMessage] = useState("");
  const politeTimerRef = useRef(null);
  const assertiveTimerRef = useRef(null);

  const announce = useCallback((message, priority = "polite") => {
    if (!message) return;
    const text = String(message);
    if (priority === "assertive") {
      setAssertiveMessage("");
      if (assertiveTimerRef.current) clearTimeout(assertiveTimerRef.current);
      assertiveTimerRef.current = setTimeout(() => {
        setAssertiveMessage(text);
      }, 50);
    } else {
      setPoliteMessage("");
      if (politeTimerRef.current) clearTimeout(politeTimerRef.current);
      politeTimerRef.current = setTimeout(() => {
        setPoliteMessage(text);
      }, 50);
    }
  }, []);

  useEffect(
    () => () => {
      if (politeTimerRef.current) clearTimeout(politeTimerRef.current);
      if (assertiveTimerRef.current) clearTimeout(assertiveTimerRef.current);
    },
    [],
  );

  const value = useMemo(() => ({ optimised: !!optimised, announce }), [
    optimised,
    announce,
  ]);

  return (
    <ScreenReaderContext.Provider value={value}>
      {children}
      {optimised && <ToastAnnouncerBridge announce={announce} />}
      <div
        aria-live="polite"
        aria-atomic="true"
        role="status"
        className="sr-only"
        data-testid="sr-live-polite"
      >
        {politeMessage}
      </div>
      <div
        aria-live="assertive"
        aria-atomic="true"
        role="alert"
        className="sr-only"
        data-testid="sr-live-assertive"
      >
        {assertiveMessage}
      </div>
    </ScreenReaderContext.Provider>
  );
}

function ToastAnnouncerBridge({ announce }) {
  const { toasts } = useToast();
  const seenRef = useRef(new Set());
  useEffect(() => {
    if (!Array.isArray(toasts)) return;
    for (const t of toasts) {
      if (!t || !t.id || seenRef.current.has(t.id)) continue;
      seenRef.current.add(t.id);
      const parts = [];
      if (t.title) parts.push(typeof t.title === "string" ? t.title : "");
      if (t.description) parts.push(typeof t.description === "string" ? t.description : "");
      const text = parts.filter(Boolean).join(". ").trim();
      if (text) {
        announce(text, t.variant === "destructive" ? "assertive" : "polite");
      }
    }
    if (seenRef.current.size > 50) {
      const ids = new Set(toasts.map((t) => t.id));
      seenRef.current = new Set([...seenRef.current].filter((id) => ids.has(id)));
    }
  }, [toasts, announce]);
  return null;
}

export default ScreenReaderContext;
