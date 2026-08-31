---
name: Mixed-encoding CSV imports
description: Safe decoding rule for CSV files containing valid UTF-8 alongside isolated Windows-1252 bytes.
---

Do not switch an entire CSV to Windows-1252 merely because strict UTF-8 decoding finds one invalid byte. Preserve valid UTF-8 byte sequences and decode only invalid individual bytes through Windows-1252, then reject known mojibake patterns before planning writes.

**Why:** A source file can contain both an isolated Windows-1252 punctuation byte and valid multi-byte UTF-8 punctuation. Whole-file fallback silently corrupts the valid UTF-8 text, and source-relative verification then accepts the corruption.

**How to apply:** For imported text, validate representative mixed-encoding values before writes and reject replacement characters or mojibake markers. Post-apply verification should confirm the intended Unicode characters, not merely compare against an unchecked decoded source.