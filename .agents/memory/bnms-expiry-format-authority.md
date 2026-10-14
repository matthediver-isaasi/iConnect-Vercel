---
name: BNMS legacy expiry format authority
description: User-confirmed US interpretation for the short dates in the October 2026 expiry audit.
---

The user confirmed that the 155 short, non-standard `ym_date_membership_expires` values identified in the 14 October 2026 BNMS audit are US dates and can be interpreted as month/day/year before conversion to DD/MM/YYYY.

**Why:** The earlier formatting sweep left these short values behind; the user explicitly supplied the source-format interpretation.

**How to apply:** Limit this interpretation to that reviewed cohort, not every ambiguous date in the database. Revalidate each original value before editing. Source-format confirmation is not blanket write permission: honour the members expressly authorised in the current request. Do not alter membership history or infer payment authority from a formatting correction.
