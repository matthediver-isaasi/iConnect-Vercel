# GFI renewal rejection — read-only diagnosis

Evidence collected 29 September 2026. No application or database behavior was changed.

## Conclusion

**Confirmed source behavior and compatible live data, not attribution of the original request.** A fixed annual term ending 31 July 2026 with zero (or missing) grace days is rejected from 1 August onward, including when an administrator uses the organisation manual-renewal path. The exact message is:

> The renewal grace period ended on 2026-07-31. Please contact an administrator.

Production GFI data supplies a plausible route to that exact date. It does not prove which organisation, user, button, requested year, or deployed code revision produced the screenshot.

## Production evidence

Read-only Supabase SQL was executed against documented production DEST project `lvmzliemqnieeoruhkik`, not the workspace runtime database or legacy SOURCE. Tenant lookup confirmed slug `gfi`, name **Graduate Futures Institute**, ID `fd82da65-aab7-4a5c-85b8-b2febeb2003d`.

Queries projected only structure policy/date/scope fields and aggregated organisation history. No organisation names, contact details, invoice amounts, member identities, or full commitment objects were retrieved. Queries used SELECT only; no application endpoints were invoked.

### Dated structures

All four structures are active, annual, have `renewal_open_days = 0` and `renewal_grace_days = 0`, and both login-disable and role-change settings are false. No current grace setting is null/missing or nonzero.

| Structure name | Scope / match | Effective from | Effective through | Start mode |
|---|---|---|---|---|
| 01/08/2025-31/07/2026 | Organisation / University | 2025-08-01 | **2027-07-31** | fixed_date |
| 2026/2027 Partner | Organisation / Partner | 2026-02-23 | Open-ended | fixed_date |
| 2026/2027 Freelance | Member / Freelancer | 2026-02-23 | Open-ended | immediate |
| 01/08/2026-31/07/2027 | Organisation / University | 2026-08-01 | Open-ended | fixed_date |

All store membership start month/day 8/1. The Freelance structure is member-scoped, not an organisation-renewal candidate. The older University structure's effective end differs from its name and overlaps the newer one; this is observed configuration, not a conclusion that it caused the toast.

`membershipConfigResolverCore.js` filters by active status, inclusive effective dates and organisation scope, then matches organisation fields, with configurations ordered by effective-from descending. `membershipSimulationCore.js` also resolves fixed-year pricing at the target year's start and supports overrides. Consequently, a name or open-ended effective date alone cannot identify the selected structure. All three organisation structures nevertheless share the same relevant zero-grace/August-start settings.

### Organisation history and saved policy

The bounded grouped query returned five groups; independent aggregate totals confirmed completeness:

| Membership year | Referenced structure | Rows | Persisted term dates |
|---|---|---:|---|
| 2025/2026 | Partner | 2 | Both null |
| 2025/2026 | Older University | 176 | Both null |
| 2026/2027 | Partner | 4 | Both null |
| 2026/2027 | Newer University | 167 | Both null |
| 2026/2027 | Newer University | 2 | 2026-08-01 to 2027-07-31 |

- Total: **351 records across 190 organisations**, maximum two history rows per organisation. The resolver's 50-row history limit therefore does not truncate this observed cohort.
- All history is annual and has no rolling term key.
- **Zero of 351 records has a commitment snapshot.** There is no saved historical grace policy to establish whether it was zero, missing, or nonzero when those commitments originated. This is distinct from the confirmed zero setting on today's structure rows.
- 178 organisations have 2025/2026 history; **17 have no 2026/2027 history**. None of those 17 has a qualifying active/pending Stripe or GoCardless monthly agreement under the classifier's status/provider rules.
- These 17 are a plausible candidate cohort, not 17 proven failed renewals. Organisation validity, simulation success, overrides, original action time, and requested year have not been established.

For the 2025/2026 rows, **31 July 2026 is inferred by the code**, not a persisted expiry: the year-label parser takes 2025 plus the resolved August 1 start and derives a full year ending 2026-07-31. With no snapshot, the classifier takes the simulation's resolved config; it does not independently reload the old history row's `config_id` as policy authority.

## Confirmed source path

