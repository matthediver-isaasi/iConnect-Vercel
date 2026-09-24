---
name: Widget date comparison boundaries
description: Date input support must not change timestamp boundary semantics.
---

Widget date-only operands represent the existing midnight boundary, not an entire calendar day. Day/month/year input is explicitly day-first.

**Why:** Supporting another input format is not authorization to expand equality or inclusive comparisons through the end of a day. Such expansion changes existing widgets' timestamp results.

**How to apply:** Keep format normalization separate from interval semantics; test midday timestamps against date-only operands whenever changing date parsing or comparisons.