---
name: Badge instructions lifecycle
description: Approval boundaries and cross-service deletion recovery for tenant guidance.
---
Keep badge guidance private and retain uploaded PDFs when administrators switch to standard help.

**Why:** Removal from use and permanent deletion are distinct product actions; switching the help source is not permission to dispose of the file.

**How to apply:** Preserve the standard help fallback and require explicit confirmed deletion. Cross-service deletion cannot be atomic with object storage: preserve a service-only recovery copy and fence competing changes until deletion finalizes, rather than restoring bytes to an object path after an ambiguous failure.
