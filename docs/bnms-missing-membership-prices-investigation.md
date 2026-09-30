# BNMS missing membership prices: read-only findings

Investigation date: **30 September 2026**. All times below are **UTC**.
Database observations began at 06:05:35; direct provider observation was at approximately 06:06:34. This is a point-in-time investigation, not a promise about subsequent activation.

## Conclusion

**The member completed authorisation. The mandate is awaiting bank submission/activation, not missing.** The fulfilled webhook was processed successfully, the member and membership history were created, and the mandate was attached to the correct agreement. GoCardless itself currently reports `pending_submission`.

**£13.00 GBP per month is retained as the signup price.** It is not a confirmed future charge or a fixed annual commitment. The linked structure still contains £13.00 monthly pricing; no independent member simulation was run, so this is not represented as a newly resolved current-price estimate.

The missing fixed annual total is intentional for this dynamic agreement. The missing collection amount/schedule is explained by the absence of an active mandate and payment plan. The display does not expose the available historical signup price separately from current collection evidence. This is a presentation limitation, not demonstrated loss of financial data or failed provider completion.

## Target and evidence boundaries

- Requested member: `bb33ed5e-4495-4b55-a64f-1f917fd484a8`.
- Verified DEST Supabase project: `lvmzliemqnieeoruhkik`; bounded SELECTs used its project-specific SQL connection. The provider-read bootstrap independently pinned the DEST REST hostname. No SOURCE reads were used.
- Exact deployed host `https://bnms.dev.iconn.app/api/public/tenant-branding` returned BNMS, slug `bnms`, tenant `ff2df806-b321-4254-b651-3af11fccf1db`, matching the member and all scoped local evidence. DEST's tenant domain is `bnms.org.uk`; the supplied development-branded host resolves to the same tenant.
- The original form's retained GoCardless context matched the enabled tenant-owned credential set, including environment, source, tenant and account fingerprint. The agreement environment is **live**. No platform fallback or alternate account was used.
- Direct provider reads were only GETs for the exact retained billing request and its linked mandate. No tenant-wide discovery, payment listing, reconciliation or recovery was invoked.
- Names, email addresses, bank details, tokens, fingerprints and full submission answers are omitted.

### Correlation references

| Record | Identifier |
|---|---|
| Form submission | `342b858c-fe3b-466a-baea-d573d7263b98` |
| Billing agreement | `ed7db7ce-f79e-4cbe-a28f-04116feb3955` |
| Membership history | `5806e454-e252-4cde-a1b3-3077c0d47fe1` |
| Pricing structure | `07f35246-907a-411d-be78-2b3a9587ce3a` |
| Billing request | `BRQ01M3RBW5D76D2SPKNMD9YZSD9D` |
| Mandate | `MD01M3RBXCRFMFY262Q9FG1PPPPR` |
| Fulfilled event | `EV1K8SADTNBKPK` |

## Chronology

All events are on 30 September 2026.

| UTC time | Evidence |
|---|---|
| 05:16:23.837 | Form submission created, with monthly Direct Debit provider. Retained payment amount £13 GBP. |
| 05:16:23.967 | Agreement DD snapshot `accepted_at`. This is application-recorded consent time, not proof of bank activation. |
| 05:16:24.151872 | Billing agreement created. |
| 05:16:24.357 | Billing request created, confirmed by direct provider GET. |
| 05:16:24.582 / 05:16:26.604 | Provider events record flow creation and visit. |
| 05:16:47.535 / 05:16:57.173 | Provider events record customer details and bank-account collection. |
| 05:17:04.297 | Provider event records payer details confirmed. |
| 05:17:04.653 | Mandate created, confirmed by direct provider GET. |
| 05:17:04.725 | Provider fulfilled event generated. |
| 05:17:15.497991 | Fulfilled webhook received locally. |
| 05:17:16.816779 | Status audit records `payment_setup_required` → `mandate_pending`, reason `billing request fulfilled`, source `webhook`, linked to that event. |
| 05:17:24.202920 | Member created. This is a new form signup; no migration-cohort assumption was used. |
| 05:17:32.042 | Form entity processing completed. Current monthly-DD processing state is `done`; form payment state is `setup_complete`, not paid. |
| 05:17:34.092404 | Membership history created and agreement updated. History is `pending_payment_setup` / `unpaid`, term 2026-09-30–2027-09-29, renewal 2027-09-30. |
| 05:17:38.063 | Fulfilled event marked processed, with no processing error. |
| 05:17:38.822 | Mandate-created event marked processed, with no processing error. |
| ~06:06:34 | Original-context provider GET: billing request `fulfilled`, linked mandate `pending_submission`, Bacs scheme, next possible charge date 2026-10-06; billing request has no linked initial payment. |

The eight matching retained webhook events contain no active-mandate event. The six informational billing-request actions were intentionally marked skipped with `ignored ... action=...`; these are not processing failures.

## Price and collection evidence

