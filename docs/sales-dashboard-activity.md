# Sales dashboard milestone contract

Recent activity is a read-only view of recorded history, independent of dashboard
totals and the expected-close card's date/order controls. It does not replay
deliveries or repair old records.

## Evidence and meaning

- Stage history supplies previous/next stage IDs and event time. Initial stage
  assignment and same-stage writes are excluded. Labels resolve those recorded
  IDs, not the opportunity's current stage. Missing stage definitions get an
  explicit unavailable label. Existing history does not snapshot renamed labels.
- Legacy `stage.changed` activity is used only with recorded from/to IDs and no
  matching stage-history transaction. Other generic audit actions are excluded.
- Delivery audit `sent` means provider success, including when the subsequent
  proposal-status transition failed. Attempts and failures are never sends.
  Status-history `sent` alone is not proof of delivery.
- Status history supplies accepted/rejected outcomes, including customer and
  staff-recorded decisions. The exhibition lifecycle's explicit staff-cancellation
  entry is excluded rather than called a rejection. Converted history without a
  matching sale is labelled converted, not a confirmed commercial sale.
- Commercial-sale rows are confirmation evidence at their recorded creation time.
  Acceptance, an opportunity win, and commercial confirmation are different facts.
- Customer decisions and decision audit provide historical fallback evidence
  when their transaction's status history is absent. Customer names, email
  addresses, notes and request/provider metadata are not sent to the dashboard.

## Overlap and ordering

Same transaction means the same recorded timestamp and relevant record/version,
outcome or stage pair. Prefer stage history to its generic audit mirror and status
history to its customer-decision/audit mirrors. Prefer commercial confirmation to
the same sale's converted history and exact transactional auto-won stage move.
Distinct staff acceptance and commercial confirmation remain different milestones.
Same-token duplicate sent audit rows represent one send; new tokens represent
genuine resends. Repeated stage moves remain separate.

Qualify and authorize before selecting eight rows. Sort newest first, then by
source-prefixed event ID for deterministic timestamp ties. Query eligible history
in 100-record ID batches and 1,000-row stable pages, with a 50,000-row fail-explicit
ceiling per source. Noise-only maintenance history is never scanned wholesale.

## Access and attribution

The existing administrator/owner/collaborator authority gates opportunity context;
linked proposals must have a visible opportunity. Only administrators see unlinked
proposals. Deleted exhibition proposals are omitted. Tenant predicates apply to
every source. The timeline does not change other cards or other CRM feeds.

Only actors on the final eight rows are resolved. Legacy/unified team users use
the existing tenant-aware Sales principal resolver. Member names require tenant
and primary-team membership; customer-contact names are not fetched. Customer and
system identities stay generic, while unresolved names and absent actors have
honest fallbacks. The actor is the recorded initiating user, never the selected
email sender, proposal owner or recipient by inference.

Internal tenant naming and routes are applied by the UI. Day-first dates, financial
totals, and expected-close controls are unchanged.

## Verification

Run:

```
node scripts/run-isolated-tests.mjs node --test --test-concurrency=1 api/_lib/salesReports.test.mjs api/_lib/salesDashboardActivity.test.mjs api/_lib/salesQuoteDelivery.test.mjs client/src/components/sales/SalesReportingWorkspace.test.mjs
node --test tests/sales-dashboard-activity.browser.test.mjs
```

Browser fixtures mount the real dashboard with synthetic API responses and current
CSS, not a signed-in live tenant. They never bypass application authentication.
