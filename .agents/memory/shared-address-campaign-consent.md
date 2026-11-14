---
name: Shared-address campaign consent
description: Consent authority survives deduplication between member and external audience identities.
---

For inbox-enabled campaigns, evaluate tenant member consent by normalized email
address before deduplication and at final submission, even when the candidate
is an external contact. Address matching alone must not grant inbox membership.

**Why:** Filtering a category-excluded member before deduplicating allows an
external row sharing that address to survive and be mistaken for email permission.
Checking only the surviving row's member ID misses that exclusion.

**How to apply:** Keep selected-audience membership separate from address-level
email suppression. Test both candidate orders, external-only surviving rows,
global flags and missing positive category subscriptions in preparation and
at send time. Never infer that duplicate external identity overrides consent.
