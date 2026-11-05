import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, useLocation, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import LayoutContext from "@/contexts/LayoutContext";
import { consentState } from "@/lib/consentState";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import PopupModal from "../PopupModal";
import PopupRuntime from "../PopupRuntime";
import { popupFixtureRecord } from "./popupFixtureData";
import "@/index.css";

const options = window.__POPUP_FIXTURE_OPTIONS__ || {};
const CanvasPopupEditor = React.lazy(() => import("@/pages/CanvasPopupEditor"));
const PopupManagement = React.lazy(() => import("@/pages/PopupManagement"));
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const setConsent = (analytics, pending = false) => consentState.publish({
  ready: true, hasActed: !pending,
  categories: { necessary: true, functional: true, analytics, marketing: false },
});
setConsent(options.consent !== "denied", options.consent === "pending");
window.__TENANT_TYPOGRAPHY_STYLES__ = [];
// Apply denial after shared application's module bootstrap, but before popup
// mounting. This fixture tests popup storage fallbacks, not unrelated auth boot.
if (options.denyStorage) {
  for (const name of ["localStorage", "sessionStorage"]) Object.defineProperty(window, name, {
    configurable: true, get() { throw new DOMException("Fixture storage denied", "SecurityError"); },
  });
}

function Fixture() {
  const navigate = useNavigate();
  const location = useLocation();
  const defaults = React.useContext(LayoutContext);
  const [open, setOpen] = useState(false);
  const [popup, setPopup] = useState(() => popupFixtureRecord(options));
  const [submitting, setSubmitting] = useState(false);
  const [externalDialog, setExternalDialog] = useState(null);
  useEffect(() => {
    window.popupFixture = {
      navigate, consent: setConsent, setPopup, setSubmitting, openDialog: setExternalDialog,
      ready: true,
    };
    if (options.focusOrigin) document.getElementById("outside-focus")?.focus();
    return () => { delete window.popupFixture; };
  }, [navigate]);
  return <LayoutContext.Provider value={{ ...defaults, memberInfo: null, authResolved: true, sessionValidated: false }}>
    <main className={options.mode === "authoring" ? "" : "p-6"} style={{ minHeight: options.mode === "authoring" ? undefined : 2600 }} data-fixture-ready>
      <h1>Isolated CMS popup browser fixture</h1>
      <button id="open-popup" className="m-4 rounded border p-3" onClick={() => setOpen(true)}>Open preview</button>
      <button id="outside-focus" className="rounded border p-3">Outside focus target</button>
      <nav className="flex gap-4"><button onClick={() => navigate("/__cms-popup-fixture/a")}>Page A</button><button onClick={() => navigate("/__cms-popup-fixture/b")}>Page B</button><button onClick={() => navigate(`${location.pathname}?filter=recent`)}>Query only</button></nav>
      {options.mode === "authoring" && <nav><button onClick={() => navigate(`/CanvasPopupEditor?popupId=${popup.id}`)}>Launch editor</button><button onClick={() => navigate("/PopupManagement")}>Launch management</button></nav>}
      <div id="fixture-action">Canvas link destination</div>
      {submitting && <div data-popup-critical-flow>Critical form submission</div>}
      {options.mode === "authoring"
        ? <React.Suspense fallback={<div aria-label="Loading authoring fixture" />}>
          {location.pathname === "/CanvasPopupEditor" ? <CanvasPopupEditor /> : location.pathname === "/PopupManagement" ? <PopupManagement /> : null}
        </React.Suspense>
        : options.mode === "runtime"
        ? <PopupRuntime page={{ id: location.pathname.endsWith("/b") ? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" : "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", microsite_id: null }} viewerIdentity="guest" />
        : open && <PopupModal popup={popup} open preview onClose={() => setOpen(false)} />}
      <Dialog open={!!externalDialog} onOpenChange={(next) => { if (!next) setExternalDialog(null); }}>
        <DialogContent data-testid={`competing-${externalDialog}`}>
          <DialogHeader><DialogTitle>{externalDialog === "inbox" ? "Inbox messages" : "Newsletter signup"}</DialogTitle>
            <DialogDescription>A late-opening application dialog.</DialogDescription></DialogHeader>
          <input className="rounded border p-2" aria-label={externalDialog === "inbox" ? "Inbox search" : "Newsletter email"}
            type={externalDialog === "inbox" ? "search" : "email"} />
          <button onClick={() => setExternalDialog(null)}>Close {externalDialog}</button>
        </DialogContent>
      </Dialog>
    </main>
  </LayoutContext.Provider>;
}

createRoot(document.getElementById("root")).render(
  <BrowserRouter><QueryClientProvider client={queryClient}><Fixture /></QueryClientProvider></BrowserRouter>,
);
