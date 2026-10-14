---
name: BNMS CRM Direct Debit flag
description: A sparse legacy CRM flag is not live mandate or payment authority.
---

Do not use the BNMS “Direct Debit payment” CRM filter as proof that a member has no GoCardless mandate or collected payments.

**Why:** Legacy members with saved mandate evidence can have no value for this field. The user authorised treating unset values as No for filtering, while explicitly deferring the underlying reconciliation.

**How to apply:** Investigate provider and linked billing evidence separately before correcting records. The filtering decision authorises no data backfill, payment collection, membership activation or general change to other boolean fields.
