---
name: Testing mode boundaries
description: Why fixture isolation and deliberate production checks must remain separate, and workflow registration can undo startup separation.
---

Retain meaningful, explicitly invoked production read-only checks; do not
interpret regression isolation as a blanket ban on production verification.

**Why:** The user explicitly distinguished fake-fixture regressions from checks
against real scoped production data. A mocked database parameter did not
isolate transitive helpers using independent module-level clients. Credential
presence must never be interpreted as permission for live effects.

**How to apply:** Use controlled dependencies plus a fail-closed transport
boundary for fixtures, disposable databases for SQL mutation tests, and
separately authorized, destination-verified read-only checks for production.
Keep limitations explicit; a local fix does not identify activity in other
workspaces or establish historical impact.

After changing workflow or validation registrations, recheck the default
Project workflow rather than assuming its child list remains unchanged.

**Why:** Registration tools can add validation workflows back into the parent
run-button workflow. Editing the child command alone does not establish that
clicking Run starts only the application.

**How to apply:** Assert the final parent graph after registration changes.
Use the platform's schema-validated replacement flow for `.replit` rather
than direct edits, which this environment rejects.

For local Playwright runs on Nix, prefer an available Nix Chromium executable
when the downloaded browser cannot load system libraries.

**Why:** The downloaded Chromium failed on missing `libglib-2.0.so.0`, while
the existing Nix Chromium ran the same isolated tests successfully.

**How to apply:** Discover the installed executable and supply Playwright's
`executablePath`; do not assume a pinned store path persists between sessions.
Confirm test discovery too: an explicit spec argument still respects config
`testMatch`, so excluded specs need a narrowly scoped config.