1. `OrganisationDetailView.jsx:2019–2032` renders Rules / Customize Layout / Edit, matching the supplied cropped image, and mounts `OrgMembershipTab` at line 3167. The crop contains no identity, URL, request, or clicked control.
2. `OrgMembershipTab.jsx:1141–1164` posts `{ organizationId, membershipYear }` to `/api/membership/org-membership-invoicing`. It throws the response's `error`, then displays it with `toast.error(error.message)`.
3. `org-membership-invoicing.js:249–277` runs simulation and then `resolveEntityAnnualRenewalEligibility`. An ineligible result returns HTTP **409**, error text, code **annual_renewal_grace_expired**, and lifecycle metadata. There is no administrator exemption in this check.
4. `annualRenewalPolicy.js:211–242` loads tenant/organisation history, separates an existing target label, chooses the prior term with latest end before the target start, and checks recurring agreements.
5. At lines 144–174, saved `commitment_snapshot.config` takes precedence over the supplied config. Missing and zero grace normalize to zero. For fixed terms, cutoff = prior end + grace days. The comparison is inclusive by UTC calendar date: only `today > cutoff` expires.
6. This rejection precedes the handler's history insert, invoice creation, email, and note writes. A failed policy check is not evidence that any financial action succeeded.

Login-disable and role-change flags are independent of renewal eligibility. Their false values do **not** disable the grace cutoff. “Please contact an administrator” is misleading in this admin path because it has no special bypass.

### Supported alternative paths

The same organisation tab's **Invoice Now / advance-invoice** mutation (`OrgMembershipTab.jsx:1166–1189`) posts `advance: true` to the same endpoint. `org-membership-invoicing.js:526–538` applies the same classifier and returns the same 409, also toasted verbatim. This is a concrete alternative to manual renewal within the matching screen.

Other source consumers include member invoicing, member fees, public fee links, form membership payment, and renewal processing. Shared wording is not unique proof of an organisation POST. The screenshot is consistent with the organisation detail UI but does not establish a network route.

## Offline reproduction

Executed the actual pure classifier with sanitized fixtures, without importing the database-backed endpoint or invoking production mutations:

| Fixture | Evaluation date (UTC) | Result / cutoff |
|---|---|---|
| 2025/2026 label, August 1 start, grace missing | 2026-09-29 | Expired / 2026-07-31 |
| Same, explicit grace 0 | 2026-09-29 | Expired / 2026-07-31 |
| Same, explicit grace 0 | 2026-07-31 | Open / 2026-07-31 |
| Same, explicit grace 0 | 2026-08-01 | Expired / 2026-07-31 |
| Same, grace 60 (hypothetical, not live GFI) | 2026-09-29 | Grace / 2026-09-29 |
| Current grace 60, saved snapshot grace 0 (hypothetical) | 2026-09-29 | Expired / 2026-07-31 |
| Explicit persisted 2025-08-01–2026-07-31 term, grace 0 | 2026-09-29 | Expired / 2026-07-31 |

All seven assertions passed; each expired case matched the exact screenshot text. Successor start remained 2026-08-01, not the action date. Existing isolated tests also passed, 4/4:

`node scripts/run-isolated-tests.mjs node --test api/_lib/annualRenewalPolicy.test.mjs`

The source trace establishes the response/toast wiring; it is not an executed live endpoint or authenticated browser test. No app code changed, so no app restart, deployment, or visual smoke test was required.

## Limits and separately approved options

We have no original request timestamp, payload, response, organisation identity, user identity, or deployed revision. The database reads describe present state, not a transactionally reconstructed incident snapshot. To attribute the incident, obtain a narrowly scoped, redacted browser network capture or historical request evidence containing route, method, target year, response code and organisation identifier; do not repeat a live renewal merely to diagnose it.

Options for separate approval, **not implemented**:

1. Design a permission-gated, explicitly confirmed late administrative renewal action, with audit reason, while leaving self-service restrictions intact. Preserve recurring-plan exclusion, duplicate prevention, approval requirements, pricing/snapshot authority, term continuity, pause/access rules, invoice idempotency and payment safeguards. Do not implement a blanket admin bypass.
2. If GFI intends a wider self-service window, approve a specific dated policy change after checking snapshot behavior and affected cohorts. Changing current grace settings does not override saved policies generally, and zero must not silently become “unlimited.”
3. Improve admin-facing expiry guidance so it names the rejected action and available authorised resolution instead of directing an administrator to themselves.

**Change/migration statement:** No membership, invoice, access, policy, email, schema, or application code was changed. No database migration was needed or applied to DEST, SOURCE, or any other database; none remains to apply for this diagnosis.