---
name: Event email editing delivery boundary
description: Saving confirmation or reminder messages must not trigger sending or resending.
---

Updating either confirmation or reminder emails must never automatically trigger a send or resend.

**Why:** The user explicitly stated this requirement after the event email save timeout investigation.

**How to apply:** Treat configuration editing as distinct from delivery. Saving must not reset delivered or claimed messages to pending or implicitly authorize retrospective delivery. Check both confirmation and reminder paths, not only direct mail-provider calls.
