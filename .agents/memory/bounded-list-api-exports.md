---
name: Bounded list APIs and exports
description: Prevent silent export truncation when interactive API list endpoints enforce bounded page sizes.
---

An export that reuses an interactive list endpoint must iterate bounded pages until it has collected the endpoint's exact reported total. Never depend on requesting one artificially large page.

**Why:** Tightening an API's maximum page size is a sensible safety measure, but any pre-existing one-request export can then return a valid-looking yet incomplete file without an error.

**How to apply:** Whenever adding or lowering a list endpoint's page-size cap, find all export and bulk-read callers. Make them follow pages to the exact count, and cover a dataset larger than the cap in an automated check.