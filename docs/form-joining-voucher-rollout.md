# First-membership form credit

## Rollout

Applied to pinned external DEST `lvmzliemqnieeoruhkik` on 2026-11-07:

- `supabase/migrations/202701200001_form_joining_vouchers.sql`
- SHA256 `ffa0d0eb9963578bf93aba4eeed8596eaacdbdf487d3053e2c8e9728f58e718a`
- Runner: `scripts/apply-form-joining-vouchers.mjs`

Also applied the tested successor compatibility migration:
`202701200002_form_joining_voucher_successor.sql`, SHA256
`4835cb8bd9aef381fc6bad4b5bcd44014c6fb625b6d80f3762ed9e19ab999ccf`.
It allows a separately reserved, non-overlapping renewal while current monthly
instalments remain due, without releasing the first purchase's credit authority.
Run the same runner with `--successor` to inspect this migration.

The runner verified RLS, no anonymous/authenticated table access or RPC execution,
service-only binding/release, no direct service INSERT grant, and both competing
payment triggers. The new mapping table contained zero rows. No member data,
payments, voucher balances, provider operations or emails were created.
SOURCE was not changed. Matching application code still needs deployment.

## Contract

A first-purchase form checkout has its own server-owned mapping to a fee token,
not a fabricated predecessor or successor election. The selected simulation,
form, payment field and method are retained; the established voucher settlement
path handles allocations, cash remainder, monthly funding and accounting.

The mapping is unique per member while unreleased. An unresolved checkout cannot
be replaced just because the date, answer or pricing changes. Back may release
the mapping only after provider/credit cancellation is confirmed, or before
funding begins. Release does not cancel providers itself.

Conventional quotes and member monthly agreements serialize with binding.
Organisation-owned agreements remain separate. Funded monthly agreements must
reference the reserved token's actual settlement. Later renewals are allowed
after the first term has been paid and the new term starts after its end, or
through an independently verified successor election with matching dates.

## Verification

- New JavaScript tests: binding all methods, frozen schedule, cross-owner/form/
  field rejection, paused and released authority, saved-answer verification,
  settlement price/date preservation with no predecessor election.
- Disposable PostgreSQL: first-purchase and existing renewal bridge tests both
  pass. Includes concurrent adoption, direct-write denial, pending-payment
  fences, funded-provider exception and safe/idempotent Back release.
- Broader JS run: 67/69 passed. Two existing monthly-accounting recovery fixtures
  fail with `XERO_RATE_COORDINATION_UNAVAILABLE`; this feature does not change
  their accounting provider or rate-coordination code.
- A separate existing public member-start dynamic-DD fixture fails in
  `resolveMemberDynamicScopeRevision` because its database dependency is absent.
- No real Stripe or GoCardless payment or voucher redemption was performed.
- Local signed-in rendering is not verified: workspace tenant resolution
  continues to fail against its existing SOURCE configuration.

## Reproducible checks

```sh
node --test api/_lib/formJoiningVouchers.postgres.test.mjs api/_lib/formMembershipVouchers.postgres.test.mjs
node scripts/run-isolated-tests.mjs node --test api/_lib/formJoiningVouchers.test.mjs api/_lib/formMembershipVouchers.test.mjs api/_lib/membershipVoucherSettlement.test.mjs api/_lib/formMembershipRenewalContext.test.mjs
```

The migration is additive. Do not drop its mapping or guards after real
checkouts exist: their outstanding payment authority must remain reconcilable.
