---
name: Organisation purchase association audit policy
description: Authority and approval boundaries for historical form-invoice organisation links.
---

Historical form-invoice purchase associations may be considered for repair only
from a saved, trusted, tenant-valid organisation ID in the invoice customer
snapshot. Never infer the organisation from its name or the purchaser's member
affiliation.

**Why:** The owner explicitly limited the historical Activity audit to persisted
customer authority, excluded a separately repaired Bayer purchase, and required
a read-only report before approving any further live repair.

**How to apply:** Report missing, already-linked, conflicting and unverifiable
records separately. A missing historical customer ID is an exclusion, not
permission to reconstruct one. Obtain explicit approval for additional live
records, keep immutable answers and invoice snapshots unchanged, and never
replay accounting or notifications merely to repair Activity visibility.
