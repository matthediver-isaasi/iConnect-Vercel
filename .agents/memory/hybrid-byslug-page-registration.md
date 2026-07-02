---
name: Hybrid public/by-slug page registration
description: The set of places a new /thing/:slug page must be registered to render with public chrome and hybrid auth.
---

A new hybrid page reachable at a clean `/<prefix>/:slug` URL (renders for both
anonymous visitors in public tenant chrome AND logged-in members in portal
chrome) must be registered in FOUR coordinated places, or it silently
misbehaves (treated as portal-only, or no chrome, or route 404).

**Where:**
1. `client/src/pages/index.jsx` `_getCurrentPage(url)` — add a parameterized
   prefix check (`urlParts[0] === '<prefix>'` → return the page name) BEFORE
   the `PAGES` last-segment lookup, since `:slug` is the last segment.
2. `client/src/pages/index.jsx` — `import` the page, register
   `<Route path="/<prefix>/:slug" element={<Page />} />`, and add it to the
   `PAGES` map.
3. `client/src/pages/Layout.jsx` `hybridPages` array — add the page name, or
   `isPublicPage()` won't treat it as hybrid and anonymous visitors get the
   wrong chrome / forced auth.

**Why:** routing page-name resolution and the public-vs-portal chrome decision
are two separate systems keyed on the same page name; missing either makes the
page render but with wrong auth/chrome.

**How to apply:** mirror `ArticleView` / `EventDetails` which already do all
four. Read auth state in the page via `useLayoutContext()` (`authResolved` to
gate queries, `sessionValidated` + `useMemberAccess().memberInfo` for
`isAuthenticated`). Anonymous + private content → redirect to
`/login?returnTo=<path>` (Login.jsx consumes `returnTo`).
