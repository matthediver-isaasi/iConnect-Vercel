# BNMS synthetic renewal fixtures — 5 October 2026

## Result and authority

Exactly **five new members**, five class preferences and five current annual
membership histories were committed to verified DEST project
`lvmzliemqnieeoruhkik`, tenant `ff2df806-b321-4254-b651-3af11fccf1db`.
The tenant slug was independently read as `bnms`. SOURCE was not used.

These are **synthetic fixtures**, not evidence about genuine memberships,
payments, customer consent or provider settlement. The user explicitly approved
counterfactual 2025 terms using current configuration snapshots after being told
that the live structures only became effective in 2026. The original
configuration effective dates were preserved in the immutable snapshots; no
shared schedule was backdated or edited.

## Members and dates

All names below have first name `TEST_Renewal`. Both first and last names begin
`TEST_`. All amounts are GBP, VAT is zero, and the canonical pricing tier is
`Flat Rate` (no band). Payment classification is `manual` / `upfront`,
`payment_status=paid` **solely as synthetic test state**. `paid_at` and all
provider, invoice, quote and agreement references are null.

| Last name | Live member class / schedule | Amount | Current start | Current end | Renewal / successor start | Opens | Read-only status |
|---|---|---:|---|---|---|---|---|
| TEST_Full | Full / 2026-2027 Full member | £156 | 2025-10-15 | 2026-10-14 | 2026-10-15 | 2026-07-17 | Open; eligible_renewal |
| TEST_Full_junior | Full junior / 2026-2027 Full member junior | £128 | 2025-10-25 | 2026-10-24 | 2026-10-25 | 2026-07-27 | Open; eligible_renewal |
| TEST_Trainee | Trainee / 2026-2027 Trainee member | £61 | 2025-11-04 | 2026-11-03 | 2026-11-04 | 2026-08-06 | Open; eligible_renewal |
| TEST_Student | Student / 2026-2027 Student | £0 | 2025-11-19 | 2026-11-18 | 2026-11-19 | 2026-08-21 | Open; eligible_renewal |
| TEST_Associate | Associate / 2026-2027 Associate member | £71 | 2025-12-04 | 2026-12-03 | 2026-12-04 | 2026-09-05 | Open; eligible_renewal |

Renewals are +10, +20, +30, +45 and +60 days from execution. Every renewal is
the day after the saved current end. **No successor was created.**
Each history has a complete immutable rolling commitment, including the
configuration, pricing provenance, agreed amounts, annual duration, anchor and
term key. No legacy import attestation or genuine customer identifiers were used.

| Last name | Member ID | Reserved non-deliverable email |
|---|---|---|
| TEST_Full | `a1b2ad06-bcc0-561a-afe2-bab9fc35e12b` | bnms-renewal-20261005-1@example.invalid |
| TEST_Full_junior | `af0f079e-fdec-503a-a62d-e8195ffb9331` | bnms-renewal-20261005-2@example.invalid |
| TEST_Trainee | `4ae6ec46-9aed-5b46-a9a4-fa15f4fb7c66` | bnms-renewal-20261005-3@example.invalid |
| TEST_Student | `c2c73ebc-3b90-5c25-a724-fd1e7265432b` | bnms-renewal-20261005-4@example.invalid |
| TEST_Associate | `2a9554b5-6e32-59b3-aa5d-a18732593b69` | bnms-renewal-20261005-5@example.invalid |

Locate them in the **actual BNMS tenant's admin Members list**, searching
`TEST_Renewal` or the exact email. Open the member's membership/history section.
The workspace's default preview uses stale SOURCE and is not a verification
surface for these DEST records.

## Safety and testing limits

- Sign-in is disabled; role and organisation are null. No credentials, identities
  or invitations were created. Authenticated portal UI was **not verified**.
- `is_sample=true`, directory visibility is off and communications opt-out is on.
  These flags are not assumed to suppress all transactional messages.
- The only active tier reminder is restricted to a non-null role. A null-role
  fixture cannot qualify. Recheck this before changing reminder roles or assigning
  a login role to these fixtures.
- The live active workflow is `field_change`, not scheduled. Direct SQL creation
  did not invoke application record-create, paid or field-change workflows.
- There are no BNMS Zoho sync mappings, tier discounts or VAT overrides.
- No automatic/scheduled invoicing settings, payment plans, agreements, payment
  quotes, successor elections or reminder-send records exist for the five owners.
  No renewal runner, provider API, external invoice, mandate, subscription,
  invitation, outbound email or inbox-send operation was initiated.
