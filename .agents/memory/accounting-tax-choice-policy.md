---
name: Accounting tax choices
description: Provider-connected tax selectors must not offer iConnect no-VAT defaults.
---

When an accounting package is connected, the owner requires tax choices to come from that package, not built-in iConnect VAT defaults.

**Why:** The schedule label “No VAT” stored a null tax selection. iConnect calculated no VAT while Xero could apply the nominal account's taxable default. The label made incorrect configuration easy.

**How to apply:** Offer synced provider codes, including their zero-rated/exempt/no-tax choices. Label existing missing selections as unconfigured, never silently remap them to a tax classification. Removing misleading UI choices is not a repair of historical configuration or the invoice-generation fallback; treat those separately.
