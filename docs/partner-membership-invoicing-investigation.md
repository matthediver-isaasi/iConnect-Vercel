# Partner membership invoicing investigation

Read-only investigation on 2026-09-30 against verified production DEST project `lvmzliemqnieeoruhkik`. SOURCE was not used. No application code, schema, financial records, settings, workflows or messages were changed.

## Conclusion

The membership was **not created**. The workflow completed partially: its approval email and go-live-date update succeeded, but the membership INSERT failed with:

> new row for relation "organisation_membership_history" violates check constraint "organisation_membership_history_rolling_complete_check"

The invoice path is after the INSERT and was not reached. This is not an Automatic/manual setting skip, zero-due skip, missing invoice linkage, accounting-provider error, dry run, or an execution without a completion log.

The source reproduces a concrete compatibility defect: `membershipIncentiveSnapshot()` writes a partial `commitment_snapshot` for Year 1, including fixed-date structures. `workflowRollingCommitment()` returns an empty object for fixed-date structures, leaving that partial snapshot without a `term_key`. Production's constraint allows either no commitment metadata (including a NULL snapshot), or a complete dated commitment. This row shape satisfies neither branch. The live column defaults are NULL; the inspected rolling trigger returns fixed-date uncommitted rows unchanged.

## Scope and timeline (UTC)

- Tenant: Graduate Futures Institute / `gfi`, `fd82da65-aab7-4a5c-85b8-b2febeb2003d`.
- Organisation: **partner testing again**, `165e4f9d-4727-4108-9bb9-4995d9705544`.
- 09:26:10.035559: “Partner status set to Verified” completed successfully.
- 09:28:52.881602: organisation/year price override created: **GBP 1**, type `price`, year `2026/2027`. Its recorded update time is also before the incident.
- 09:30:40.646497: year-specific invoicing setting created: **automatic**, fees approved, no invoice date, PO or add-on lines. No fallback row was returned.
- 09:31:28.757693: “Partner set to Live”, workflow `49b92347-61e0-4060-b9de-95074991a51b`, execution `6fbf656c-5678-4c30-a8d0-527d691dba66`, completed **partial**. User confirmation is recorded as true. Actions: approval email success; custom field update success; create_membership failed with the exact constraint above.
- At investigation: no organisation membership history rows exist, including an organisation-only cross-check without tenant filtering. No membership ID, persisted payable amount, payment status, invoice linkage or accounting-error row therefore exists.
- Saved go-live date is `2026-09-30`; type is Partner. **Current application status is “Initial application”, not Live.** The two workflow logs do not explain who/what subsequently set that value; do not infer the current status from the workflow's name.
- Logs scoped to this organisation and its one currently associated member returned only the two executions above. Searching action results for the organisation ID found no further references. This cannot establish historical membership associations that have since changed.

## Amount and settings

Applicable current structure: `482d4f9e-40c8-4e1c-85fc-b035ae76d13b`, “2026/2027 Partner”; organisation-scoped Partner match; fixed-date annual cycle starting 1 August; GBP 950 flat annual price; pro-rata enabled; no free-period incentive or rollover; 20% VAT; nominal code 4020. Last recorded structure update: 2026-08-30, before the incident.

The saved GBP 1 price override replaces the annual price, clears custom discounts and **bypasses pro-rating** in the simulator (`isPriceOverride` branch). Expected charge: **GBP 1.00 net + GBP 0.20 VAT = GBP 1.20**. The 2026/2027 cycle is 1 August 2026–31 July 2027, with saved go-live date 30 September 2026. No approved add-ons exist. The non-chargeable discount and geographical VAT-exemption fields have no saved values. This is a **reconstruction from current saved inputs and source, not a recovered historical invoice or logged simulation**; the failed action did not persist its calculated amount.

Tenant fee approval is required; this year's setting is approved. Current accounting provider is Xero; invoice status setting is AUTHORISED; the structure nominal code overrides the tenant default 4000. No provider call was needed to establish the pre-invoice failure. Xero itself was not queried: this execution did not reach invoicing, but absence of a local invoice does not prove nobody created an unrelated/manual invoice in Xero.

## Expected invoice and follow-on behavior

`api/_lib/workflows.js` resolves year-specific mode before fallback/default Automatic, checks approval, dry run and existing year, then inserts membership history. Only a successful non-zero insert reaches provider resolution, address/nominal-code resolution, invoice creation, invoice-link persistence and the invoice-email helper. Successful zero-due creation settles locally and invokes the paid-event helper instead.

The saved Partner workflow contains exactly three actions and ends with create_membership. Its trigger is the organisation application-status custom field changing to Live, with Partner condition and user confirmation. There is no configured later Partner action or Partner paid workflow. The University “Organisation set to Live” workflow does not match Partner.

