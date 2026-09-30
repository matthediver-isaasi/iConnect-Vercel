---
name: Organisation access revocation
description: Durable organisation login revocation must survive restoration, cleanup failures, and concurrent membership creation.
---

Organisation restrictions need a durable session fence, not just live access checks and session deletion. Keep manual and configured-gate causes independent.

**Why:** An idle session can survive failed cleanup and become usable after restoration. Scanning existing members also misses members created concurrently with a block; tenant-wide invalidation incorrectly logs out unrelated organisations.

**How to apply:** Preserve irreversible revocation evidence and serialize issuance/membership creation against denying transitions. Test with two database connections, include legacy tenant-null members whose tenant comes from their organisation, and verify unrelated organisations retain access. Treat fence lookup errors as denial and keep fence storage and functions server-only.