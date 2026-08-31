---
name: Mixed-encoding CSV imports
description: Safe decoding rule for CSV files containing valid UTF-8 alongside isolated Windows-1252 bytes.
---

Mixed-encoding imports must preserve valid UTF-8 sequences and decode only isolated invalid bytes as Windows-1252.

**Why:** Whole-file fallback silently corrupts valid multibyte punctuation when only a few bytes use the legacy encoding.

**How to apply:** Decode maximal valid UTF-8 spans, repair isolated bytes, reject replacement/mojibake markers, and verify intended Unicode after writing.