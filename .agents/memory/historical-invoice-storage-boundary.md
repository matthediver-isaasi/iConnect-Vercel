---
name: Historical invoice storage boundary
description: Owner-confirmed separation of BNMS imported historical invoices from operational financial records.
---

BNMS spreadsheet invoices are historical storage, treated differently from current invoices but presented similarly on the front end.

**Why:** The user explicitly confirmed that these are essentially historical storage, not operational invoices.

**How to apply:** Keep imported historical invoice metadata separate from membership lifecycle, payment collection and accounting recovery authority. Reuse familiar member Activity and History presentation without creating renewal or financial processing side effects.
