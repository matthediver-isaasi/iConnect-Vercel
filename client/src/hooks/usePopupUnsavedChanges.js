import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { UNSAFE_NavigationContext } from "react-router-dom";

// BrowserRouter (not a data router) cannot use useBlocker. Like CanvasPageEditor
// we retain the mounted editor and offer save/discard/stay. Unlike a history
// sentinel, index-based POP restoration also handles Forward without adding
// phantom entries or committing a cancelled route/remounting its design.
export function usePopupUnsavedChanges({ dirty, isDirty, onSave }) {
  const { navigator } = useContext(UNSAFE_NavigationContext);
  const latest = useRef({});
  latest.current = { dirty, isDirty, onSave };
  const leaving = useRef(false);
  const pendingRef = useRef(null);
  const [pending, setPending] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const checkDirty = useCallback(() => !leaving.current && (latest.current.isDirty?.() || latest.current.dirty), []);
  const request = useCallback((run) => {
    if (!checkDirty()) { run(); return; }
    if (pendingRef.current) return;
    pendingRef.current = run;
    setPending(true);
    setError("");
  }, [checkDirty]);

  useEffect(() => {
    let index = window.history.state?.idx ?? 0;
    let currentLocation = navigator.location;
    let restoring = false;
    let resumePop = false;
    let restoredAction = null;
    const original = { push: navigator.push, replace: navigator.replace, go: navigator.go };
    const retainCurrentRoute = () => {
      const destinationState = window.history.state;
      const destinationUrl = window.location.href;
      original.replace.call(navigator, currentLocation, currentLocation.state);
      window.history.replaceState(destinationState, "", destinationUrl);
    };
    const wrappers = {};
    for (const method of ["push", "replace", "go"]) {
      wrappers[method] = (...args) => request(() => {
        if (method === "go") resumePop = true;
        original[method].apply(navigator, args);
        if (method !== "go") {
          index = window.history.state?.idx ?? index;
          currentLocation = navigator.location;
        }
      });
      navigator[method] = wrappers[method];
    }
    const beforeUnload = (event) => {
      if (!checkDirty()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const pop = (event) => {
      const nextIndex = event.state?.idx;
      if (restoring) {
        event.stopImmediatePropagation();
        retainCurrentRoute();
        // Coalesce rapid repeated Back/Forward presses while an undo traversal
        // is in flight. Never mistake an intermediate POP for restoration.
        if (Number.isInteger(nextIndex) && nextIndex !== index) {
          window.history.go(index - nextIndex);
          return;
        }
        restoring = false;
        const run = restoredAction;
        restoredAction = null;
        if (run) request(run);
        return;
      }
      if (resumePop || !checkDirty()) {
        resumePop = false;
        index = nextIndex ?? index;
        currentLocation = navigator.location;
        return;
      }
      if (!Number.isInteger(nextIndex) || nextIndex === index) return;
      event.stopImmediatePropagation();
      const delta = nextIndex - index;
      // Window-target POP listeners may run in registration order even with a
      // capture listener. React Router may already have queued the destination.
      // Synchronously replace that queued notification with the *same* current
      // location/key before React commits it. Restore the traversed entry's
      // native state/URL immediately, so neither history entry is rewritten.
      retainCurrentRoute();
      restoring = true;
      restoredAction = () => {
        resumePop = true;
        original.go.call(navigator, delta);
      };
      // Restore the URL/history position before showing the decision. The
      // router never commits the intermediate route; design/undo state survives.
      window.history.go(-delta);
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("popstate", pop, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("popstate", pop, true);
      for (const method of Object.keys(original)) {
        if (navigator[method] === wrappers[method]) navigator[method] = original[method];
      }
    };
  }, [navigator, request, checkDirty]);

  const stay = () => {
    if (saving) return;
    pendingRef.current = null;
    setPending(null);
    setError("");
  };
  const discard = () => {
    if (saving) return;
    const run = pendingRef.current;
    pendingRef.current = null;
    leaving.current = true;
    setPending(null);
    run?.();
    // A non-navigation action (e.g. close settings) keeps this hook mounted.
    leaving.current = false;
  };
  const saveAndLeave = async () => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      if (await latest.current.onSave?.() !== true) {
        setError("Changes were not saved. Stay here and correct the error, or retry.");
        return;
      }
      const run = pendingRef.current;
      pendingRef.current = null;
      leaving.current = true;
      setPending(null);
      run?.();
      leaving.current = false;
    } catch (failure) {
      setError(failure.message || "Unable to save. Your changes are still here.");
    } finally { setSaving(false); }
  };
  return { pending, request, stay, discard, saveAndLeave, saving, error, canSave: !!onSave };
}