The tenant's only payment-status workflow is “Freelancer membership paid” (`642a6999-2651-45d2-9a0d-c79b898a6a05`): member entity, core payment_status changed_to paid, and Freelancer custom-field condition. It does not apply to this organisation. Invoice issuance alone is not payment: `membershipPaymentReconciliation.js` fires paid workflows after an actual transition to paid, and skips records without an invoice ID. No applicable follow-on failure was found; the membership action itself failed before any such event.

## Version and verification limits

The incentive-snapshot source change appears in local git history dated 2026-09-24, before this incident. Local source and the actual live constraint reproduce the invalid shape using isolated, credential-stripped Node assertions with the real two snapshot/commitment helpers. No live INSERT, even a rolled-back one, was attempted.

This establishes the current source/schema incompatibility, not the exact deployed commit. Vercel's project-list request through the configured connection returned 403 Not authorized; deployed revision and historical runtime payload were not obtained. No claim is made that a merge was already live. The production workflow log independently proves the INSERT failure and stage reached. The previously repaired missing organisation invoice call does not explain this execution.

The rejected row payload is not retained in workflow_log. Historical prices/settings cannot be proven solely from current values; their recorded timestamps support the reconstruction but are not immutable audit snapshots.

## Safe next action (separate approval required)

1. Fix the incentive-evidence storage contract for fixed-date Year 1 memberships, with disposable PostgreSQL tests using the production rolling constraint. Preserve original incentive evidence and all existing rolling/Direct Debit invariants. Prefer a dedicated incentive snapshot column rather than weakening commitment integrity; that approach would require a reviewed additive DEST migration. Do not simply remove the snapshot and lose future entitlement evidence.
2. Verify/deploy the corrected code and any chosen migration, then review only this organisation and 2026/2027 year. Check Xero for an existing matching manual invoice before creation; confirm the intended test price, VAT, original joining date and present application status.
3. Authorise a narrowly scoped membership/invoice recovery **without replaying the whole workflow**. Replaying it would resend the already-successful approval email and reset the go-live date. That changes joining evidence even though this price override currently bypasses pro-rating. Re-read history immediately before recovery to prevent duplicates.

The existing admin invoice-retry route cannot repair this case because it requires an existing history record ID. For other cases it checks admin/tenant access, existing invoice links, monthly-instalment suppression and Stripe provenance, but it is not a generally safe blind replay: it has no atomic invoice-creation claim, does not require failed sync status despite its comment, uses stored net fee with current nominal-code resolution/provider VAT defaults, and does not include the original add-on/email flow. An unlinked provider invoice must be excluded before any use. Likewise, a normal create-membership replay skips an existing year rather than repairing its missing invoice.

**Migration status at the original investigation:** none applied to DEST, SOURCE or any other database. No data changes, invoice creation, payment collection, email delivery or workflow replay were performed. No missing migration was established as the cause. The recommended dedicated incentive-snapshot fix would need a new migration, designed and approved as separate work; no migration had been prepared or applied at that stage.

## Subsequent authorised fix and schema rollout

The fix is now implemented locally: Year 1 incentive evidence uses a dedicated
`incentive_snapshot`, separate from complete rolling/Direct Debit commitments.
Rollover retains legacy evidence reads; narrowly recognized frozen legacy quotes
are translated only at the history-insert boundary without repricing or rewriting
saved quotes. Generic writes are guarded and the proposed migration makes the
dedicated evidence immutable after insertion. Manual and Specify date invoice
schedules are unchanged.

The additive migration was **applied and verified on DEST** on 2026-09-30
(verification completed by 18:55 UTC), using the pinned project
`lvmzliemqnieeoruhkik` and certificate-verified TLS. The first read-only preflight
identified Supabase default function grants; the separately authorised narrow
amendment explicitly revokes EXECUTE from PUBLIC, anon, authenticated and
service_role. No default privileges, table grants or RLS policies were changed.

- Migration: `supabase/migrations/20261116_membership_incentive_snapshot.sql`.
- Reviewed/applied runner SHA256:
  `8661a9d9be0947a60384552a66fc63635c316bef57b5fe16a655470f4f4dd4ee`.
- Both history columns verified nullable JSONB with no default; both immutable
  UPDATE triggers installed. Trigger function is invoker-security with pinned
  search_path and no direct EXECUTE access for PUBLIC or the three API roles.
  Disposable PostgreSQL tests prove that authenticated unchanged-snapshot
  financial updates still work without direct function execution privilege.
- All 19 existing history constraints remained validated and unchanged, including
  rolling completeness and overlap constraints. Existing triggers, table grants
  and RLS fingerprints were unchanged.
- Before/after full-row digests and counts were unchanged for member history
  (964), organisation history (363), billing agreements (391), payment plans
  (378), GoCardless reservations (1) and payments (6). No backfill or row updates
  were performed. The test organisation still has **zero** history rows.

The schema prerequisite is complete. The corrected application code still needs
the normal deployment/release process; schema application is not evidence that
the application fix has been deployed.

The original failed test membership has **not been recovered**. No invoices,
payments, emails, workflow replay or deployment were performed as part of the fix.