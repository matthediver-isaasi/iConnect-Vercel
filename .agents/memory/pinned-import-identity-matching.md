---
name: Pinned import identity versus matching
description: Preserve historical importer identity hashes while tolerating legacy text encodings during live-record matching.
---

Keep the normalization used to reproduce historical import identity hashes
separate from the normalization used to match live display names.

**Why:** Live data can contain legacy Windows-1252 punctuation such as byte
`0x96`, while a pinned workbook contains the Unicode equivalent. Expanding the
shared normalizer would make names match, but would also change deterministic
hashes already stored as importer identities.

**How to apply:** Freeze the identity-hash normalizer once identities have been
persisted. Add encoding and punctuation tolerance only to the live matching
normalizer, and cover both the pinned source totals and rerun behavior.