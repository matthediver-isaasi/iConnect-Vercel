---
name: Historical invoice storage boundary
description: Owner-confirmed separation of BNMS imported historical invoices from operational financial records.
---

BNMS spreadsheet invoices are historical storage, treated differently from current invoices but presented similarly on the front end.

**Why:** The user explicitly confirmed that these are essentially historical storage, not operational invoices.

**How to apply:** Keep imported historical invoice metadata separate from membership lifecycle, payment collection and accounting recovery authority. Reuse familiar member Activity and History presentation without creating renewal or financial processing side effects.

Spreadsheet payment status is source evidence, not authority to settle operational
financial records. Periodic accounting observations must remain separate from the
imported status and carry verified provider identity and freshness.

**Why:** The user requested status updates and ongoing accounting checks for the
historical import; some archived references also have later operational mirrors.
Updating archival metadata must not replay financial or membership side effects.

**How to apply:** Verify the original import journal and immutable metadata before
allowing existing overlaps. Never create new overlapping records. Preserve source
status when a provider check fails, and clearly distinguish stale observations.
