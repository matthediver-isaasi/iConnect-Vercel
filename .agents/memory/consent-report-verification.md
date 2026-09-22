---
name: Consent report verification
description: Regression-test boundaries for stored consent versus category availability.
---

Consent matrix tests must assert the exact member/category cell, including both stored opt-in and availability.

**Why:** A row-wide assertion passed when a different, available category contained “Opted in”, masking the loss of stored true consent in an unavailable category.

**How to apply:** Include true and false preferences for inactive, public-only and role-ineligible categories; target individual cells rather than the row's combined text.