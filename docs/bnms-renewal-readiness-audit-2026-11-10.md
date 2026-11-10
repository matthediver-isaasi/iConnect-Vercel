# BNMS renewal readiness — 10 November 2026

## Scope and result

Read-only production snapshot: **2026-11-10 19:39:58.748610 UTC**.
Verified tenant `bnms`, `ff2df806-b321-4254-b651-3af11fccf1db`, in documented
destination project `lvmzliemqnieeoruhkik`, database `postgres`.
SOURCE/preview was not queried. No production writes, provider mutations,
reconciliation replays, charges, refunds, emails or configuration changes occurred.

All **4,080** existing member records have explicit classifications. Population
exclusions from active-member action totals: 2,513 guests/contacts, 481
inactive/former members, five explicitly flagged samples. Unknown classifications
remain included. Exclusions remain in the evidence and financial checks.
There are no organisation membership histories; organisation affiliation alone
does not establish organisation funding. Physically deleted records cannot be
reconstructed from this snapshot.

**124 non-excluded members** have at least one blocker/risk. **113** have an
application admission blocker: 94 expiry-only policy evidence gaps, 13 purchased
policy gaps, five current-agreement gaps, and one recurring commitment without
an agreement. These are evidence-review counts, **not debt or collection counts**.

Overlapping findings include:

- Payment card unavailable without a matched plan: 13 members.
- Other payment-details-unavailable projections: 123 members (109 non-excluded).
- Unfinished/reserved purchases: 14 members (10 non-excluded).
- Unsettled stored arrears: four members.
- Stored paid/confirmed instalments without invoice IDs: 25 payments / 24 members.
- Paid upfront histories without direct invoice links: seven members (three non-excluded).
- Historical membership invoices retaining unpaid/partial status: three members
  (two non-excluded).
- Linked failed/pending provider events: 344 members (340 non-excluded).
  These are retained event outcomes, not proof of current payment failure.
- 158 members reached pricing, which was deliberately not executed.

Primary classifications, mutually exclusive: 3,214 expected; 710 unresolved;
126 blocker; 15 risk; 12 accounting-only; three display-only. Individual issue
categories overlap; the private report provides all unique-member and occurrence
counts rather than summing overlapping totals.

## Evidence and access

Private outputs are in the ignored, mode-0700 directory
`generated-artifacts/bnms-all-renewal/`, with files mode 0600:

- `report.html`: dated evidence report, approval queue, completeness manifest and
  expandable member findings.
- `members.csv`: exactly one row per member, with UUIDs, classifications, linked
  history/agreement/plan references, reasons, impact, confidence and next actions.
- `evidence.json`: full classification results and unowned-reference checks.
- `snapshot.json`: minimised captured evidence, table hashes, metadata and capability definitions.
- `representative-checks.json`: representative raw-snapshot cross-references for
  all 23 observed issue codes.

No member contacts, bank details or credentials are included in the delivered
report/CSV. Member UUIDs allow authorised CRM lookup. Do not add these outputs
to Git, deployment assets or a public route.

Snapshot hash:
`6f3f27d1f221972be27b3cfa7f5d0d43512462dbe1f672f95bd0c71567b15192`.

Capture used one UTC REPEATABLE READ, READ ONLY transaction with bounded
500-row queries, count validation and unique member IDs, then rolled back.
All selected tables were accessible. No unowned references were found by the
member/plan checks. Captured evidence includes 886 personal histories, 404
agreements, 385 plans, 714 managed payments, 7,131 historical invoices, 41
instalment invoices and 2,367 imported provider payments.

## Verification and limits

The offline adapter rejects writes and unapproved RPCs. Its query filters,
pagination, missing-evidence failures, ownership boundaries, organisation display,
deferred collection and instalment semantics have fixture coverage.
Current Canvas and renewal-rule regressions also passed: 95 checks total
(86 existing and nine audit-specific).

The portal selector, matching-plan logic, pending-bank evidence, migrated mandates,
amendment overlays, dynamic collection price resolver and admission rules were
reused offline. Neither a self-only endpoint nor member impersonation was used.
The optional simulation dependency defaults to the existing application behavior;
the audit injects a stop before pricing. Existing helpers were only exported for
offline use; no portal wording or payment logic was changed.

Not verified: live provider/accounting balances or schedules, final renewal prices,
mapped form-specific choices, authenticated UI/role access, deployed-code parity,
or successful checkout. A module-initialisation role-overlay network attempt was
blocked by the audit network fence and was not used as evidence.
Missing/omitted evidence is not treated as a successful empty response.

No repair is authorised. Review individual references and obtain fresh, explicit
approval before policy assignment, date reconstruction, reservation release,
invoice creation/linkage, payment recovery, collection, or messaging.

## Reproduce

```sh
node scripts/capture-bnms-all-renewal.mjs --read-only-dest
node scripts/report-bnms-all-renewal.mjs
node scripts/render-bnms-renewal-report.mjs
node scripts/run-isolated-tests.mjs node --test \
  scripts/bnms-all-renewal.test.mjs \
  api/membership/canvas-summary.test.mjs \
  api/_lib/canvasRenewalEligibility.test.mjs
```

A fresh capture replaces local outputs and produces a new as-of snapshot;
preserve the private original before intentionally rerunning. Offline report
generation checks the saved hashes and does not contact production.
