---
name: Proposal organisational membership entitlement policy
description: Owner-approved single-period base-fee coverage and financial commitment boundaries.
---
Proposal acceptance grants eligibility for one newly created period of the exact
included organisational schedule, independently of invoice issuance or payment.
It does not create membership or reassign the organisation's schedule.
Add-ons remain payable; subsequent periods use ordinary pricing. Do not stack
quantities into future complimentary renewals or retrofit existing charges.

**Why:** The owner explicitly approved one period, not an ongoing waiver, and
requires Sales invoice economics and historical payment evidence to remain intact.

**How to apply:** Validate duplicate schedule occurrences and quantities visibly.
Make grant consumption and history creation atomic, and check eligibility before
any payment/provider commitment. History insertion alone is too late for
post-payment finalisers. Complimentary coverage is not proof the proposal was
free or paid. Live migration/provider operations and backfills need separate
approval.

The shared membership simulator also runs behind capability-only dry-run
adapters. Pass rollout decisions into its runtime composition rather than
reading environment variables inside its dependency graph.

Enabling complimentary membership requires matching readers and writers in
every serving environment sharing its database, not just the authoring Preview.

**Why:** Preview can grant a benefit which an older Production billing path does
not understand. Database installation alone is not safe activation.

**How to apply:** Verify deployed commits and feature flags across the shared
database's serving environments before enabling authoring.

**Why:** A runtime feature flag introduced through a history-snapshot helper
can otherwise give dry runs ambient authority and violate their isolation.
**How to apply:** Keep feature configuration outside the pure simulator and
inject it explicitly at live entry points, including annual renewals.
