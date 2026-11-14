import React, { useEffect, useRef, useState } from "react";
import { popupTargetRequest } from "@shared/popupPortalTargets.js";
import { useLocation } from "react-router-dom";
import { useCookieConsent } from "@/hooks/useCookieConsent";
import { getTenantSlugFromLocation } from "@/api/publicClient";
import { popupRequest } from "@/lib/cmsPopups";
import { consumePopupView, frequencyAllows, mergePopupPreferenceState, popupDurableStorageAllowed, popupHistoryView, popupStorageKey, rankPopupCandidates, releasePopupHistoryView, triggerReady } from "@/lib/popupRuntimeState";
import { boundedPopupRequest } from "@/lib/popupRuntimeRequests";
import { popupExternalInterferenceActive, popupExternalInterferenceReason } from "@/lib/popupInterference";
import { popupDiagnostic, nextPopupDiagnosticId, popupFailureReason } from "@/lib/popupDiagnostics";
import { readPopupDiscovery } from "@/lib/popupDiscovery";
import PopupModal from "./PopupModal";
import { Button } from "@/components/ui/button";

const memory = new Map();
const requestPopup = (query, options) => boundedPopupRequest(popupRequest, query, options);
const read = (storage, key) => {
  try { return JSON.parse(window[storage].getItem(key) || "null"); } catch { return null; }
};
function criticalFlowReason() {
  if (document.visibilityState !== "visible") return "tab_hidden";
  const external = popupExternalInterferenceReason();
  if (external) return external;
  const element = document.activeElement;
  return element?.matches('input,textarea,select,[contenteditable="true"]') && !element.closest("[data-cms-popup-modal]") ? "editing_field" : null;
}

