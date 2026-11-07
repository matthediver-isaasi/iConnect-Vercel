# Tenant renewal entry routing

Admin Settings → Membership renewal journey offers two modes:

- **Continue with the existing membership schedule:** retain the existing
  payment card's authored renewal link and current eligibility behaviour.
- **Reassess through a form:** the portal's eligible Renew/Restart action opens
  the configured entry questionnaire, using its current slug. That form owns
  its question-based onward routing. No destination forms or rules are changed.

Only active, login-required standard forms from the current tenant may be
selected. Settings saves use revision checks, serialize first saves, and append
an audit record. An unavailable selected form or failed settings read suppresses
the renewal link rather than falling back to the old membership schedule.

This is navigation, not payment authority. Existing eligibility, unfinished
checkout, already-purchased successor, pause and membership evidence checks are
unchanged. The final renewal form still validates schedule selection, dates and
payment state. Category changes for a new term are not mid-term amendments.
Questionnaire mode suppresses the previous schedule's projected renewal price
on the card; the destination form quotes the selected membership instead.

## Rollout and backout

The pinned runner `scripts/apply-membership-renewal-journey.mjs` installs
`202701210002_membership_renewal_journey.sql`, verifies permissions and enables
the approved BNMS questionnaire. Other tenants have no settings row and retain
their prior behaviour. Run without arguments for the reviewed migration hash;
applying requires `--apply --review-sha256=<exact hash>`.

Deploy the matching API and frontend after the migration. The setting does not
change forms, memberships, invoices, payment providers, or email delivery.

To back out navigation, select the existing-schedule option and save using the
current revision. The original canvas renewal link was never overwritten.
Do not delete the audit history or revert financial records.

## Verification

Unit/API tests cover default preservation, scoped settings access, routing,
missing/disabled/wrong-tenant forms and failed reads. Rendered component tests
cover destination replacement and continued eligibility suppression. A mounted
admin test covers selecting/saving a form and stale revision feedback.
Disposable PostgreSQL checks cover grants, first-save revision control, audit,
cross-tenant form rejection and inactive authentication requirements.

The local preview uses the legacy database target and may fail tenant branding;
isolated rendered tests are not a signed-in deployed BNMS browser test.

## First-membership entry

The separate **First-membership joining journey** card selects a joining
questionnaire, or **Not configured** to hide the action. Public standard forms
are valid here; their access settings are not changed. Renewal still requires
its separately configured login-required form.

The portal offers **Become a member** only to an authenticated account with a
verified role and confirmed absence of retained personal/organisation membership
and unresolved membership payment evidence. A bare organisation affiliation is
not itself a paid entitlement. Paused/cancelled accounts and failed evidence
reads never acquire joining eligibility. Explicitly retired unpaid checkouts
remain distinct from ordinary expiry, and expired voucher tokens require
confirmed release evidence.

Guests who lack commerce-history permission can receive this minimal joining
navigation, not financial history. Accounts with history remain subject to the
existing permission gate. The final form still owns signup and payment
validation; showing a link never creates or activates membership.

`scripts/apply-membership-joining-journey.mjs` applies the pinned
`202701210003_membership_joining_journey.sql` migration and configures BNMS's
approved joining questionnaire. It verifies that the renewal setting and the
form's public-access configuration remain unchanged. Other tenants remain
unconfigured. To back out, clear the joining form in settings; do not remove
the audit history or alter payment records.
