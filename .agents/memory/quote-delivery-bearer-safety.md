---
name: Quote delivery bearer safety
description: Security and delivery-state rules for public quote links and decision auditing.
---

Public quote URLs are bearer credentials. Store only a one-way hash, omit referrer/path/query data from request audits, and expose quote/branding data through explicit allowlists rather than broad snapshot scrubbing.

**Why:** A public SPA referrer can contain the plaintext token, and persisting it defeats hashed-token storage. Broad tenant or contact snapshots can also expose unrelated configuration or personal data.

**How to apply:** Build links only from the tenant's sanitized configured domain or canonical slug host—never from request Origin/Host headers. Mint links inactive, activate only after successful delivery is recorded, use no-store/no-referrer responses, and keep decisions idempotent.