---
name: BNMS upfront membership evidence
description: Operator-attested current membership establishment is distinct from verified invoice settlement and future billing authority.
---

Treat the BNMS upfront backfill as establishment of existing 2025–2026 memberships,
not creation of new or future commitments. The operator authorized assuming these
members paid, with manual corrections later; keep that attestation distinct from
provider-verified invoice evidence.

The operator explicitly approved establishing the reviewed current cohort with
unknown historical amounts and no invoice links where matching remained
unresolved. Do not interpret that approval as authority to link uncertain invoices
or infer prices later.

**Why:** Retained legacy records contain expiry/class but may lack commencement.
The operator explicitly rejected interpreting the repair as future membership
creation. A latest invoice can also be an upgrade balance rather than a full annual
price; the operator chose the latest invoice amount for the reviewed pilot.

**How to apply:** Preserve known expiry and unknown start separately. Do not infer
annual commencement, add billing consent, or mint successor terms to make the UI
show an existing membership. Continue excluding known DD evidence. Link only a
verified matching invoice; an operator's paid assumption is not permission to
relabel an unpaid provider invoice or associate an older invoice with a newer term.

Do not reinterpret ambiguous legacy short expiry dates as UK dates solely because BNMS is a UK tenant.

**Why:** The user confirmed that an investigated ambiguous legacy date was intentionally US month/day/year and that the corresponding December history expiry was correct.

**How to apply:** Verify source-specific date conventions before proposing data repairs. A short slash-form custom value and a long-form history date may represent the same intended day; their visual difference alone is not evidence of corruption.

An expiry-only upfront record may support an explicitly labelled expected renewal date of expiry plus one day, without establishing a successor commitment.

**Why:** The user approved this reporting projection even when the imported start date and historical structure are unknown. The earlier prohibition on inventing future commitments must not be misread as prohibiting clearly labelled read-only forecasts.

**How to apply:** Prefer a saved renewal date; otherwise derive from trusted persisted expiry. Keep expected renewal and uniquely matched next-structure information separate from scheduled collection evidence. Never use the projection itself to authorise billing or create memberships.