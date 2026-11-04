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

Xero reference equality searches can return no results for existing multiline references; Reference.Contains is not a supported replacement on these endpoints.

**Why:** Live invoice recovery missed an existing, exactly matching invoice until it was queried by contact instead.

**How to apply:** Scan invoices by contact and payments by invoice, paginate completely within bounded limits, then compare the full frozen reference and marker locally. Preserve uniqueness checks and exact-ID validation; absence never authorizes repeating an uncertain write.

Pre-request budget refusal is different from post-write readback failure.

**Why:** A worker can exhaust its budget between invoicing and payment allocation. An unsent request is retryable, but successful POST followed by failed readback remains uncertain.

**How to apply:** Preserve the provider adapter's override of definitelyNotWritten after POST. Never reissue an unknown financial operation merely because a subsequent discovery read found nothing.

Same-organisation reconnection needs explicit, request-scoped approval.

**Why:** Reconnecting Xero can replace its local connection record while retaining the same Xero organisation. Existing accounting requests deliberately pin the previous connection. Silently accepting any replacement would defeat that protection.

**How to apply:** Keep original queue authority and financial evidence immutable. Use operator-approved, revocable mappings for exact request/tenant/provider/company/old/new connection tuples, checked again after credential refresh. Application roles may read approvals but must not create them. Reconnection approval is not permission to repeat an uncertain financial write.
