# Member Auto Archive: implementation and rollout

## Scope and current deployment status

The lifecycle configuration, preview approval, scheduler, review, archive/restore
and confirmed profile-disposal paths are implemented. **No live migration,
deployment, tenant enablement, member processing or provider send was performed.**
Installation and publishing alone do not enable a tenant.

`/MemberLifecycle` uses the existing Role Management hierarchy. View, configure,
review, archive, minimise and delete are separate capabilities. Sensitive member
role capabilities default to denied; existing tenant-user administrator semantics
remain unchanged. Menus are not automatically changed for live tenants.

## Operator sequence

1. Obtain explicit approval to apply the destination migration. Run
   `node scripts/apply-member-lifecycle-preparation.mjs` offline to inspect the
   migration list and current bundle hash. Its guarded apply mode requires
   `--apply --review-sha256=<exact-reviewed-hash>`, pins the external DEST target
   and installs the entire bundle in one transaction. Do not run it from startup
   or deployment scripts.
2. Publish the corresponding code and confirm all serving versions contain the
   login-evidence producers, lifecycle session gates and operational exclusions.
   Do not certify historical coverage while old deployments still serve logins.
   Confirm the existing production cron secret is configured without displaying it.
3. Grant appropriate existing roles access; select tenant-owned destination roles,
   timezone, retention, activities, event-only roles and notification choices.
   Saving changes pauses execution and requires new approval.
4. Resolve uncertain historical evidence through documented reviews. Missing
   membership rows never establish “never a member”; expired sessions never
   establish complete historical login coverage.
5. Generate and inspect every page of a fresh preview. Approval requires the
   current policy revision, complete frozen population, unchanged source stamp,
   unexpired preview, matching actor and explicit acknowledgement.
6. Enable only after reviewing actual tenant evidence. Monitor operation history,
   review queue and runtime errors. Pause stops new claims and invalidates leases.

The final migration lifts the preparatory database-only prohibition on enabling;
it does not approve a preview or enable any tenant.

## Processing and safety contract

- Rules use dynamically selected tenant roles, never BNMS role names or IDs.
  Purchased memberships and lifecycle states remain separate.
- Current/future memberships, renewals, unsettled billing, bookings, credits,
  failed evidence reads, unknown dates, exemptions and holds protect records.
  Confirmed past bookings still require charge/settlement evidence; queued
  invoices are not treated as paid. Missing legacy financial evidence holds for
  review. A renewed former guest receives the latest term's retention boundary.
- Qualifying activity uses actual attendance, effective earned CPD and genuine
  member logins. Imports, admin edits, refresh, masquerade and team sessions are
  not substituted for member activity. Event-only roles use attendance alone.
- Cron runs bounded resumable chunks. A completed tenant sweep is next due in
  one day; unfinished chunks resume promptly and failures retain their cursor.
  Leases, policy revisions and fresh evidence are checked at mutation time.
- Source generation and schema stamps protect read plans. Final transactions
  obtain non-waiting relation locks before rechecking stamps. Busy or changed
  sources produce a conflict, not a speculative transition.
- These locks/stamps are deliberately coarse across source tables. Other tenants'
  writes may invalidate a preview; heavy imports may require retrying during a
  quieter period. Do not replace this with an unguarded read-then-write check.
- Once lifecycle ownership is approved, individual annual-expiry access changes
  defer to it, including while paused. Organisation expiry remains independent.
  Role-change workflow delivery uses durable existing delivery keys.
- Archive blocks member access and old member sessions, but preserves separate
  team access. Restore preserves the existing role and does not grant paid
  membership or resurrect old sessions.
- CRM lists, CSV exports, search, directory inventories and campaign eligibility
  exclude closed lifecycle states. Authorised exact-ID historical references
  remain available; historical invoice and reporting records are not erased.

## Disposal and recovery

Archive does not remove profile data. Minimisation/deletion requires a separate
field inventory, current impact token, documented reason and exact confirmation.
Unknown nonempty fields require an explicit retained/removed decision; documented
personal-data retention blocks final disposal.

The protected internal ID, lifecycle/audit dates and separately protected
historical/financial references remain. “Delete” is a permanent closed tombstone,
not a cascading physical row deletion. Shared identity/team credentials and
external provider records are not represented as erased.

Removed media references enter a private cleanup queue. An administrator must
independently remove/verify the storage object and record **VERIFIED REMOVED**.
The queue is not proof of external erasure. Operation status remains attention-
required while cleanup is outstanding; retrying a consumed impact token does not
repeat profile disposal.

Notifications are deduplicated by record, policy version, reason/date and reviewer.
Recipients and current relevance are rechecked before sending. Known provider
rejections retry with a bound; ambiguous outcomes require independent verification.
Only **VERIFIED DELIVERY** or **VERIFIED NOT SENT** can resolve that review.
Delivery recovery runs independently of processing failure. Neither provider
acceptance nor a claim is described as confirmed inbox delivery.

## Verification

Use isolated fixtures; never point tests at a live tenant:

```sh
node scripts/run-isolated-tests.mjs node --no-experimental-global-navigator --import tsx --test --test-concurrency=1 \
  shared/memberLifecyclePolicy.test.mjs api/_lib/memberLifecycle*.test.mjs \
  api/admin/member-lifecycle.test.mjs api/cron/member-lifecycle.test.mjs \
  client/src/components/member-lifecycle/MemberLifecycle.mounted.test.mjs
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test \
  supabase/migrations/memberLifecyclePreparation.test.mjs \
  supabase/migrations/memberLifecycleLoginEvidence.test.mjs
node --test tests/member-lifecycle.browser.test.mjs
npm run build
```

The browser fixture compiles the actual components, binds a separate local server
and blocks non-fixture browser requests. It tests approval/pause and mobile
containment without bypassing application authentication. Live signed-in tenant
UI, production migration and provider delivery require a separately authorised
rollout check; fixture passes do not establish those outcomes.
