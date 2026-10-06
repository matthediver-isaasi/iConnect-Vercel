---
name: Private audit logging
description: Assertion failures can expose entire private records even when normal logs contain only counts.
---

Database audit and reconciliation entrypoints must redact uncaught errors as
well as ordinary progress logs. Keep detailed comparisons in private evidence,
not terminal output.

**Why:** Node's deep-equality assertion errors include complete actual and expected
objects, so a harmless concurrent activity change can print personal fields even
when the script has no explicit record-logging statement.

**How to apply:** Install safe top-level error handling before reading private
records. Log bounded error categories and counts, not assertion objects or raw
database errors. Never weaken write-time stale-record checks merely to prevent
an assertion failure.