- Database insert/update guards were inspected and left enabled. Standard member
  triggers queued regional automatic-group refreshes; fixture owners have no
  regional preference or organisation and match none of those regional rules.
  Those normal queue updates are additional trigger effects, not new billing
  authority or changed cron behaviour.
- No existing real member was directly updated. No existing test member was
  deleted. Shared prices, policy dates, renewal rollout and cron settings were
  not changed.
- These are real database fixtures, not a payment sandbox. Do not use them to
  exercise production provider actions. Their synthetic paid amounts must not
  be interpreted as genuine receipts.

The live tenant rollout function returned **true**, unlike the 4 October
readiness report. This setup did not enable it. Readiness is limited to current
persisted membership, schedule resolution and renewal evidence classification;
it is not authenticated checkout, browser or provider acceptance.

## Verification and reproducibility

Runner: `scripts/seed-bnms-renewal-test-members.mjs`.

- Verified SQL/REST destination pins and TLS CA/hostname verification.
- Serializable transaction, transaction-scoped advisory lock, collision checks,
  bounded lock/statement timeouts, policy drift checks and pre-commit journal.
- Dry-run inserted the exact batch with guards enabled and then rolled back.
- Apply committed 15 explicit fixture rows. The standard group-queue trigger
  updates described above are not included in this explicit row count.
- Readback compared every supplied member, preference and history field.
- Actual application `getConfigForMember`, `loadCurrentRollingCommitment` and
  `resolveRollingSuccessorConfig` performed read-only DEST queries: all five
  matched the persisted fixture/config identities.
- `classifyAnnualRenewal` returned `open` and
  `assessFormMembershipRenewalEvidence` returned `eligible_renewal` for all five
  against their persisted rows, without overriding rollout or policy.
- Replay made **zero writes** and verified exactly five members/preferences/
  histories, no successor and no collection authority.
- Three isolated tests passed, including date/price/scope fail-closed checks,
  deterministic identity and order-independent safety fingerprints.

The first replay rejected a safety fingerprint because unordered automatic-group
query rows were reordered by normal trigger updates. The fixture/config payload
was independently confirmed unchanged. Safety evidence collections are now
sorted before hashing; a fresh read-only replay review and apply replay both
passed without writing. No fixture was rewritten to address this check.

Initial committed manifest SHA-256:
`8d773638278bb2f3bce01b7d9097d8b5f71ab70ceb2355f6544a98ce7af56e8f`.

Order-normalized replay SHA-256:
`f9e09eca556966ee66c4dd15dee8e82abf3e6025384d9750968f3d0385f74643`.

Local audit files (0600, potentially ephemeral):
`/tmp/bnms-fixtures-dry-final.json`, `/tmp/bnms-fixtures-applied.json`,
`/tmp/bnms-fixtures-verified.json`, `/tmp/bnms-fixtures-replay-review.json`,
`/tmp/bnms-fixtures-replay-final.json`.
The runner is date-pinned to this approved batch and fails closed on a different
execution date. It is not a reusable tenant seed tool.

## Exact cleanup inventory — no deletion performed

Use the member IDs above and the following exact child IDs if cleanup is
separately authorised. Recheck dependencies first: later testing may create new
records that are not in this original inventory. Never delete shared configs,
preference definitions, role definitions, group rows or tenant settings.

| Last name | member_preference_value ID | member_membership_history ID |
|---|---|---|
| TEST_Full | `004f8f70-4284-53fc-a538-194932c8f5ab` | `88a8ef3d-c0d1-5f6a-a01d-b85519088374` |
| TEST_Full_junior | `67c146fe-a0c8-5d4e-a4d5-fb25887485bf` | `7e9254be-6b3e-5dec-ab9d-fda11081dddd` |
| TEST_Trainee | `171509e2-d27c-5a46-acdc-c1a86423b243` | `107a93a1-f300-5469-a9f9-970cf4605cc7` |
| TEST_Student | `958bdadc-07ab-54b2-a62d-e3d7560ebcd4` | `3fb039fd-561d-5396-a327-6c2d20ddfb04` |
| TEST_Associate | `e01d48e2-ec7a-50d3-a631-b573b202483d` | `a281626b-31a3-5b30-a483-2abf4d21d82b` |

## Migration status

**No migrations were needed or applied. None remain outstanding for this setup.**
Only fixture data was committed to DEST `lvmzliemqnieeoruhkik`; SOURCE and the
workspace runtime database were not changed.
