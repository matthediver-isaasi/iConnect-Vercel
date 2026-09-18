---
name: BNMS renewal reconciliation scope
description: Agreed scope and evidence boundaries for BNMS migration review spreadsheets.
---

Reconcile one exact `member_class` at a time, beginning with invoices dated within the last twelve months. Deliver one Excel workbook rather than separate HTML/CSV reports.

**Why:** The user chose class-by-class review because structures have different nominal codes and billing patterns. Broad historical candidate lists obscured recurring invoice series and counted copies from multiple sources separately.

**How to apply:** Inspect the selected structure's actual nominal code, including dated versions and band overrides, and compare it with invoice-line AccountCode evidence. Never substitute a generic sales fallback as proof of membership. Deduplicate invoice identities across live and exported evidence, and distinguish monthly invoice sequences from competing annual invoices. Preserve missing-code and unavailable-provider evidence explicitly; descriptions alone are provisional. Reporting does not authorise membership or provider mutations.