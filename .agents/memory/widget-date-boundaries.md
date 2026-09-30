---
name: Widget date comparison boundaries
description: Date input support must not change timestamp boundary semantics.
---

Widget date-only operands represent the existing midnight boundary, not an entire calendar day. Day/month/year input is explicitly day-first.

**Why:** Supporting another input format is not authorization to expand equality or inclusive comparisons through the end of a day. Such expansion changes existing widgets' timestamp results.

**How to apply:** Keep format normalization separate from interval semantics; test midday timestamps against date-only operands whenever changing date parsing or comparisons.

The Events inventory source is an explicitly requested exception: its date-only inclusive upper bound includes the entire final UTC day.

**Why:** Event-period counts require whole-final-day ranges, but expanding the shared matcher would change existing Event Bookings and other saved widgets.

**How to apply:** Keep this exception local to Events; do not generalize it to other sources without a separate requirement.