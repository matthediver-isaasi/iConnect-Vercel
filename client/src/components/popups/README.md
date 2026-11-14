# Built-in portal targeting

Main-site popup settings support explicit `config.portal_pages` canonical keys
from `shared/popupPortalTargets.js`. Legacy records default to no portal targets;
`all_pages` continues to mean CMS pages only. Microsites cannot assign portal
targets. The curated registry intentionally excludes transactional, editor,
administrative and authentication routes; AboutMe/about-me resolve to Preferences.

Delivery uses `portal_page` instead of `page_id`/`page_slug`. Mixed target modes
are rejected. Each discovery, selected-content, revalidation and preference call
independently requires a current tenant member and page capability. Layout only
mounts after verified session, role, visibility and chrome readiness, and never
owns CMS mounts. Existing interference checks and popup/member/generation
preference keys are shared across both surfaces.

# CMS popup frontend

The feature uses the existing CMS visual system, Canvas standalone-document
adapter and Radix modal. It does not create routable CMS pages for popup designs.

## Boundaries

- Management requires `site-builder.popups`; mutations and authorized preview
  require `site-builder.popup-editor`, matching the administration API.
- Runtime mounts only after DynamicPage's published-page and audience gates.
  It never mounts globally, on fallback forms/articles, or in editor previews.
- The shared popup contract controls block availability and document validation.
  Existing page/footer modes remain unchanged.
- The shared condition row serves member/organisation core and custom fields.
  Communications retains its specialized event and custom-object pickers.
  Popup rules never use the communications recipient resolver.
- Main-site/microsite context accompanies page delivery and preference writes.
  Discovery controls which authoritative targeting selectors exist.

## Runtime choices

Candidates are fetched in one batch and ranked only after their trigger is ready.
The chosen document is separately authorized immediately before opening.
The history-entry allowance is consumed on opening, not on fetch/deferral.
Its key is tenant + page + site, not viewer: login/logout cannot earn a second
popup in the same view. Request generations remain separately viewer-fenced.
The first eligibility response and every selected read must match the expected
member/account/guest identity. An account response is never adopted as a guest.
Query-only navigation shares it; back/forward restores it. Session storage retains
the consumed allowance over refresh where storage is available.

Open eligibility and selected authorization are refreshed every **30 seconds**
and on focus/visibility return. Every network request has an aborting **10-second
deadline**, with an independent rejection even if transport ignores abort.
Two sequential checks therefore bound revocation detection to 50 seconds in an
active tab. Background-tab timer suspension remains a browser limitation;
focus/visibility return immediately rechecks. Open refreshes use `revalidate=1`
so a member's own shown event does not invalidate daily frequency. Failures close
the popup; failed selected reads are dropped until the next eligibility batch
rather than retried on the 500ms trigger clock. End times also expire locally.
Ordinary successful revalidation preserves the mounted design and its controls.

Preference keys include tenant, server viewer key, popup and dismissal generation.
Browser-session choices are per tab (`sessionStorage`), with memory fallback.
Session frequency consults only session storage and memory, never durable
timestamps or server impressions from a previous browser session. Durable
records never contain session suppression. A permanent true in any authorized
storage layer wins over false values in another layer.
Anonymous durable storage follows the existing hook's precise analytics policy:
loaded, acted-on consent with analytics enabled (`hasConsented`), not merely
functional cookies or a generic accepted flag. Permanent choices never report success when storage/server writes
fail: failures stay visible with retry. Member permanent choices are server-backed.

Automatic presentation defers for competing dialogs, pending consent, active form
input/submission markers, busy content and embedded registration/payment widgets.
Additional integrations can expose `data-popup-critical-flow`,
`data-payment-active` or `data-booking-active` while a critical flow is active.
While a popup is open, a MutationObserver yields immediately to a later external
dialog or critical-flow marker. Its own dialog descendants are excluded. Yielding
does not restore focus to the old opener or earn another popup in the same view.

Modal breakpoints use measured content width, not the outer viewport. V1 Canvas
geometry is clamped to that width; V2 uses its existing container-width resolver.
The modal keeps close outside the internal scrolling area and restores prior
focus. Preview authorization is server-verified before rendering local edits.

## Unsaved work and editor dimensions

