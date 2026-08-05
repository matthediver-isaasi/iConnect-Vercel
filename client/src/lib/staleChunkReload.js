// Task #3406: app-wide recovery from stale-chunk load failures.
//
// After a deploy, tabs that were open before the deploy still reference old
// content-hashed JS chunks that no longer exist on the server. Any dynamic
// import() (lazy pages, the Lucide catalog, etc.) then rejects. The fix is to
// reload the page ONCE so the tab picks up the fresh build; a sessionStorage
// guard prevents a reload loop when the failure is a genuine network problem
// rather than a stale deploy. If the failure recurs right after a guarded
// reload, a small non-technical overlay asks the user to refresh manually.

const GUARD_KEY = 'stale-chunk-reloaded-at';
// If the last auto-reload happened within this window, don't reload again —
// the failure is persisting, so show the manual-refresh message instead.
// After the window expires the guard resets so a future deploy (much later in
// the same session) can auto-recover again.
const GUARD_WINDOW_MS = 60_000;

// Heuristic match for dynamic-import / chunk load failures across browsers.
// Chrome: "Failed to fetch dynamically imported module: …"
// Firefox: "error loading dynamically imported module"
// Safari: "Importing a module script failed."
// Vite preload helper: "Unable to preload CSS for …"
export function isChunkLoadError(err) {
  if (!err) return false;
  const msg = String(err?.message || err);
  return (
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg) ||
    /Unable to preload CSS/i.test(msg) ||
    /ChunkLoadError/i.test(msg)
  );
}

function readGuard() {
  try {
    const v = sessionStorage.getItem(GUARD_KEY);
    return v ? Number(v) : 0;
  } catch {
    return 0;
  }
}

function writeGuard() {
  try {
    sessionStorage.setItem(GUARD_KEY, String(Date.now()));
  } catch {
    // sessionStorage unavailable (private mode etc.) — fall through; the
    // in-memory flag below still prevents a loop within this page lifetime.
  }
}

let _reloadedThisPageLoad = false;
let _overlayShown = false;

// Renders a plain-DOM overlay (no React — the tree may be broken) asking the
// user to refresh manually. Used when auto-reload already ran and didn't help.
function showManualRefreshOverlay() {
  if (_overlayShown || typeof document === 'undefined') return;
  _overlayShown = true;
  const el = document.createElement('div');
  el.setAttribute('data-testid', 'overlay-stale-chunk');
  el.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,0.55);font-family:system-ui,sans-serif;';
  const card = document.createElement('div');
  card.style.cssText =
    'background:#fff;border-radius:12px;max-width:22rem;margin:1rem;padding:1.5rem;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,0.2);';
  const title = document.createElement('p');
  title.textContent = 'A new version of this app is available';
  title.style.cssText = 'font-weight:600;font-size:1rem;color:#0f172a;margin:0 0 0.5rem;';
  const body = document.createElement('p');
  body.textContent =
    "We couldn't load part of the page — this usually means the app was just updated, or there's a connection problem. Please refresh to continue.";
  body.style.cssText = 'font-size:0.875rem;color:#475569;margin:0 0 1rem;line-height:1.5;';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Refresh now';
  btn.setAttribute('data-testid', 'button-stale-chunk-refresh');
  btn.style.cssText =
    'background:#0f172a;color:#fff;border:none;border-radius:8px;padding:0.5rem 1.25rem;font-size:0.875rem;cursor:pointer;';
  btn.onclick = () => {
    // Clear the guard so the manual refresh gets a clean slate.
    try { sessionStorage.removeItem(GUARD_KEY); } catch {}
    window.location.reload();
  };
  card.append(title, body, btn);
  el.appendChild(card);
  document.body.appendChild(el);
}

// Central recovery entry point. Returns true when the error was recognised as
// a chunk-load failure and recovery (reload or overlay) was triggered — the
// caller can then suppress its own local error UI if it wants.
export function handleStaleChunkError(err) {
  if (err !== undefined && !isChunkLoadError(err)) return false;

  const lastReload = readGuard();
  const withinGuard = lastReload && Date.now() - lastReload < GUARD_WINDOW_MS;

  if (!withinGuard && !_reloadedThisPageLoad) {
    _reloadedThisPageLoad = true; // never reload twice from one page lifetime
    writeGuard();
    window.location.reload();
    return true;
  }

  // Reload already happened recently and the failure persists (stale cache
  // that survives reload, or a genuine network outage) — ask the user.
  showManualRefreshOverlay();
  return true;
}

// Install at app bootstrap: catches Vite's preload failures (lazy routes,
// dynamic imports made through Vite's helper) plus unhandled promise
// rejections that look like chunk-load failures (covers hand-rolled dynamic
// imports that don't catch their own errors).
export function installStaleChunkReload() {
  if (typeof window === 'undefined') return;
  window.addEventListener('vite:preloadError', (event) => {
    // Prevent Vite from re-throwing; we own recovery from here.
    event.preventDefault?.();
    handleStaleChunkError(event?.payload ?? undefined);
  });
  window.addEventListener('unhandledrejection', (event) => {
    if (isChunkLoadError(event?.reason)) {
      event.preventDefault();
      handleStaleChunkError(event.reason);
    }
  });
}
