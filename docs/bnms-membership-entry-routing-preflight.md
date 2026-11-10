# BNMS membership entry routing: configuration and rollout

## Status

On 2026-11-10 the forward migration and scoped configuration were applied to
verified destination Supabase project `lvmzliemqnieeoruhkik`. A serializable
transaction rehearsal passed and was rolled back before the committed run.
The code in this branch has **not been deployed**: live use of the independent
post-grace destination requires matching application rollout.

Both joining and renewal settings now have revision 2. Authenticated joining
and post-grace point to Continuing; ordinary renewal still points to Renewing.
Public Getting Started, Student and Contact Us were unchanged.

The recovery snapshot is in `membership_entry_configuration_audit`, row
`0cdcc8cd-9241-4f12-836e-b45405e92424`, with before/after form and journey
configuration. Reviewed snapshot/migration hash:
`52ee2da5c41402b4f4b8e9290c0817b3036762dcd80b8189206ecb877aa75294`.
Journey history contains both revision changes. No memberships, submissions,
payments or messages were created or modified. SOURCE was untouched.

## Approved destinations

Tenant: `ff2df806-b321-4254-b651-3af11fccf1db`.

| State | Intended entry |
| --- | --- |
| Public new applicant | Getting Started `ab2d6278-686c-4604-be28-05d4bb328e03` |
| Authenticated account, verified never-held membership | Continuing `7e263a45-ad57-4404-bc18-05288fd52ec9` |
| Eligible pre-expiry/open-window or within inclusive grace | Renewing `090be663-5429-4e46-b6ee-d824d37d6d3b` |
| Eligible former member beyond grace | Continuing `7e263a45-ad57-4404-bc18-05288fd52ec9` |

Signed-out status is not evidence that someone has no existing account.
Eligibility must remain independent of destination selection.

## Initial live configuration, before the transaction

- Joining revision 1 points to Getting Started.
- Renewal revision 1 uses questionnaire mode and points to Renewing.
- All three entry forms are active, unarchived, and have no deactivation date.
- Getting Started is public; Renewing requires authentication.
- Continuing does not require authentication. It retains a public-signup
  mutation policy and a member-creation pipeline assigning a fixed role. That
  pipeline maps an email field not present among its four current fields.
  This is not a safe authenticated navigation-only contract.
- Continuing's additional Yes branch points to active public **BNMS Contact Us**
  (`a2f08af7-75f6-49ae-84ac-bb33ab166fb6`). Contact Us has no member or
  organisation pipeline and no payment fields. Preserve this branch.

## Category branches

All five destinations are active, authenticated, unarchived, have no
deactivation date or access policy, use `authenticated_owner`, and prefill from
the member. All retain required due diligence.

| Category | Destination | Membership processing |
| --- | --- | --- |
| Full | `518d4626-1c5c-4dff-85e3-0e9743b01563` | Generic `payment` field, automatic membership-structure action |
| Junior | `edd2ac75-e9aa-46e1-a971-82859fe96af5` | Generic `payment` field, automatic membership-structure action |
| Associate | `e50e9180-2392-44c6-9465-b95cae23eb8a` | Generic `payment` field, automatic membership-structure action |
| Trainee | `cba644ba-2704-41cc-b7f0-8fce3bb0bdd2` | Generic `payment` field, automatic membership-structure action |
| Student | `84df23c7-b148-45d7-8b57-c2e194c57ceb` | No payment field, no membership-structure action, null date-membership configuration |

Trainee's onward Junior branch already points to the authenticated Junior form.
No branch destination was replaced. After checkout adaptation approval, the
four paid copies were converted from generic `payment` to `membership_payment`
using explicit saved schedule mappings. Every authored class option had exactly
one current, member-scoped immediate annual schedule. Existing fields, rules,
pipelines, questions and due diligence were retained apart from the payment
field's type and schedule selection configuration. Continuing now requires
authentication and no longer has a signup role/member pipeline.

Further read-only schedule inspection found the active Student schedule
`57ba60c8-3703-4b2c-83ae-0cf7f0884cf8` configured as an immediate annual
`standard` term, with no end-date field. This does not match the documented
course-end-date Student policy. Converting its activation to date-based
membership would therefore require a schedule-policy/configuration change,
not just checkout adaptation. The task explicitly excludes changing membership
eligibility rules and approval processes; no such change has been made.

## Original checkout contract and adaptation

The paid forms use the generic payment route, not the history-aware
`membership_payment` route:

- `client/src/pages/FormView.jsx` detects `payment` fields and calls
  `useMembershipFeeQuote`.
- `client/src/lib/useMembershipFeeQuote.js` calls `/api/public/form-payment`.
- In `api/public/form-payment.js`, `resolvePayableCharge` resolves the
  membership structure from saved conditional actions. For individual
  memberships it calls `quoteMembershipForNewApplicant` with tenant, config
  and field overrides, not the authenticated member or historical predecessor.
- `api/_lib/membershipQuote.js` expressly computes new-applicant pricing.
- The separate `api/forms/membership-payment.js` and
  `api/_lib/formMembershipRenewalContext.js` implement history-aware renewal
  and post-grace reservations. Merely changing an entry link does not make the
  generic checkout use these protections.

The adapted paid branches use the existing history-aware membership checkout.
Saved mappings select the requested category without redefining the predecessor
or classifying a post-grace restart as a new applicant. Student's no-payment
application and required approval path are unchanged; course-date activation
was neither added nor claimed verified.

## Rollout and recovery

`scripts/configure-bnms-membership-entry.mjs` defaults to read-only planning.
Its write modes require the exact current snapshot/migration hash, tenant
serialization, locked form/config snapshots and setting revision comparisons.
It refuses to overwrite an already-changed joining or restart destination.
Do not rerun the completed installation as a rollback.

Recover from the retained before snapshot only through a separately reviewed
transaction: compare the current form values to the recorded after snapshot
and use the journey save functions with the current expected revisions.
Never restore memberships or rewrite journey history.

The forward migration was installed and service-only save/audit permissions
verified. `post_grace_checkout_ready()` returned true. Matching branch code
must reach the main app before claiming live post-grace route behavior.

## Verification limits

Evidence includes SQL before/after verification, a rolled-back transaction
rehearsal, source inspection, isolated routing/eligibility tests, mounted
payment-card tests and disposable PostgreSQL tests. No real checkout,
provider, email, submission or membership mutation was invoked.
Tests cover the independent destination,
revision conflicts, audit history, service-only saves, legacy-client
preservation, archived/expired destination rejection, inclusive window/grace
boundaries, missing evidence, recurring/paused/pending/successor suppression,
and first-purchase versus post-grace simulation.

The application starts, but the local preview returns “Tenant not found” from
its existing workspace database setup. The signed-in admin UI, real login
return and live authenticated four-state journey were not browser-verified.
The existing login path retains pathname and query in its encoded `returnTo`.
Fixture results are not live checkout or provider verification.
