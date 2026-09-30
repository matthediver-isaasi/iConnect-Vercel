---
name: Canvas editor unsaved-changes navigation guard
description: How the Canvas builder blocks navigation while dirty, and why useBlocker can't be used
---

# Canvas editor unsaved-changes guard

The Canvas builder is manual-save only: edits stay in local `design` state and
are never persisted automatically (the old debounced autosave was removed). The
live page keeps the last saved design until the author presses Save. A one-time
initial persist still fires for a brand-new page with no `canvas_design` blob so
it doesn't render as perpetually dirty.

**Why `useBlocker`/`unstable_usePrompt` are NOT used:** the app mounts
`<BrowserRouter>` (a *non-data* router) in `client/src/pages/index.jsx`. React
Router v7's blocker/prompt APIs only work with a data router
(`createBrowserRouter`). Do not migrate the whole app router just to guard one
editor.

**How to apply — three leave paths, guarded by hand while dirty:**
- Tab close / refresh → `beforeunload` listener (native browser prompt only; a
  hard browser limitation, cannot be a custom modal).
- Browser Back (POP) → push a history sentinel while dirty; on `popstate`
  re-push the sentinel to cancel the back, then open the custom modal.
- In-app nav (header back button, command-palette page jumps) → route through a
  `guardedNavigate(to)` helper that opens the modal when dirty.

The custom modal (shadcn AlertDialog) offers Save & leave / Leave without
saving / Cancel. "Save & leave" runs the manual-save routine then navigates.

**Version snapshot on save:** a manual Save that actually changed the design
POSTs a `source:'saved'` version to `/api/canvas-versions/:pageId`. This is
attached to the manual-save path ONLY (not `saveNow`/`performSave`), because the
publish flow calls `saveNow` directly and emits its own single `source:'publish'`
version — attaching it lower would double-snapshot on publish.

**Do not break `authorEditedRef`:** auto-height baking (`commitAutoHeight`) must
keep deferring until a real author edit, so merely opening a page never mutates
`design`, marks it dirty, or trips the nav guard.
