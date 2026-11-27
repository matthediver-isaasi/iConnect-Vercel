---
name: PO reminder amount boundary
description: Why provider amounts fail closed and foreign currencies are not silently converted.
---
PO audit remediation authorizes code changes and isolated fixtures, not historical
invoice repair, backfills, customer contact, resends or live reminder-setting changes.

**Why:** The owner explicitly separated fixing the shared reminder logic from
acting on the audit's historical invoices.

**How to apply:** Obtain separate approval for any operational follow-through;
fixture results are not evidence that a real customer invoice was changed or sent.

The existing PO surfaces are pound-denominated. A foreign-currency Xero response
must remain unverified rather than being relabelled as pounds or converted.

**Why:** This audit fixes gross-amount authority; it does not authorize exchange-rate
selection or a wider multi-currency product change.

**How to apply:** Any future currency expansion must explicitly cover the report,
export, email and public submission display together, retaining provider currency.
