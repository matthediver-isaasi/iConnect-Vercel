---
name: Survey score CSV contract
description: Export historical raw answers without letting coercion or current survey design invent scores.
---

CSV score exports preserve numeric legacy answers and explicit N/A but leave malformed values blank. Do not apply the current form's score range to historical answers.

**Why:** JavaScript numeric coercion can turn booleans, arrays, and whitespace into valid-looking zero/one answers; current survey ranges may differ from the design used when an answer was saved. Export formatting must not change survey scoring or saved data.

**How to apply:** Keep export-only validation type-aware; any tightening of the server scoring parser is separate work requiring submission-validation regressions.
