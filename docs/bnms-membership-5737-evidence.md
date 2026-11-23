# Earlier BNMS membership recovery — applied

Verified and applied on 23 November 2026 to destination project
`lvmzliemqnieeoruhkik`, BNMS tenant `ff2df806-b321-4254-b651-3af11fccf1db`,
member `23b0f721-27ff-4840-93f8-20379e90e901`.

## Authority and refreshed evidence

The owner explicitly requested **6 October 2025–5 October 2026**. This is
coverage-date authority, not an inference from the September invoice date.

Fresh destination reads found exactly two histories. The older entry
`36d03663-c9e3-5cad-a630-53f0a4776f9f` had an unknown start, retained end
2026-10-05, no configuration/commitment, no amounts or payment timestamp, and
operator-attested paid status. Its original notes and import provenance are
retained verbatim under `originalNotes` and parsed under `originalProvenance`.

The historical invoice archive (also the source of historical invoice activity
in `MemberActivityTimeline`) independently identifies invoice 300004583,
£156, 2025-09-06, Full Membership Overseas, and the same provider UUID.
Its old status-error fields were not treated as fresh evidence or modified.

Xero tenant was independently pinned to `3d57dce6-2205-462f-abf6-9c7cbf00be23`.
The matched contact's email and legacy account number match the member.
The full name differs, so name-only matching was not used.

- Invoice **300004583**, UUID `e08f054b-bde5-4747-813a-303c57cb4f9c`.
- Both invoice-list and individual-invoice GETs confirm ACCREC, PAID, GBP,
  £156 net/total, £0 tax/due/credit, one Full Membership Overseas line.
- Independently fetched payment `3d8d9ed1-67fc-4c86-90b0-49e2bafa137f`:
  AUTHORISED, £156, **6 September 2025**, linked to that exact invoice.
- Valid provider PDF: 69,995 bytes.
- Complete paginated contact invoice list contains annual paid membership
  invoices from 2020–2026; there is only one 2025 invoice. The adjacent 2026
  invoice remains 300005516. No competing history allocation was found.
- No billing agreements, plans, quotes or successor elections for this member.

## Exact outcome

| Field | Before | After |
| --- | --- | --- |
| Older history ID | Existing | Same existing row |
| Coverage | Unknown start–2026-10-05 | 2025-10-06–2026-10-05 |
| Structure | Unknown | Current-class administrator reconstruction |
| Amount | Unknown | £156 net and total, £0 VAT |
| Payment date | Unknown | 2025-09-06 |
| Invoice | Unlinked | 300004583, verified Xero UUID |
| Original provenance | Original imported notes | Preserved verbatim and parsed alongside repair authority |
| Current term | 2026-10-06–2027-10-05 / 300005516 | Entire row unchanged |
| History count | 2 | 2, adjacent non-overlapping terms |

The structure maps Overseas Full to configuration
`1e82bb61-a0b3-4e6c-8bad-92cb527cd0ce`, named **2026-2027 Overseas full member**,
effective in 2026. It is explicitly labelled administrator current-class
reconstruction, **not an original 2025 purchase configuration**. Only identity,
selector and duration-related configuration fields were captured. Current
pricing did not supply historical amounts. Future renewal/access policy,
recurring consent and billing references remain unassigned.

## Transaction, replay and verification

`scripts/repair-bnms-membership-5737.mjs` defaults to `dry-run`; `apply` and
`verify` are explicit modes. Each refreshes destination and provider evidence.
It uses a separate reviewed manifest, not the prior insert-only repair runner.

- Serializable transaction, history-writer table lock, member owner lock,
  exact full-row before-image predicate and exactly-one-row assertion.
- Successful actual UPDATE rehearsal rolled back before application.
- Exactly **one UPDATE committed**, no insert or delete.
- Second `apply` refreshed provider evidence, recognized the exact repaired
  row and rolled back with **zero writes**.
- No trigger disabled, modified, or bypassed; no maintenance exception needed.
- Member, preferences, matching configuration, archive invoices, billing
  agreements, plans, quotes and elections checked unchanged before and after.
- The current history `586d4e57-598b-4dd2-ab9f-120f0be539a3` compared unchanged
  in full, including its original notes and invoice 300005516.
- 24 isolated plan tests passed (12 existing current-term tests and 12 older-term
  tests). Conflicts cover identity, coverage, mapping, settlement, detail
  mismatch, payment identity/date, competing allocation/invoice, duplicate
  history, changed current term and replay.
- Actual membership GET handler returned both records, with the expected
  reconstructed fields. Actual invoice handler returned HTTP 200 valid PDFs
  for inline and attachment modes for **both** invoices (69,995 / 69,464 bytes).
- Entire real renewal-context output compared equal before and after using
  the actual pricing simulator; current commitments and current-year cost
  compared equal too. Renewal remains review-required with no checkout.
- Mounted component suite: 17 passed, one unrelated private receipt test
  skipped. The new test rendered the actual refreshed payload and confirmed
  both date ranges, structure names, £156 amounts, duration, Paid labels and
  invoice-view controls without performing actions.

Private evidence, before/after manifests and receipts are in ignored
`generated-artifacts/bnms-membership-5737/` with restrictive file permissions.
The manifest is required for apply/replay; do not regenerate it from a repaired
row or substitute another member. No personal evidence is committed here.

### Reproduction

```sh
node scripts/run-isolated-tests.mjs node --test scripts/lib/bnms-membership-5737-plan.test.mjs
node scripts/repair-bnms-membership-5737.mjs verify
node scripts/verify-bnms-membership-5737.mjs after
node scripts/run-isolated-tests.mjs node --no-experimental-global-navigator --import tsx --test client/src/components/MemberMembershipTab.renewalPolicy.test.jsx
```

Handler verification uses explicit in-process test authentication and real
destination reads, not a signed-in browser session. The preview screenshot still
shows “Tenant not found” against legacy SOURCE. **Signed-in BNMS UI was not
visually verified.** No application auth was bypassed or changed.

No application deployment, member preference/role/login change, shared structure
change, invoice/payment mutation, subscription, checkout or email occurred.
Normal provider OAuth/quota maintenance is distinct from financial writes.
