import { useEffect, useRef } from "react";
import { useGoCardlessDropin } from "@gocardless/react-dropin";

// Shared wrapper around the official GoCardless Drop-in widget.
//
// Renders nothing visible itself — mounting it with a `flowId` loads the
// GoCardless script and opens the Drop-in modal overlay. All Direct Debit
// surfaces use this wrapper; no per-page GC SDK code.
//
// Props:
//  - flowId: GoCardless Billing Request Flow ID (BRF...), created server-side
//  - environment: 'sandbox' | 'live' (from the tenant's credentials)
//  - onSuccess(billingRequest, billingRequestFlow): payer completed the modal.
//    Show the pending/"mandate being confirmed" UX — actual activation still
//    comes only from the verified webhook path.
//  - onExit(error, metadata): payer closed/abandoned the modal (or an
//    unrecoverable in-modal error occurred). Show a "no Direct Debit was set
//    up" message with the ability to retry.
//  - onLoadFailure(error): the Drop-in script failed to load or never became
//    ready (blocked script, unsupported environment). Callers should fall
//    back to the hosted redirect (authorisationUrl).
//
// Usage: render <GoCardlessDropinFlow .../> conditionally; unmount it (clear
// the flowId state) after any callback fires so a retry can remount cleanly.

const LOAD_TIMEOUT_MS = 15000;

function DropinInner({ flowId, environment, onSuccess, onExit, onLoadFailure }) {
  const openedRef = useRef(false);
  const failedRef = useRef(false);

  const { open, ready, error } = useGoCardlessDropin({
    billingRequestFlowID: flowId,
    environment: environment === "live" ? "live" : "sandbox",
    onSuccess: (billingRequest, billingRequestFlow) => {
      onSuccess?.(billingRequest, billingRequestFlow);
    },
    onExit: (err, metadata) => {
      onExit?.(err || null, metadata || {});
    },
  });

  // Auto-open once the script is ready.
  useEffect(() => {
    if (ready && !openedRef.current && !failedRef.current) {
      openedRef.current = true;
      try {
        open();
      } catch (e) {
        failedRef.current = true;
        onLoadFailure?.(e);
      }
    }
  }, [ready, open, onLoadFailure]);

  // Script load failure (blocked, offline, unsupported environment).
  useEffect(() => {
    if (error && !openedRef.current && !failedRef.current) {
      failedRef.current = true;
      onLoadFailure?.(error);
    }
  }, [error, onLoadFailure]);

  // Never-ready backstop: if the script hangs without erroring, fall back.
  useEffect(() => {
    const t = setTimeout(() => {
      if (!openedRef.current && !failedRef.current) {
        failedRef.current = true;
        onLoadFailure?.(new Error("GoCardless Drop-in did not load in time"));
      }
    }, LOAD_TIMEOUT_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

export default function GoCardlessDropinFlow(props) {
  if (!props.flowId) return null;
  // Key on the flow ID so a retry with a fresh flow remounts cleanly.
  return <DropinInner key={props.flowId} {...props} />;
}