CanvasPopupEditor and PopupManagement share the existing Canvas editor's
save/discard/stay dialog conventions and a native unload warning while dirty.
In-app push/replace/go navigation is guarded, including the settings dialog's
Open Canvas editor action and settings modal close/Escape. Failed saves retain
the pending decision and edits; successful saves resume the requested navigation.

The app uses BrowserRouter, so data-router blockers are unavailable. Native
Back/Forward traversals are restored by history index, preserving the original
location/key before a different route can commit. Cancel keeps the same mounted
Canvas document, DOM, selection and undo history. No sentinel history entries
are added, and clean navigation passes through normally.

The editor's device buttons choose a simulated viewport (the existing Canvas
1200/768/375px widths). Builder stage width and effective layout breakpoint now
use the configured modal width minus its 24px viewport gutter, border and content
padding. Preview uses the same calculation. The chosen device is not falsely
treated as the content breakpoint: e.g. an 800px popup uses tablet content even
on a desktop. Maximum height intentionally applies to the scrolling modal, not
the full-height authoring stage. Optional builder constraints apply only to popup
mode; display-only clamping does not rewrite authored geometry.

## Isolated verification

Run:

    node --test client/src/lib/popupRuntimeState.test.mjs \
      client/src/lib/popupEditorDimensions.test.mjs \
      client/src/components/popups/PopupRuntime.mounted.test.mjs \
      client/src/components/popups/PopupModal.mounted.test.mjs \
      client/src/components/popups/PopupAuthoringAccess.mounted.test.mjs \
      client/src/components/popups/popupConsent.mounted.test.mjs \
      client/src/lib/canvasFooterEditorState.test.mjs

These are pure/JSDOM tests with isolated transport and renderer seams, not
production, migration, or authenticated browser rollout evidence.

## Real browser fixtures

With the existing Vite application running (no server is started by this suite):

    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="$(command -v chromium)" \
      npx playwright test \
      --config=client/src/components/popups/browser/playwright.config.mjs

`PLAYWRIGHT_BASE_URL` overrides the default `http://127.0.0.1:5000`. The Chromium
path can instead use `REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE`, or be omitted for
Playwright's installed browser.

The 22 Playwright tests use the real PopupModal, PopupRuntime, CanvasPopupEditor,
PopupManagement, PopupSettings, CanvasBuilder, Radix, Canvas v1/v2 renderers,
shared styles, browser router, and consent hook. All
API requests are intercepted and external origins are blocked: no live database,
tenant content, preference writes or authentication requests reach a backend.
The fixture harness is imported only from test-intercepted HTML, not an app route.
Authoring fixtures grant capabilities via an isolated access-hook seam; they do
not prove live authentication or role enforcement.

Coverage includes desktop/tablet/mobile plus a narrow dialog in a wide viewport
for both document formats; actual breakpoint-hidden Canvas blocks; internal
overflow and a pinned close action; body scroll locking; forward/backward focus
trapping; Escape and opener focus restoration; delayed/ready priority and stable
ties; no second popup after close; query-only navigation, back/forward restoration
and genuine new navigation; pending/functional-only consent; and unavailable
browser storage with visible permanent-write failure and session-memory fallback.
Authoring tests additionally cover dirty/clean unload event cancellation;
in-app leave, stay, undo/redo preservation, failed save and retry/save-and-leave;
Back and Forward cancellation without remounts or history sentinels; settings
close, editor navigation and history protection; and actual v1/v2 builder versus
preview dimensions with non-default borders/padding and simulated viewport
gutters. A desktop overflow case verifies matching display clamps and no
geometry mutation or implicit save.
Late-opening inbox/newsletter dialog fixtures additionally verify prompt popup
closure, external input focus retained through deferred Radix autofocus, no
attempted focus restoration to the old opener, and no replacement popup.
Storage access is denied after shared module bootstrap but before popup mount;
this checks feature behavior, not unrelated authentication bootstrap resilience.

The browser suite exposed a real v1 renderer defect: desktop CSS could hide
mobile-only blocks in a narrow modal. Content-width rendering now explicitly
overrides the host-window visibility rule, without changing normal page/footer
rendering.

Actual tenant critical-flow integrations, cross-device member preferences,
authenticated route/capability enforcement, migrations and production rollout
still need end-to-end verification. Authoritative discovery fields (including
membership status/type and tenant-defined membership class/organisation
type/category) render through the shared typed field editor; no selectors or
values are invented client-side. DST gaps and ambiguous fall-back times are
rejected with a validation message rather than silently choosing an offset.
