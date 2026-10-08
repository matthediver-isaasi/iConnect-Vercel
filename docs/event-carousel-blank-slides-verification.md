# Blank Event Carousel: diagnosis and verification

## Diagnosis (2026-10-08)

Read-only investigation of `https://www.bnms.org.uk/bnms-home` (which canonicalizes
to `/`) reproduced the reported blank card in Linux headless Chromium 125.
The saved block has three events, a 1200×392 desktop frame, fill image fit,
left artwork, arrows and indicators enabled, and autoplay disabled.
No saved page or database record was changed.

This was **not** a slide-track, missing-event, or bitmap-painting defect:

- Before failure, the root measured 1198×390 inside its border; image 599×390,
  title 551×56, and CTA 118×20. Artwork decoded successfully.
- After failure, the entire carousel root was replaced by `skeleton-list`.
  Title and CTA disappeared with the artwork; they were not hidden by a transform.
- `/api/bookmarks` and `/api/bookmarks/enriched` repeatedly returned 401.
  One observed seven-second period produced 15 `viewer-session-rejected` events.
  That handler clears React Query, causing repeated `/api/public/events` loads.
- Public Resource List cards mount bookmark controls even for guests.
  The bookmark hook previously started both member-only queries unconditionally.
- A browser-only diagnostic interception returning empty bookmark responses
  stopped the cycle: all three actual live events remained visible across seven
  successive states, including two complete wraps. This was a diagnostic
  interception, **not a production fix or an unmodified-live passing result**.
- The served `/assets/index-Bk0UvSwx.js` contains the old bookmark hook with
  neither query guarded by `enabled`. Source and deployed failure agree.

## Correction

Require resolved, validated member identity before bookmark queries or controls
activate. Do not manually refetch the drawer until that condition holds.
Guest toggle attempts fail explicitly. Session rejection and cache clearing
remain unchanged, preserving logout/security behavior.

No carousel renderer, layout, selected-event filtering, image fit, clipping,
ResizeObserver, other carousel type, or authored design was modified. The
mount-only ResizeObserver weakness was not implicated in this incident.

## Automated evidence

Run against the development workflow:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$(command -v chromium) \
  npx playwright test --config=playwright.event-carousel-image-fit.config.mjs
```

The fixture exercises the real public page, Canvas renderer, Resource List,
bookmark controls, session rejection, and query cache. API responses are
intercepted; no real data writes or authenticated production actions occur.
Coverage includes:

- Guest auth, 401 bookmark endpoints, delayed initial events, three distinct
  event images, and a neighboring resource card that triggers the original bug.
- Desktop and narrow widths, two complete autoplay cycles and two manual
  cycles, previous/wrap, indicators, keyboard and synthetic swipe events.
- Image decode readiness, title text, exact CTA links and positive clipped
  content geometry, plus screenshots of every checked state.
- Reload with cached browser assets, failed/pending artwork retaining text/CTA,
  existing cover/contain/fill and image-side checks, and editor save/reopen.
- Verified member bookmark-query availability.

Negative control: temporarily re-enabling both bookmark queries unconditionally
made the desktop guest fixture fail waiting for the carousel to become visible.
Restoring the guards made both guest fixtures pass. This reproduces the reload
defect rather than merely asserting the DOM contains slide text.

Screenshots are generated under `/tmp/event-carousel-image-fit-results`.
Desktop third-slide autoplay and narrow portrait-slide manual screenshots were
visually inspected: title, CTA and artwork were painted.

## Verification boundaries

- Linux Chromium verified; **headed macOS Chrome was unavailable**.
- Firefox and WebKit launch attempts failed because their Playwright
  executables are not installed. These engines are not claimed as verified.
- The standalone local `/` screenshot shows “Tenant not found”: the development
  database/hostname does not resolve this tenant. Fixture-backed browser tests
  isolate that environment issue; they do not verify a real signed-in UI.
- The live hostname still served the unguarded bundle when inspected.
  **No production deployment was performed.** Verify macOS Chrome and the
  corrected live bundle after a separately approved deployment.
- No database migrations were needed or applied to any database; none remain.
