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

Card cart reservations should expire after five minutes of checkout inactivity,
not 24 hours. Keep active card entry protected; failed/cancelled attempts should
release promptly after provider verification.

**Why:** The owner explicitly rejected the 24-hour stock hold and selected a
five-minute inactivity timeout to avoid unnecessarily blocking availability.

**How to apply:** Coordinate the activity-aware checkout deployment and database
timeout activation. Never restore availability while payment may still succeed.

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
