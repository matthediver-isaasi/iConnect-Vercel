---
name: Email column release gate
description: Received-message evidence required before enabling the Gmail hybrid column candidate.
---

Keep the hybrid column fallback test-only until received Gmail desktop/mobile and
classic Outlook checks pass for an explicitly approved test inbox.

**Why:** The received MIME contained the correct desktop media query; losing that
query reproduces stacking, but the MIME does not establish what Gmail applied.
Browser success and preserved Outlook conditional tables are not client evidence.
The original message also exceeds the approximate Gmail clipping threshold, which
is a separate risk and must not be labelled the proven stacking cause.

**How to apply:** Use sanitized baseline/candidate messages, never the original
campaign's test-send route for no-write verification. That route may add recipient
rows, and campaign reads may refresh counts. Preserve HTML/design snapshots and
validate content completeness before any explicitly approved regeneration.