# Direct Debit plan-total evidence — task 4699

Read-only checks were made against verified production DEST on
**2026-09-22 19:43–19:44 UTC**. A separate unauthenticated host check was made
against the exact BNMS development host at **19:44 UTC**. No database writes,
provider requests, deployments, promotions, collection releases, or membership
changes occurred.

## Production DEST findings

The existing aggregate-only runner
`node scripts/reconcile-bnms-dd-console.mjs` used its pinned destination
connection and tenant identity in a repeatable-read, read-only transaction,
ending in rollback. A second bounded aggregate query used the same connection
and transaction controls to join canonical adoption rows to the administrative
recognition ledger. No member-level data left the database.

A follow-up bounded, read-only evaluation then ran the application's actual
console eligibility and membership-presentation functions against verified
DEST, with the evaluation date fixed to **2026-09-22**:

- `filterDirectDebitRows(..., { plans: true })` applied the same provider,
  agreement, tenant, owner, and anonymised-member exclusions as the console.
- `loadDirectDebitMembershipPresentations(..., '2026-09-22')` loaded **all**
  personal membership-history rows for the tenant, attached recognition rows,
  selected the current commitment from every history row belonging to each
  plan owner, and applied the owner pause state and canonical adoption evidence.
- Only aggregate cohort, display-status, and evidence-source counts were
  emitted. The bounded reads returned 282 raw plans and 260 eligible plans; no
  member-level values were output.

| Canonical cohort | Adopted plans | Intact canonical links | Current recognition rows | Deleted/missing members |
|---|---:|---:|---:|---:|
| Alpha | 249 | 249 | 249 | 0 |
| Beta | 10 | 10 | 0 | 0 |
| Pilot | 1 | 1 | 0 | 0 |
| **Total** | **260** | **260** | **249** | **0** |

The exact presentation result for **2026-09-22** was:

| Canonical cohort | Console display status | Presentation evidence | Plans |
|---|---|---|---:|
| Alpha | `current` | `administrative_recognition` | 249 |
| Beta | `membership_unverified` | none | 10 |
| Pilot | `membership_unverified` | none | 1 |
| **Total** |  |  | **260** |

The answer to the reported `260 total` versus `249 current` difference is
therefore exact for that evaluation date: the remaining **11 displayed plans**
are the **10 Beta** adoptions and **1 pilot** adoption, all in the
`membership_unverified` display bucket. This conclusion comes from the same
membership-presentation logic used by the console, including every history row
for each owner; it is not inferred merely from adoption-cohort sizes or the
absence of Beta/pilot recognition rows.

All 249 current recognition rows are unrevoked, within their effective date
range, and exactly linked to their Alpha member, agreement, plan, and history
records. Beta and pilot have no rows in the Alpha recognition ledger and,
after all of their owners' histories were evaluated, no alternate qualifying
current history displaced their canonical unverified-import presentation.

“Current” here means the separately authorised, date-bounded administrative
membership recognition used by the Direct Debit presentation logic. It does not
mean that a plan has an `active` financial lifecycle status, that a payment was
collected, or that collections may be released. None of the three adoption
cohorts has an `active` **adoption-linked** membership-history row. This narrower
linked-row observation is supplementary; the exhaustive owner-history
presentation evaluation above is the evidence for the 249 current / 11
unverified buckets.

The raw tenant ledger has **282** plans at this later snapshot:

- GoCardless: 263 first-payment-pending (4 linked to anonymised members), one
  active (linked to an anonymised member), and one mandate-pending.
- Stripe: 17 active, all linked to anonymised members.

Applying the console's existing GoCardless-only and anonymised-member exclusion
still yields **260 eligible plans**: 259 non-anonymised
first-payment-pending plus one non-anonymised mandate-pending. This agrees with
the 260 canonical adoption rows. Raw ledger rows must not be deleted or rewritten
to force the displayed totals to agree.

All Alpha and Beta plans remain first-payment-pending. Their 259 collection
stops and release-required flags remain present. The pilot remains a distinct
lifecycle case without those two flags; this report does not justify changing
it.

## Exact BNMS development host and deployment limitation

`https://bnms.dev.iconn.app/DirectDebitAdmin` returned HTTP 200 from Vercel and
served `/assets/index-kuIqZfcJ.js`. At the same observation time,
`https://dev.iconn.app/DirectDebitAdmin` served the same bundle name. This proves
the public HTML/bundle association observed for the exact BNMS development host;
it does not prove the behavior of an authenticated admin session.

An unauthenticated request to the exact host's Direct Debit summary endpoint
returned HTTP 403 with `Admin access required`, as expected. No authorized BNMS
admin session was available, so the rendered 260/249 totals, status drill-down,
and list contents were not verified in the deployed console.

The available Vercel credential returned HTTP 403 for the pinned project's
project, alias, and deployment-list reads. Consequently, the current deployment
ID, Git commit, READY state, and branch-to-alias assignment could not be
independently refreshed. Older repository evidence identifies this Vercel
project and the `*.dev.iconn.app` mapping, but that historical record is not
treated as current deployment proof. No deployment or configuration change was
attempted.

## Evidence boundary

The database evidence verifies the eligible-plan total, exact presentation
buckets for the fixed 2026-09-22 evaluation date, and their aggregate cohort
composition. It does not establish what an authenticated browser rendered on a
deployed build. The public host evidence verifies reachability and the observed
bundle name only. Until an authorized Vercel metadata read and an authenticated
BNMS admin check are available, do not claim that the relevant console
implementation is deployed or that its displayed drill-down behavior has been
verified live.