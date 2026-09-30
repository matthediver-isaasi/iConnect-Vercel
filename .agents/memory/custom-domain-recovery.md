---
name: Custom-domain recovery boundaries
description: Separate hosting attachment from tenant mapping when a live custom hostname serves the app but cannot resolve its tenant.
---

Verify hosting attachment and application tenant mapping independently before repairing a domain registration. Preserve an already-correct production attachment; a generic provider conflict message is not evidence that a transfer is needed.

**Why:** BNMS's apex and www were verified on the correct production deployment while its application mapping still named an anniversary subdomain. The old registration flow could collapse owner-discovery failures into a transfer message, even though discovery excluded the configured target project. Correcting only the tenant mapping restored the public site without hosting or DNS writes.

**How to apply:** Read the actual project-domain records and deployment aliases, verify the destination database and tenant uniqueness, and inspect provider access separately. Do not infer the application token's permissions from a working connector credential. Distinguish live data recovery from source-code rollout, and report historical provider errors as unverified when their logs are unavailable.