// Mounted by CMS and homepage renderers after page, session and access gates.
// 30s refresh plus two sequential 10s request deadlines bounds open revocation
// checks to 50s in an active tab. Suspended background timers remain a browser limit.
export default function PopupRuntime({ page, viewerIdentity, initialDiscovery = null }) {
  const location = useLocation();
  const consent = useCookieConsent();
  const consentRef = useRef(consent);
  consentRef.current = consent;
  let tenant = window.location.host;
  try { tenant = getTenantSlugFromLocation() || tenant; } catch { /* Storage-denied browsers use the host. */ }
  const view = popupHistoryView(location.key, location.pathname);
  const [opened, setOpened] = useState(null);
  const [preferenceError, setPreferenceError] = useState("");
  const pendingWrite = useRef(null);
  const viewScope = `${tenant}|${page.id}|${page.microsite_id || ""}`;
  const runtimeScope = `${tenant}|${page.id}|${page.microsite_id || ""}|${viewerIdentity}`;
  const scopeRef = useRef(runtimeScope);
  scopeRef.current = runtimeScope;
  const openedRef = useRef(null);
  const tokenRef = useRef(0);
  const restoreFocusOnClose = useRef(true);
  const dismiss = () => {
    if (openedRef.current) popupDiagnostic("popup_dismissed");
    openedRef.current = null; setOpened(null); setPreferenceError(""); pendingWrite.current = null;
  };
  useEffect(() => {
    const instance = nextPopupDiagnosticId();
    const trace = (event, details = {}) => popupDiagnostic(event, { instance, ...details });
    let previousWait = null;
    const wait = reason => {
      if (reason !== previousWait) trace("waiting", { reason });
      previousWait = reason;
    };
    trace("runtime_mounted");
    const token = ++tokenRef.current;
    const controller = new AbortController();
    let candidates = [];
    let context = null;
    let requesting = false;
    let selecting = false;
    let discovery = initialDiscovery;
    const alive = () => !controller.signal.aborted && token === tokenRef.current && scopeRef.current === runtimeScope;
    const viewerMatches = (data) => data?.viewer_key === viewerIdentity
      && (viewerIdentity === "guest" || /^(member|account):.+/.test(viewerIdentity));
    const query = new URLSearchParams(popupTargetRequest(page)).toString();
    dismiss();
    const stateFor = (popup) => {
      const key = popupStorageKey(context.tenant_id, context.viewer_key, popup);
      const durable = popupDurableStorageAllowed(consentRef.current) ? read("localStorage", key) : null;
      const session = read("sessionStorage", key);
      return { key, ...mergePopupPreferenceState(durable, session, memory.get(key)) };
    };
    const writePreference = async (popup, action) => {
      const write = { ...popupTargetRequest(page), id: popup.id, revision: popup.revision, generation: popup.dismissal_generation, action,
        ...(action === "shown" ? { shown_at: new Date().toISOString() } : {}) };
      pendingWrite.current = write;
      try {
        await requestPopup("", { publicRequest: true, signal: controller.signal, method: "POST", body: JSON.stringify(write) });
        if (alive()) { pendingWrite.current = null; setPreferenceError(""); }
        return true;
      } catch {
        if (alive()) setPreferenceError("Your preference could not be saved. Please retry.");
        return false;
      }
    };
    const markShown = (popup) => {
      const previous = stateFor(popup);
      const { key } = previous;
      const next = { permanent: previous.permanent, session: previous.session, last: new Date().toISOString() };
      memory.set(key, next);
      try { window.sessionStorage.setItem(key, JSON.stringify(next)); } catch { /* per-tab memory fallback */ }
      if (popupDurableStorageAllowed(consentRef.current)) {
        // Never spread a session record into durable storage.
        const durable = { permanent: previous.permanent };
        if (popup.config?.frequency?.type !== "session") durable.last = next.last;
        try { window.localStorage.setItem(key, JSON.stringify(durable)); } catch { /* never claim durable success */ }
      }
      if (viewerIdentity.startsWith("member:")) void writePreference(popup, "shown");
    };
    const localReason = (candidate) => {
      if (candidate.ends_at && Date.parse(candidate.ends_at) <= Date.now()) return "popup_expired";
      const state = stateFor(candidate);
      if (state.permanent) return "permanently_dismissed";
      if (state.session) return "session_dismissed";
      // Browser-session means this tab's browser-session storage, not all prior
      // member impressions. Other frequencies also use server last-shown state.
      const last = candidate.config?.frequency?.type === "session" ? state.sessionLast : state.last || candidate.last_shown_at;
      return frequencyAllows(candidate.config?.frequency, last, Date.now(), context.timezone) ? null : "frequency_limit";
    };
    const eligibleLocally = candidate => !localReason(candidate);
    const select = async () => {
      if (!alive()) return;
      const blocked = !context ? "awaiting_eligibility" : !viewerMatches(context) ? "viewer_changed"
        : selecting ? "content_loading" : requesting ? "eligibility_loading"
          : openedRef.current ? "popup_open" : view.consumed.has(viewScope) ? "visit_already_used"
            : !consentRef.current.isLoaded ? "consent_loading" : consentRef.current.isPending ? "consent_pending" : criticalFlowReason();
      if (blocked) { wait(blocked); return; }
      const evaluated = candidates.map(candidate => ({ candidate, reason: localReason(candidate) }));
      const eligible = evaluated.filter(item => !item.reason).map(item => item.candidate);
      const ready = rankPopupCandidates(eligible.filter(candidate =>
        triggerReady(candidate.config?.trigger, Date.now() - view.enteredAt, window.scrollY, document.documentElement.scrollHeight, window.innerHeight)));
      const candidate = ready[0];
      if (!candidate) {
        wait(!candidates.length ? "no_candidates" : !eligible.length ? evaluated[0].reason : "trigger_not_ready");
        return;
      }
      previousWait = null;
      trace("selection_started", { candidateCount: candidates.length, eligibleCount: eligible.length });
      selecting = true;
      try {
        const result = await requestPopup(`${query}&id=${encodeURIComponent(candidate.id)}&revision=${candidate.revision}`, { publicRequest: true, signal: controller.signal });
        if (!alive()) { trace("content_discarded", { reason: "runtime_changed" }); return; }
        if (!result.popup || !viewerMatches(result) || result.viewer_key !== context.viewer_key || result.tenant_id !== context.tenant_id) {
          trace("content_discarded", { reason: "authorization_changed" });
          candidates = []; context = null; return;
        }
        const deferred = criticalFlowReason() || (consentRef.current.isPending ? "consent_pending" : view.consumed.has(viewScope) ? "visit_already_used" : null);
        if (deferred) { trace("content_discarded", { reason: deferred }); return; }
        if (!eligibleLocally(result.popup)) { trace("content_discarded", { reason: localReason(result.popup) }); candidates = candidates.filter((item) => item.id !== candidate.id); return; }
        const popup = { ...candidate, ...result.popup, microsite_id: page.microsite_id || null };
        restoreFocusOnClose.current = true;
        consumePopupView(view, viewScope);
        openedRef.current = { popup, context, runtimeScope };
        setOpened(openedRef.current);
        trace("popup_opened");
        markShown(popup);
      } catch (error) {
        trace("selection_failed", { reason: popupFailureReason(error), status: error?.status });
        // One failed authorization per candidate per batch, not a 500ms retry loop.
        candidates = candidates.filter((item) => item.id !== candidate.id);
      }
      finally { selecting = false; }
    };
    const refresh = async (cause = "initial") => {
      if (requesting) return;
      trace("eligibility_refresh", { cause });
      requesting = true;
      try {
        const revalidating = !!openedRef.current;
        const firstDiscovery = discovery;
        discovery = null;
        const prefetched = !revalidating ? await readPopupDiscovery(firstDiscovery, page, viewerIdentity) : null;
        if (!alive()) return;
        const data = prefetched || await requestPopup(`${query}${revalidating ? "&revalidate=1" : ""}`, { publicRequest: true, signal: controller.signal });
        if (!alive()) return;
        if (!viewerMatches(data) || !data.tenant_id || (context && (context.viewer_key !== data.viewer_key || context.tenant_id !== data.tenant_id))) {
          trace("eligibility_rejected", { reason: "authorization_changed" });
          dismiss(); candidates = []; context = null; return;
        }
        context = data;
        candidates = data.candidates || [];
        trace("eligibility_received", { candidateCount: candidates.length });
        const active = openedRef.current?.popup;
        if (active) {
          const current = candidates.find((candidate) => candidate.id === active.id && candidate.dismissal_generation === active.dismissal_generation);
          if (!current) { trace("popup_closed", { reason: "no_longer_eligible" }); dismiss(); }
          else {
            const authorized = await requestPopup(`${query}&revalidate=1&id=${encodeURIComponent(current.id)}&revision=${current.revision}`, { publicRequest: true, signal: controller.signal });
            if (alive() && (!authorized.popup || !viewerMatches(authorized) || authorized.viewer_key !== context.viewer_key || authorized.tenant_id !== context.tenant_id)) { trace("popup_closed", { reason: "authorization_changed" }); dismiss(); }
            else if (alive() && openedRef.current?.popup.id === active.id) {
              const next = { ...openedRef.current, popup: { ...active, ends_at: current.ends_at, revision: current.revision } };
              openedRef.current = next;
              setOpened(next);
            }
            // Keep the mounted Canvas snapshot, focus and interactive state.
          }
        }
      } catch (error) { trace("eligibility_failed", { reason: popupFailureReason(error), status: error?.status }); if (alive()) { candidates = []; dismiss(); } }
      finally { requesting = false; if (alive()) void select(); }
    };
    const tick = () => {
      const active = openedRef.current?.popup;
      if (active && consentRef.current.isPending) { trace("popup_closed", { reason: "consent_pending" }); dismiss(); }
      if (active?.ends_at && Date.parse(active.ends_at) <= Date.now()) { trace("popup_closed", { reason: "popup_expired" }); dismiss(); }
      void select();
    };
    const yieldToExternalFlow = () => {
      if (!alive() || !openedRef.current || !popupExternalInterferenceActive()) return;
      trace("popup_closed", { reason: popupExternalInterferenceReason() });
      restoreFocusOnClose.current = false;
      dismiss();
    };
    // Other modals may open after ours (inbox, newsletter, consent, etc.).
    // Observe their actual DOM appearance, not the 30s eligibility refresh.
    // Ignore our own subtree so Canvas dialogs/loading/forms cannot self-dismiss.
    const interference = new MutationObserver((records) => {
      if (records.every((record) => record.target.nodeType === 1 && record.target.closest("[data-cms-popup-modal]"))) return;
      yieldToExternalFlow();
    });
    interference.observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ["role", "aria-busy", "data-popup-critical-flow", "data-payment-active", "data-booking-active",
        "data-testid", "src", "data-submitting", "disabled", "hidden", "open", "class", "style"],
    });
    void refresh();
    const periodicRefresh = () => refresh("interval");
    const focusRefresh = () => refresh("focus");
    const visibilityRefresh = () => refresh("visibility");
    const freshness = setInterval(periodicRefresh, 30000);
    const triggerTimer = setInterval(tick, 500);
    window.addEventListener("focus", focusRefresh);
    document.addEventListener("visibilitychange", visibilityRefresh);
    return () => {
      controller.abort(); ++tokenRef.current;
      trace("runtime_unmounted");
      interference.disconnect();
      clearInterval(freshness); clearInterval(triggerTimer);
      window.removeEventListener("focus", focusRefresh);
      document.removeEventListener("visibilitychange", visibilityRefresh);
      openedRef.current = null;
      releasePopupHistoryView(view);
    };
  }, [runtimeScope, view]);
  const suppress = async (kind) => {
    if (!opened || opened.runtimeScope !== runtimeScope) return;
    const token = tokenRef.current;
    const { popup, context } = opened;
    const key = popupStorageKey(context.tenant_id, context.viewer_key, popup);
    if (kind === "session") {
      const next = { ...memory.get(key), session: true };
      memory.set(key, next);
      try { window.sessionStorage.setItem(key, JSON.stringify(next)); } catch { /* memory fallback */ }
      dismiss(); return;
    }
    if (viewerIdentity.startsWith("member:")) {
      const body = { ...popupTargetRequest(page), id: popup.id, revision: popup.revision, generation: popup.dismissal_generation, action: "permanent" };
      pendingWrite.current = body;
      try {
        await requestPopup("", { publicRequest: true, method: "POST", body: JSON.stringify(body) });
      } catch { if (token === tokenRef.current && scopeRef.current === runtimeScope) setPreferenceError("Your permanent preference was not saved. Retry or close for this view."); return; }
    } else {
      if (!popupDurableStorageAllowed(consent)) { setPreferenceError("Permanent dismissal needs storage consent. You can still close or hide for this session."); return; }
      try { window.localStorage.setItem(key, JSON.stringify({ permanent: true })); }
      catch { setPreferenceError("Browser storage is unavailable. Permanent dismissal was not saved."); return; }
    }
    if (token !== tokenRef.current || scopeRef.current !== runtimeScope) return;
    memory.set(key, { ...memory.get(key), permanent: true });
    dismiss();
  };
  if (!opened || opened.runtimeScope !== runtimeScope) return null;
  return <PopupModal popup={opened.popup} open onClose={dismiss} restoreFocusOnCloseRef={restoreFocusOnClose}>
    <div className="mt-4 flex flex-wrap gap-2">
      {opened.popup.config?.allow_session && <Button variant="outline" size="sm" onClick={() => suppress("session")}>Hide for this session</Button>}
      {opened.popup.config?.allow_permanent && <Button variant="outline" size="sm" onClick={() => suppress("permanent")}>Don't show again</Button>}
    </div>
    {preferenceError && <div role="alert" className="mt-3 text-sm text-destructive">{preferenceError}
      <Button variant="outline" size="sm" className="ml-2" onClick={async () => {
        if (pendingWrite.current?.action === "permanent") return suppress("permanent");
        const token = tokenRef.current;
        try {
          if (pendingWrite.current) await requestPopup("", { publicRequest: true, method: "POST", body: JSON.stringify(pendingWrite.current) });
          if (token !== tokenRef.current || scopeRef.current !== runtimeScope) return;
          pendingWrite.current = null; setPreferenceError("");
        } catch { if (token === tokenRef.current && scopeRef.current === runtimeScope) setPreferenceError("Still unable to save. Please retry."); }
      }}>Retry</Button></div>}
    <p className="mt-3 text-xs text-muted-foreground">Session choices apply to this browser tab.</p>
  </PopupModal>;
}
