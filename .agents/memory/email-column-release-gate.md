---
name: Email column release gate
description: Received-client approval boundaries for hybrid email columns and isolated MIME transport.
---

Require received Gmail desktop/mobile and classic Outlook checks for changes to
hybrid email columns; browser tests alone do not establish client compatibility.

The user accepted visual received-message results across all column cases on
2026-09-22 and explicitly waived computed-CSS evidence for the initial release.
That was a specific release decision, not permission to skip received checks for
future layout changes. Do not reopen that waived evidence as an unfinished gate,
or claim the original stacking cause was proven.

**Why:** The received MIME contained the correct desktop media query; losing that
query reproduces stacking, but the MIME does not establish what Gmail applied.
Browser success and preserved Outlook conditional tables are not client evidence.
The original message also exceeds the approximate Gmail clipping threshold, which
is a separate risk and must not be labelled the proven stacking cause.

**How to apply:** Use sanitized baseline/candidate messages, never the original
campaign's test-send route for no-write verification. That route may add recipient
rows, and campaign reads may refresh counts. Preserve HTML/design snapshots and
validate content completeness before any explicitly approved regeneration.

For isolated Mailgun raw-MIME tests, pass a Buffer rather than a string.
**Why:** The SDK accepts strings but submits them as ordinary form fields;
the live MIME endpoint rejected that request with HTTP 400. A Buffer produces
the required file part and was accepted. Domain-read access also does not prove
send authority.
**How to apply:** Use a separate approved sending credential when needed, retain
attempt journals, and distinguish rejected requests from ambiguous timeouts.
Neither HTTP acceptance nor a generated MIME file is received-client evidence.