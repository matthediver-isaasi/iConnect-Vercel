# BNMS CPD Guest grace audit — read-only

Snapshot: **2026-11-03T18:07:21.748Z**. UTC date boundary: **2026-11-03**.

Verified production DEST project: `lvmzliemqnieeoruhkik`.
BNMS tenant: `ff2df806-b321-4254-b651-3af11fccf1db` (`bnms`).

| Role | Tenant-scoped ID |
| --- | --- |
| CPD Guest | `b640bd84-3d84-4cde-9f27-c3e80edb762f` |
| Former | `d536896d-b43a-4377-89ef-6c95f1496358` |

## Results

| Classification | Members |
| --- | ---: |
| Complete CPD Guest cohort | 2,389 |
| Supported expired-grace candidates | **0** |
| Review exceptions | 2,388 |
| No membership history or legacy expiry | 2,387 |
| Legacy expiry only, no applied policy | 1 |
| Excluded future-dated monthly-card term | 1 |

The two exception subcategories sum to 2,388, not additional members.
The excluded recurring history has a future term end, partial payment and a
cancelled agreement; this exclusion does **not** attest to current entitlement.
No renewal-grace cutoff was established for any candidate. A role name, legacy
member class or blank history is not proof of a lapsed paid membership.

## Boundaries and completeness

The extraction used a pinned destination connection with certificate validation,
one `REPEATABLE READ READ ONLY` transaction and `ROLLBACK`. The complete member
read has no pagination or LIMIT, has unique IDs and matches an independent
count. All cohort members have direct BNMS tenancy; the inherited-organisation
scope added none. Histories, agreements, expiry-policy assignments, relevant
organisation histories, amendment tables and discovered membership/expiry
preference fields were read in that same snapshot.

Grace is inclusive: only a verified cutoff **strictly before** 2026-11-03
would qualify. Fixed annual and reviewed historical policies use expiry plus
assigned grace; rolling upfront policies use the next-start anchor. Current
matching schedules and payment-arrears grace were not substituted. The actual
cohort contains no annual or reviewed historical history requiring calculation.

**Zero writes.** No roles, membership data, login permissions, billing,
automation or notifications were changed. SOURCE was not queried. Any future
correction requires separate explicit approval and a fresh read.

## Private deliverables and reproducibility

The full member-level HTML report and CSV are under the ignored
`generated-artifacts/bnms-cpd-guest-grace/` directory and delivered separately.
Member names and raw evidence must not be added to source control.

- Extraction: `node scripts/audit-bnms-cpd-guest-grace.mjs`
- Offline report: `node scripts/report-bnms-cpd-guest-grace.mjs`

The report generator deliberately asserts the observed evidence shape and
fails if the cohort gains different membership histories. It is not a general
role-correction engine. No application server or live handler is invoked.

Evidence SHA-256:
`1eac21147db019f8ad2c7316db8650be7804ba60eb7887d4843e788e8d2cb3a0`.
