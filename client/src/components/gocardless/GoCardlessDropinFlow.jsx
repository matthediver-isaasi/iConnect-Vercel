import React, { useEffect, useRef } from "react";
import {
  createGoCardlessDropinLifecycle,
  GOCARDLESS_DROPIN_LOAD_TIMEOUT_MS,
  scheduleGoCardlessDropinLoadTimeout,
} from "./goCardlessDropinLifecycle";
import { subscribeGoCardlessDropin } from "./goCardlessDropinLoader";

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

function DropinInner({
  flowId,
  environment,
  onSuccess,
  onExit,
  onLoadFailure,
  loadTimeoutMs = GOCARDLESS_DROPIN_LOAD_TIMEOUT_MS,
}) {
  const lifecycleRef = useRef(null);
  if (!lifecycleRef.current) {
    lifecycleRef.current = createGoCardlessDropinLifecycle();
  }
  const lifecycle = lifecycleRef.current;
  lifecycle.updateCallbacks({ onSuccess, onExit, onLoadFailure });

  // Keep creation and cleanup in one effect. The official React hook stores
  // handlers in state; StrictMode can replay its creation effect twice before
  // that state commits, leaving the first handler unreachable for cleanup.
  useEffect(() => {
    let cancelled = false;
    let handler = null;
    let cancelLoad = () => {};
    lifecycle.activate();
    const clearLoadTimeout = scheduleGoCardlessDropinLoadTimeout(
      lifecycle,
      () => handler?.exit,
      setTimeout,
      clearTimeout,
      () => cancelLoad(),
      loadTimeoutMs,
    );

    cancelLoad = subscribeGoCardlessDropin({
      onLoad: (dropin) => {
        if (cancelled) return;
        try {
          handler = dropin.create({
            billingRequestFlowID: flowId,
            environment: environment === "live" ? "live" : "sandbox",
            onSuccess: (billingRequest, billingRequestFlow) => {
              lifecycle.succeed(billingRequest, billingRequestFlow);
            },
            onExit: (err, metadata) => {
              lifecycle.userExit(err, metadata);
            },
          });
        } catch (error) {
          lifecycle.fail(error, handler?.exit);
          return;
        }
        if (cancelled) {
          lifecycle.dispose(handler.exit);
          return;
        }
        lifecycle.open(handler.open, handler.exit);
      },
      onError: (error) => {
        if (!cancelled) lifecycle.fail(error, handler?.exit);
      },
    });

    return () => {
      cancelled = true;
      clearLoadTimeout();
      cancelLoad();
      lifecycle.dispose(handler?.exit);
    };
  }, [environment, flowId, lifecycle, loadTimeoutMs]);

  return null;
}

export default function GoCardlessDropinFlow(props) {
  if (!props.flowId) return null;
  const environment = props.environment === "live" ? "live" : "sandbox";
  // Flow and environment replacements get a fresh terminal-state lifecycle.
  return <DropinInner key={`${props.flowId}:${environment}`} {...props} environment={environment} />;
}