- DD snapshot: `monthly_amount=13`, `monthly_amount_minor=1300`, currency GBP; historical snapshot also retains monthly amount 13.
- Policy: dynamic pricing, continue collections, earliest first collection, mandate-only authorisation, activation on **first payment**.
- The snapshot and history deliberately have null `final_cost` / `total_with_vat`; `plan_total` is null. The retained annual structure price is £156 and nominal instalment count is 12, but neither establishes a £156 annual debt under this dynamic policy.
- Current linked structure remains active, effective from 2026-09-01, unchanged since 2026-09-21, with £13 monthly pricing. This is corroboration of the retained offer, not a confirmed collection or a fresh eligibility calculation.
- Exact agreement has **zero payment-plan rows** and **zero collection reservations**. Exact mandate has **zero local payment rows**. No confirmed collection amount/date is retained.
- **6 October is the provider's next possible charge date, not a scheduled payment date.** No future charge or eventual activation date can be promised from this evidence.
- Local mandate mirror says `created`, while provider says `pending_submission`. The mandate-created webhook maps its action to `created` in `gocardlessWebhookProcessor.js:656–673`. Both are pre-active states; this difference does not explain a missing active collection plan.
- Agreement has no attention flag/reason. The form has no retained `gc_reconciliation` diagnostic. Absence of a diagnostic alone is not proof of success; provider GET and processed fulfillment establish completion here.

## Actual source path and display behavior

The actual origin is **form monthly Direct Debit**, evidenced by the agreement's form-submission linkage and form provider `gocardless_monthly_dd`, not a direct invocation of the member-facing start endpoint.

1. `api/_lib/gocardlessWebhookProcessor.js:374–532` attaches provider identity, transitions to mandate pending, finalizes a form-backed agreement, and only calls active monthly processing if the mandate is active/reinstated. `processActiveMonthlyAgreement` at lines 156–167 creates the plan and applies activation policy. No active provider state exists here yet.
2. `api/_lib/formMonthlyDirectDebitFinalize.js` finalizes the form and binds the member. Live form processing is `done`, and membership history references the same agreement.
3. `client/src/components/MemberMembershipTab.jsx:778–786` reads `/api/membership/member-membership`. In that endpoint, `agreementMatchesHistory` validates tenant and personal owner; live history and agreement match and have no organisation owner. There is no mismatched plan: none exists.
4. `api/membership/member-membership.js:179–188,289–292` deliberately clears dynamic fixed agreed/net/monthly amounts. This explains “Uncommitted”, without implying lost signup data.
5. `api/_lib/membershipHistoryPrice.js:86–101` recognizes dynamic policy and requires a matching ongoing plan before deriving a current monthly price. `mandate_pending` is allowed, but the missing plan stops enrichment. It does not reuse the historical £13 quote as a current charge.
6. `api/_lib/gocardlessCollectionDetails.js:99–104` returns directly when no plan exists. Its state shaper adds “awaiting an active mandate” for pending agreement statuses (lines 25–29); there is no provider payment or reservation amount to show.
7. `api/_lib/gocardlessCollectionScheduleChange.js:28–33` returns unavailable schedule evidence without a plan. This is appropriate here.
8. `membershipPricingPresentation.js:80–84` labels unavailable dynamic evidence “Variable monthly price unavailable”. `DirectDebitCommitmentDetails.jsx:33–45` displays collection amount and any separate current-price preview, but not the retained signup price.

**No creation, association, or reconciliation defect is demonstrated.** The presentation limitation is that “monthly price unavailable” does not explain that the historical signup price is known while a collectible current amount is not yet established.

## Smallest recommended follow-up — separate approval

Add a read-only display of **“Monthly price at signup: £13.00 — variable, not a confirmed charge”**, sourced only from the tenant/owner-validated immutable agreement snapshot. Keep this separate from current estimates, annual commitments and provider-scheduled collections. For evidenced completed authorisation, clarify **“Authorisation completed; awaiting bank activation”** rather than implying that the payer abandoned setup.

Do not write £156 into annual totals, manufacture a schedule from the earliest-charge date, force activation, create a plan early, replay this successful webhook or ask this member to authorise again on current evidence.

Verification for the proposed display change:

- Pending mandate with retained signup price and no plan: show historical price separately; keep collection/schedule unavailable.
- Unfinished authorisation, unknown provider evidence, mismatched owner/tenant or missing snapshot: never claim completion or borrow another record's price.
- Active dynamic plan/current estimate/provider-scheduled payment: keep those amounts and dates distinct from signup pricing, including when prices differ.
- First-payment activation and fixed-price memberships remain unchanged; no read triggers provider or database mutations.

Normal future active-mandate processing is expected to create the dynamic plan. If a later verified active mandate has no matching plan, investigate that later event and its processing result before proposing recovery.

## Limitations and change statement

The authenticated deployed Membership API response and browser session were not available; the report combines live scoped data, original-context provider GETs, exact-host tenant branding, and workspace source tracing. It does not establish exact deployed frontend/source revision parity or future processing success. No historical Vercel runtime logs were fetched; existing webhook/status/form diagnostics were sufficient for this observed state. No provider-wide search was performed, so local zero-payment counts are not presented as a provider-wide payment audit.

**No member records, provider resources, collections, invoices, messages or configuration were changed. No sync, reconciliation, webhook replay or repair ran. No migrations were applied to any database.** The proposed display-only correction appears to need **no migration and no data repair**. Any later recovery would require separate approval and new evidence.