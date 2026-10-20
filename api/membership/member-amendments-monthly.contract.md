# Monthly amendment adapter contract

Owned implementation: `api/_lib/memberAmendmentMonthly.js`, provider implementation and isolated tests with the same prefix. No routes, database writes, migrations or original purchase edits are performed by these modules.

## Integration

`createMemberAmendmentMonthlyService(deps)` exposes `quote(input)`, `prepare(input)`, `apply(prepared)` and `reconcile(prepared)`. `quote` and `prepare` perform provider reads; neither writes. `prepare` returns a JSON-serializable, fingerprinted operation. Only `apply` writes. Persist the complete prepared operation **before** calling apply. Never accept a prepared operation or authority from a browser.

Input contains server-loaded `tenantId`, `memberId`, `purchase`, `agreement`, `plan`, an immutable server-owned `authority` (described in source), and `amendmentId`, `effectiveDate`, `target` (integer minor-unit economics; existing Stripe price ID for card). Core must authorize actor/payer, resolve exactly one current personal purchase, lock that purchase/plan and exclude concurrent amendments, collections, recovery and cancellation. Re-read under that lock before preparing/applying. The adapter checks tenant/member/purchase/agreement/plan/mode/provider linkage against its authority and the actual provider objects. Missing authority is an error, not permission to infer it from current member fields or editable configuration.

Authority must bind the purchase, agreement and plan IDs, provider, environment, payer ID, term key, purchased terms hash (`monthlyAmendmentFingerprint(agreement.metadata.card/dd)`), pricing basis (`annual_instalments` or `monthly_price`), currency, finite end (epoch seconds for card), and immutable `collectionDates` (date-only billing dates for the term). It must be produced from immutable purchase/consent evidence, not new mutable config. For annual instalments target must provide the separately approved revised whole-term obligation `termTotalMinor`; remaining instalments are derived after retaining every generated/submitted payment. A monthly amount alone is not annual debt authority. For true monthly pricing `amountMinor` is prospective only; no day-proration is inferred.

Results distinguish provider acceptance from local completion. `{status: 'provider_applied', ...}` means provider evidence was verified; core still needs to atomically append entitlement/financial revision and settle its durable operation. `{status: 'uncertain', ...}` forbids a new operation/key or automatic repeat; run read-only reconcile. Reconciliation may return `provider_applied`, `not_applied` or `uncertain`; `not_applied` is not permission to retry a timed-out write (it may still be processing).

## Required core/migration work

- Immutable authority plus append-only financial/entitlement revisions, preserving the source purchase and consent snapshots.
- Durable operation row with unique tenant/amendment/provider key, full prepared JSON and fingerprint, state, provider result, attempts, timestamps and reconciliation evidence. Claim/lease and finalize RPCs with purchase/plan locks and one in-flight operation.
- Atomic per-plan collection/recovery/cancellation hold honored by *all* submission paths before prepare/apply; keep held while provider outcome is unknown or local finalization fails.
- Finalization must not mark failed writes successful or mutate historical invoices, payments, reservations, purchase prices or agreed commitment terms.
- Dynamic DD amendments require an effective-dated, append-only pricing/scope revision resolver in `directDebitDynamicPipeline.resolveDynamicCollectionPrice`, with the revision pinned by `reserve_gocardless_dynamic_collection` under the same plan lock. Existing/submitted reservations retain their price snapshot. Until this is wired, dynamic DD apply deliberately fails closed (`dynamic_revision_required`); merely updating plan amount or consent metadata does not work because today's collector resolves against original purchased scope.

## Supported boundaries / fail-closed cases

Card supports an existing active owned finite, single-phase monthly schedule, split only at a future **original billing boundary**, using an existing verified monthly Stripe price. It preserves the current phase and finite end/cancel behavior and disables proration; it never creates/releases/cancels a subscription or schedule. Complex schedules, taxes/discounts/trials/add-ons/metering and ambiguous ownership fail closed rather than being dropped.

Fixed GoCardless supports prospective amount-only changes to an active owned finite monthly subscription when its next ungenerated collection exactly matches the effective date and provider notice date allows it. Generated payments (including pending/submitted) remain fixed. No count/end-date, payment cancellation, mandate or payer changes are made. Nonuniform remaining annual instalments, arrears/failed payments and unexpected upcoming dates require finance review.

Fixed DD additionally requires the provider's returned upcoming-payment list to cover all remaining purchased dates; providers that truncate that list fail closed. Acceptance is confirmed only when all upcoming amounts/dates match, not simply when the subscription headline amount changes. The GoCardless operation is an absolute amount-only PUT; do not assume the provider gives POST-style exactly-once semantics to a PUT idempotency header.

Card paid invoice evidence is checked through the current Stripe SDK invoice-payment API and its successful captured, nonrefunded/nondisputed PaymentIntent charge. Split/external/credit-balance payments or unresolved invoices fail closed.

Dynamic DD inspection verifies the actual mandate/payer/mode and submitted payments, but provider apply is unsupported until the core revision/reservation bridge above exists. No silent fallback to a fixed subscription or replacement agreement.

Production clients are resolved lazily from the project's tenant Stripe credential reader and GoCardless client. Tests inject clients/readers; no live calls are needed. Provider reads are fully paginated. Provider API errors in inspection throw; errors after a write begins are deliberately classified uncertain.
