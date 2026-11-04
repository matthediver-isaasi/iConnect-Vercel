---
name: Xero shared quota boundary
description: Application identity, rollout authority and financial retry boundaries for shared Xero pauses.
---
Accounting API quota authority must be application-plus-organisation, with a
separate application-wide budget. Do not copy new pauses into organisation-only
queue state. Missing coordination must refuse transport, not fall back to HTTP.

**Why:** Direct callers otherwise consume allowance during queue pauses, while an
organisation-only embargo both over-throttles independent apps and misses
application exhaustion across organisations. Configured Client ID is not evidence
of grant-time identity; historical grants lack that provenance.

**How to apply:** Route new production Accounting API transports through the shared
gate, including scripts reused operationally. Keep OAuth APIs outside Accounting
API quota assumptions. Apply the service-only migration only with explicit rollout
approval. An HTTP attempt is never automatically repeated by the limiter; errors
after sending or successful POST followed by blocked readback remain uncertain.
