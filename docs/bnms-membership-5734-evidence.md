# Single-member membership evidence — approved repair applied

Read-only inspection on 23 November 2026, destination project
`lvmzliemqnieeoruhkik`, BNMS tenant
`ff2df806-b321-4254-b651-3af11fccf1db`.

## Exact existing record

- Member: `23b0f721-27ff-4840-93f8-20379e90e901`.
- History: `36d03663-c9e3-5cad-a630-53f0a4776f9f`; the only personal history.
- Stored year: `2025/2026`; start unknown; end **2026-10-05**.
- Config, commitment, invoice references, amounts and paid timestamp are null.
- Paid status is an administrator attestation, not linked provider settlement.
- Original notes explicitly say `invoice_term_unconfirmed`,
  `unknown_not_inferred` for commencement and amount, and retained legacy expiry.
- No billing agreements, payment plans, payment quotes or successor elections.

## Refreshed provider evidence

Xero tenant verified as `3d57dce6-2205-462f-abf6-9c7cbf00be23`.
Contact email and legacy account number both match the member. Exact full-name
comparison differs, so the name alone was not used as identity authority.

Invoice **300005516**, UUID `be86600a-f39b-4a82-b659-5e5d536d8a4b`:

- Dated **6 September 2026**, GBP **156**, status **PAID**.
- One Full Membership Overseas line, £156 net, no tax.
- £156 paid, £0 due, £0 credited.
- Payment `523f9830-d836-462b-bb6c-e1da7ec1747a` independently fetched:
  AUTHORISED, £156, 6 September 2026, associated with this exact invoice.
- Invoice-list and individual-invoice reads both succeeded.
- Provider PDF fetched successfully and its PDF header verified.

The complete paginated invoice list for the matched contact contains seven
paid membership invoices, annually from 2020 through 2026. In particular,
**300004583** dated **6 September 2025** is also paid for **£156**.
No later invoice was returned for that contact. This does not prove coverage
dates, nor search for unrelated/duplicate contacts.

## Mapping authority and unresolved allocation

The saved `member_class` is **Overseas Full**. Its single matching configuration
is `1e82bb61-a0b3-4e6c-8bad-92cb527cd0ce`,
**2026-2027 Overseas full member**, effective from 1 January 2026.
This is a current member-class mapping, not proof of the original purchase policy.

The annual invoice pattern means the 2026 invoice may support a later term than
the existing 2025/2026 history. Linking it to that history without resolving this
would turn verified financial identity into an unsupported coverage claim.
Neither the annual start **6 October 2025** derived from retained expiry, nor a
successor **6 October 2026–5 October 2027**, is approved by this investigation.
The imported slash date does not itself justify changing the stored expiry.

At this investigation stage no membership writes had been made. The owner was
asked to confirm coverage; the approved resolution and application are below.

## Reproducibility and verification boundary

Run `node scripts/inspect-bnms-membership-5734.mjs` for a fresh read-only
destination snapshot and GET-only provider financial checks. OAuth refresh may
use the application's normal token-maintenance path; it does not write invoices
or payments. Detailed evidence is saved with restrictive permissions beneath
ignored `generated-artifacts/bnms-membership-5734/`; it is not committed.

## Owner approval and applied resolution

On 23 November 2026 the owner explicitly selected **6 October 2026–5 October
2027** as the term paid by invoice 300005516. The earlier generic “Approved”
was not used as date authority; a second explicit date selection resolved it.

This changes the original existing-row repair approach: the verified payment is
for a different cycle, so overwriting the existing 2025/2026 history would destroy
historical evidence. The approved term was recorded as a separate already-paid
history, not a newly sold membership or a future collection instruction.

| Evidence | Before | After |
| --- | --- | --- |
| Older history `36d03663-c9e3-5cad-a630-53f0a4776f9f` | Unknown start, end 2026-10-05 | Entire row unchanged |
| Approved current history `586d4e57-598b-4dd2-ab9f-120f0be539a3` | Missing | 2026-10-06 through 2027-10-05 |
| Current structure | No recorded structure | 2026-2027 Overseas full member |
| Current invoice | Unlinked | Xero UUID `be86600a-f39b-4a82-b659-5e5d536d8a4b`, number 300005516 |
| Current financial evidence | Missing history amount | £156 net and total, £0 tax, paid 2026-09-06 |
| Recurring billing | None | None |
| Future renewal/access policy | Not assigned | Not assigned |

The new row's notes identify owner-confirmed dates, current-member-class
structure reconstruction, independently verified Xero payment and the preserved
older row. Its snapshot explicitly identifies administrator reconstruction and
no future collection consent. It does **not** pretend to be original checkout
consent.

The mapped live structure includes future role-change settings. These were not
copied: only structure identity, selector and duration fields were captured.
Renewal opening/grace/access policy remains unassigned rather than borrowing
authority from today's structure. No member role, login flag or imported expiry
preference was edited.

## Transaction and final verification

`scripts/repair-bnms-membership-5734.mjs` supports `dry-run`, `apply`, `verify`.
Every run refreshes Xero identity, invoices, payment and PDF evidence, pins
destination identity, and checks the approved dry-run before-image.

- Dry run exercised the actual insert and database protections, then rolled back.
- Application used a serializable transaction, history-writer lock, owner lock,
  exact row-count assertions and unchanged-row checks. No trigger was disabled.
- Exactly one new history was committed. Existing history, member row,
  preferences, matching configuration, invoice archive, agreements, plans, quotes
  and successor elections were verified unchanged.
- Replaying `apply` found the exact existing row, verified it and rolled back:
  **zero duplicate inserts or updates**.
- Twelve isolated plan tests passed, covering identity, class, expiry, mapping,
  invoice, settlement, payment, competing-invoice and billing conflicts.
- The actual membership GET handler returned the current term, correct structure,
  £156 recorded amount and the approved dates against live destination reads.
- The actual invoice handler returned HTTP 200 and valid 69,464-byte PDFs for
  both inline view and attachment download, named for invoice 300005516.
- The real renewal-context loader returned `review_required`,
  `purchased_window_unavailable`, no simulation and no eligible checkout. This
  is intentional: this repair does not assign future renewal or access policy.
- Seventeen mounted component tests passed, including a test rendering the
  actual refreshed API evidence and retaining both history rows.

The handler checks use explicit in-process test authentication and real data,
not a signed-in browser session. The local preview returned “Tenant not found”
against its legacy database; the signed-in BNMS page was **not visually verified**.
No production application was deployed, no authentication was bypassed in the
app, and no invoice, payment, email, subscription or shared configuration was
created or changed. Normal Xero OAuth/quota maintenance is distinct from
financial writes.
