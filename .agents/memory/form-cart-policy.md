---
name: Form commerce cart boundaries
description: Independent stock and explicit bundle tax authority for form commerce.
---

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
