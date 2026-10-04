# BNMS assigned renewal policies — read-only readiness review

## Decision

**All 83 assigned members pass current renewal evidence admission as of
4 October 2026. No member-specific blocker was found. Renewal rollout remains
disabled and this report does not authorize enabling it or taking payment.**

Observed on verified DEST (`lvmzliemqnieeoruhkik`) at
**2026-10-04 20:31:29 UTC**, in one repeatable-read, read-only transaction.
The review covered the 72 newly applied assignments plus 11 existing assignments,
83 distinct members, and their complete tenant-scoped histories, agreements,
elections and upfront payment quotes.

## Blocker classification

| Admission condition | Result |
|---|---:|
| Assigned history/member/config binding valid in application loader | 83 / 83 |
| Current versioned import provenance and operator-paid attestation valid | 83 / 83 |
| Installed SQL expiry-only policy helper accepts current evidence | 83 / 83 |
| Actual application evidence assessment: `eligible_renewal` | 83 / 83 |
| Actual form context reaches pricing boundary in an offline gate-open assessment | 83 / 83 |
| Missing/deleted owners | 0 |
| Additional undated or overlapping histories | 0 |
| Already recorded successor histories | 0 |
| Billing agreements, including closed agreements | 0 |
| Paused memberships | 0 |
| Successor elections, including released elections | 0 |
| Existing upfront payment quotes | 0 |
| Missing/inactive/out-of-date assigned annual structures | 0 |
| Renewal window not yet open or already closed | 0 |
| Installed expiry-only capability | Available |
| Live BNMS and legacy global rollout | Both disabled |

The live application gate returns `joining`, `eligible: false`,
`renewalChoicesUnavailable: true` for all 83. This is the existing disabled-rollout
response, **not permission to purchase a new joining membership**.
All 83 have record-level evidence readiness; none has rollout/payment approval.

## Assigned cohorts and dates

| Assigned annual schedule | Existing | Newly applied | Total |
|---|---:|---:|---:|
| Full UK | 6 | 37 | 43 |
| Junior UK | 1 | 13 | 14 |
| Trainee UK | 0 | 8 | 8 |
| Student | 2 | 4 | 6 |
| Associate UK | 1 | 3 | 4 |
| Full Overseas | 1 | 5 | 6 |
| Associate Overseas | 0 | 2 | 2 |
| **Total** | **11** | **72** | **83** |

Expiry dates range from **23 September to 29 December 2026**. All are within
their inclusive expiry-minus-90 through expiry-plus-90 window on the audit date.
**12 are already past expiry but still in grace; 71 are not past expiry.**
Grace does not shift the successor start to checkout day: each successor starts
the day after its saved expiry and ends one calendar year minus one day later.
Historical commencement stays unknown. No historical amounts or payment
classification were inferred or changed.

The Full Overseas assignments use their approved immutable 90/90 policy;
the shared Overseas schedule was not changed. All six current Overseas
assignments pass the application and installed SQL policy checks.

## Method and authority

Inputs:
- `reports/bnms-approved-renewal-policies-applied-2026-10-04.md`
- `reports/bnms-legacy-renewal-schedule-approval-2026-10-04.md`
- `guides/membership-form-renewal-choices.md`

Runner: `scripts/audit-bnms-renewal-readiness.mjs`.

```sh
node scripts/audit-bnms-renewal-readiness.mjs --read-only-dest
```

The runner pins SQL and REST destination identities, uses verified TLS, requires
explicit read-only opt-in, and checks `transaction_read_only=on`. It reads all
rows for the 83 members without REST pagination limits. It verifies the signed-off
approval report hash and each of the 72 exact history/config/expiry mappings.

Current provenance is evaluated by `hasFormExpiryOnlyProvenance`; assignments
are reloaded by `loadExpiryOnlyRenewalPolicy`. The actual
`assessFormMembershipRenewalEvidence` and `loadFormMembershipRenewalContext`
consume an in-memory adapter over this SQL snapshot. One adapter preserves the
live disabled gate; a separate explicitly hypothetical adapter returns an open
gate **in memory only** to expose downstream admission blockers. Its simulation
callback stops execution at the pricing boundary. No simulated price or
fabricated quote is used as evidence.

The installed read-only `form_expiry_only_renewal_policy` SQL function was called
for all 83 histories. The installed `reserve_membership_successor` definition
was inspected, **not executed**. Its expiry-only provenance, exact config,
annual boundary, overlapping history, agreement, election, purchased-window,
same-start history and existing checkout guards were considered against the
snapshot. There are no other histories, agreements, elections or quotes for
these owners, so the conflict branches have no matching rows.

This is not an atomic reservation rehearsal. No lock-taking/writable
reservation RPC, payment attempt, provider API, pricing simulation, form
submission, consent, email or financial commitment was created.

## Evidence and limitations

Private row-level evidence, containing all 83 assignment/history/member/config
bindings, computed windows, admission outcomes and installed function
definitions, is saved locally at:
`private/bnms-renewal-policy-2026-10-04/readiness.json`
(directory mode 0700; file mode 0600; git-ignored).
No member names, email addresses or provider credentials are included in this
public report.

- Current scoped snapshot SHA-256:
  `be5c5c15fcfaa4a5ff70278613940f7f50bd5468276fe160924a5bde9798ab29`
- Inspected function set SHA-256:
  `e2d54493f3c71915c0bb31e57bce593ce5050f935e46e23eb6912a603e74dd87`
- Installed assignment guard SHA-256:
  `bde4771e9cb420e2321464be4bcf3f89fca789c97e0de217ec3ac194ad39754a`
  — matches the prior application report.

The earlier private application plan was not present in this task workspace.
Therefore this review verifies **current** provenance and approved mappings,
not byte-for-byte equality with the earlier full historical/member snapshots.
The original source hashes have the required format and provenance authorities;
the underlying original import files were not independently re-audited.
Provider settlement remains an administrator attestation, not provider proof.

Pricing, provider availability, deployed application version and authenticated
browser/provider acceptance are **not established** by this evidence review.
No UI was changed or verified. A successful reservation would still need the
real payer, server-generated price/quote, supported payment method and a fresh
atomic recheck at payment time. This snapshot must not be reused as durable
checkout authority.

## Next decision and migration status

- **No data remediation or reassignment is indicated by this review.**
- Complete the separately governed rollout acceptance checks in the guide,
  then request explicit BNMS-only rollout authorization. Do not enable rollout
  or perform financial operations based on this report.
- Recheck current admission immediately before any separately approved rollout;
  agreements, pauses, elections and time windows can change.
- **No migrations were needed or applied in this review.** The previously
  installed DEST expiry-only capability is present. No migration remains to
  apply for these 83 assignments. SOURCE and the workspace runtime database
  were not accessed or changed.

## Local verification

All **27 isolated tests passed**:

```sh
node scripts/run-isolated-tests.mjs node --test \
  scripts/audit-bnms-renewal-readiness.test.mjs \
  api/_lib/formMembershipRenewalEvidence.test.mjs \
  api/_lib/formExpiryOnlyRenewal.test.mjs
```

Audit fixtures verify that pause, invalid provenance, undated/overlapping
histories, agreements, elections, expired structures, closed windows and missing
capability remain blockers; the live gate stays disabled and the snapshot is
unchanged. The adapter has no write methods and rejects reservation RPCs.
`git diff --check` passed. Private evidence ignore rules and 0700/0600 permissions
were checked. These local tests complement, but do not replace, the live
read-only database observation above.