---
name: Form commerce cart boundaries
description: Independent stock and explicit bundle tax authority for form commerce.
---

Backing out of card checkout with Previous must automatically cancel the
unfinished payment before navigating back to an editable cart. Do not require
a separate manual cancellation button.

**Why:** The owner explicitly rejected a separate recovery action as unwanted
checkout friction.

**How to apply:** Keep navigation gated on verified provider cancellation and
stock release; processing or successful payments must remain protected.

Reserve cart stock when the first item is added, with a configurable fixed
deadline (five minutes by default), rather than starting at checkout or
extending the deadline with checkout activity. Refresh and further additions
must not restart the timer. Expiry clears only cart selections.

**Why:** The owner superseded the earlier checkout-inactivity choice by approving
reservation on adding items, a configurable countdown and automatic cart
clearing. Other form answers must survive expiry.

**How to apply:** Use the server's original deadline across pages and checkout.
Returning from a safely cancelled checkout may retain stock only for that
original window. Coordinate deployment and database activation; never restore
availability or clear a purchased cart while payment may still succeed.

Form commerce bundles consume their own form-stock allowance, never component
product stock. Ordinary product stock is finite/unlimited inventory, not Sales
capacity metadata, and does not extend to proposal purchases.

**Why:** The owner explicitly approved independent bundle stock and limited
this feature to form commerce, not a unified Sales inventory system.

**How to apply:** Keep legacy bundle and cart bundle purchases on the same
counter. Do not add ticket/space fulfilment, proposal depletion, or automatic
refund/deletion restocking without separate scope approval.

Bundle tax must be explicitly configured for carts, not inferred from component
tax or silently defaulted to zero.

**Why:** Catalogue bundles lack the product-level tax authority; deriving a
bundle rate from components would invent financial terms.

**How to apply:** Reject ambiguous rates, calculate catalogue net plus
line-rounded tax once, and freeze accepted treatment/rates with the receipt.

Opt-in form invoice checkout confirms the order and allocates stock immediately,
without waiting for payment. It must remain unpaid, not simulate a successful
card collection.

**Why:** The owner explicitly chose immediate order confirmation for invoice
checkout; invoice creation is not evidence of payment.

**How to apply:** Keep order acceptance, stock allocation and the durable invoice
request atomic, with retries reusing the original order and accounting identity.

Invoice immutability must permit receipt-verified cart canonicalization while
preserving all other answers and financial terms.

**Why:** Shopping answers contain a temporary reservation token that the
authoritative receipt removes. Treating this removal as an order edit blocked
invoice insertion; fixtures without the browser's nested token missed it.

**How to apply:** Test the complete browser answer through database triggers,
including both reservation references, for products and bundles. Never broadly
exempt cart answers from invoice immutability to allow this transition.

Cart project codes refer to the accounting tracking category, not actual
accounting project entities. A missing purchase-order answer must produce
exactly `TBC` as the invoice reference, without an internal recovery suffix.

**Why:** The owner confirmed tracking-category semantics and relies on the
literal TBC reference for the purchase-order report.

**How to apply:** Keep accounting configuration admin-owned and snapshot it
when accepting an order. Keep provider recovery identifiers separate from the
customer reference. Do not assume Xero ledger/tracking codes are QuickBooks
item/class identifiers.
