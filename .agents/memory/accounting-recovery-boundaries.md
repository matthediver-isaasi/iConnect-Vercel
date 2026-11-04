---
name: Accounting recovery boundaries
description: Recurring imported collection authority and preparation versus uncertain financial writes.
---
Imported membership provenance persists into subsequent monthly collections; it is not a one-month recovery authorization.

**Why:** November settled collections were held by an October-only bridge, even though the canonical alpha/manual ownership RPCs already authorize subsequent released collections. This does not authorize other import cohorts without equivalent ownership protections.

**How to apply:** Keep canonical collection and legacy-writer ownership checks. Do not remove the protections for existing operation claims or uncertain financial outcomes merely to widen calendar eligibility. Existing-invoice payment allocation is a separate path, not authority to create another invoice.

Xero may return XML for reads unless JSON is explicitly requested.

**Why:** Successful provider reads can otherwise fail JSON parsing and be placed in permanent review rather than cooldown retry. Cooldown expiry does not release review records.

**How to apply:** Explicitly negotiate JSON in preparation reads as well as financial transport. Preserve safe, non-sensitive error codes so manual review does not conceal the actual cause.

Pre-request budget refusal is different from post-write readback failure.

**Why:** A worker can exhaust its budget between invoicing and payment allocation. An unsent request is retryable, but successful POST followed by failed readback remains uncertain.

**How to apply:** Preserve the provider adapter's override of definitelyNotWritten after POST. Never reissue an unknown financial operation merely because a subsequent discovery read found nothing.
