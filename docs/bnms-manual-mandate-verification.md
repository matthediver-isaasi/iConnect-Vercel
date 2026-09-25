# BNMS manual-95 verification — 25 September 2026

## Outcome: verified unapplied; release blocked

No live adoption, schema, financial or provider writes were performed. No
deployment, cron configuration or SOURCE database changes were made. This is a
safe-stop report, **not** an executable approval or a claim of completed adoption.

### Destination evidence

At **2026-09-25T14:30:09.807Z**, the pinned DEST project
`lvmzliemqnieeoruhkik` was inspected through the existing verified-TLS connection
helper in a repeatable-read, read-only transaction. The tenant identity was
checked. Both workbook uploads have SHA256
`ddbc1a3d789e17ad78d507284b7823570e2f383fd5455f1e57a6a6e962f09d2a`.
The historical review's digest and exact 95-member scope were checked before
using its IDs to inspect current records.

- All 95 members exist; **0/95 have canonical agreements, plans or membership
  history rows**. None is proven adopted.
- The manual manifest, adoption and release tables do not exist. The manual
  invoice-operation table and manual SQL functions are also absent.
- The migration ledger has no matching entries for either required migration.
- All 10 workbook Alpha no-ops retain their expected agreement, plan and
  history links.
- Current prior-cohort adoption counts: Alpha 249, Beta 10, pilot 1.
  These counts and the no-op links are observations, not a claim that every
  historical field is unchanged since an earlier snapshot.
- No apply command was invoked to discover state.

Restricted, create-once evidence:
`exports/private-bnms-manual-verification-2026-09-25T14-30-08-201Z/`.
Canonical evidence SHA256:
`dd40f1b3ac2ec6bf3592d4078dc44d4184dee4ed4f8bb2817d1621a0084f0d6c`.
The repeatable audit is `node scripts/verify-bnms-manual-destination.mjs`.
It has no write/apply mode and does not retrieve provider data.

### Deployment gate

The user-supplied observation identifies deployment
`dpl_AwzVRbgSKuwozBawm8F3WEJEVtjL` at commit
`6573481244733abf96e7bfdd61c38f6aca995e01`. It remains user-supplied evidence:
the installed Vercel connector and existing Vercel secret both returned HTTP
403 for bounded project/deployment GETs, including team-scoped and unscoped
requests. No independently supported deployment timestamp was obtained.

Sanitized access evidence:
`exports/private-bnms-manual-runtime-verification/vercel-readonly-verification-20260925T142915Z.json`,
file SHA256 `d8210aedea8d90829fbbef349c32b99690515cbe830b626ffcae8ba600da0f18`.

Conditional source comparison across all seven required paths:

| Baseline | Aggregate runtime SHA256 |
| --- | --- |
| Historical reviewed | `8c489ba70df14b9e7dd0913b2365011096a95040e49e2f5c040cc9ef0dfa6743` |
| Supplied commit | `96be99b99d406abc99f0f599e96218481f4a1cb5cdb97865d84f4b3f7c840628` |
| Current workspace | `0e288fa6125400c7dd6850bfddc9cbf3d3a097fd58512a0d59a054efb696d3df` |

Six of seven supplied-commit paths match the current workspace; only
`directDebitDynamicPipeline.js` differs, with optional preloaded config/band/VAT
rows added locally. Six of seven supplied-commit paths match the historical
review: `xero.js` differs. That change uses provider-reported credit-note totals
and currency and adds an identity-checked GET evidence reader. It is not evidence
of an unsafe operation, but it invalidates the old exact runtime approval.

No compatibility baseline was approved or substituted. No hash validation was
weakened. No deployment-proof document was fabricated from local Git files.

### Required migrations

Both are required for adoption on **DEST only**, neither is present, neither
was newly applied, and both remain outstanding:

1. `supabase/migrations/20261121_bnms_dd_manual_95.sql`
2. `supabase/migrations/20261122_bnms_manual_invoice_operations.sql`

Do not install these separately merely to clear this report: the reviewed
runner expects atomic schema-plus-cohort adoption and rejects automatic reuse
of an independently installed empty schema.

### Checks and remaining gates

122 focused tests passed: the manual adoption/runtime-proof suites (4), plus
manual runtime, dynamic pipeline, membership presentation, console eligibility
and pilot accounting suites (118). Disposable SQL tests exercise atomicity,
ownership, October gate and accounting protections. These are local tests,
not production worker, live browser or invoice-delivery verification.

The earliest-processing rule remains **2026-09-30T23:00:00Z**, October 1 at
00:00 Europe/London. It is an earliest submission gate, not a guaranteed debit.

Before proceeding:

1. Obtain independently supported production worker/webhook/reader deployment
   evidence, including exact seven-file hashes, capabilities, destination and
   cohort scope, deployment/observation timestamps, verifier and reference.
2. Resolve the runtime differences through a reviewed reproducible compatible
   baseline, or seek separate authorization for deployment. Do not publish
   automatically.
3. Refresh bounded DEST/tenant-owned GoCardless and exact Xero contact/account
   evidence in new private files, preserving the no-invoice-retrieval waiver.
   Prior evidence is stale; no new reconciliation approval was produced here.
4. Independently review the fresh hash-bound manifest before atomic adoption.
   Then verify canonical links, all prior-cohort invariants, membership display
   and the original-journal zero-additional-write replay.

Fresh provider reconciliation and live replay were deliberately not run after
the deployment gate failed. No adoption means there is no new immutable apply
journal to replay. Neither adoption nor administrative membership recognition
would by itself prove bank collection, settlement or received invoices.