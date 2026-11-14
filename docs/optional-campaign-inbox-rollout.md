# Optional campaign inbox delivery

This option is default off and duplicates with the campaign draft. It never
changes preferences and is not legal certification: organisations must establish
a lawful basis and honour applicable objections across channels.

## Deployment prerequisite

Apply `supabase/migrations/202701010001_optional_campaign_inbox.sql` only through
the approved destination-specific migration process, with send workers quiesced.
It requires campaign preparation, the eligibility-feedback migration, campaign
inbox delivery-mode, lifecycle/archive columns and campaign survey delivery.
It deliberately refuses an unexpected preparation-function definition rather
than overwriting unrelated concurrency or quota logic.

No migration has been applied to a shared database as part of this task.
No historical recipient UPDATE or backfill is included. The unresolved historical
exception and sending freeze in `campaign-inbox-delivery-mode-rollout.md` and
`campaign-inbox-recipient-reconciliation.md` are unchanged. This feature is not
authority to repair history or resume live sends.

Roll out matching readers and workers together after the migration. Do not run
old workers against campaigns with the option enabled. Verify service-role view
and RPC grants and controlled signed-in inbox behavior before operator-approved
resumption. Rollback requires keeping workers stopped; do not drop publication
evidence or turn an inbox-only recipient back into a pending email.

## Channel contract

Audience membership remains independent of channel eligibility. Prepared
consent exclusions retain `inbox_only` evidence in the preparation journal;
subsequent opt-in cannot convert them to email. Current address, member, global
ledger, global flag and positive category subscription are checked again at
delivery. Legacy bypass flags do not override those checks with this option.
These campaigns use individual delivery even when their older transport pin
selects bulk, so an inbox-only recipient cannot enter a provider envelope.
Consent is reconciled by normalized email address against tenant member records
before preview/preparation deduplication and again at the provider gate. An
external contact sharing an opted-out member's address cannot override that
member's global or category exclusion, and does not acquire inbox membership.

Publication stores finalized subject and HTML plus a separate timestamp.
`sent_at`, provider IDs and email test/live provenance are not invented. The
publication RPC locks the campaign and recipient and atomically completes the
recipient without an email. A unique recipient row plus immutable publication
content makes retries idempotent. Cancellation and test mode prevent publication.
The existing service-only inbox relation and unread summary include these
publications while keeping unknown and test email submissions hidden.

Reports count inbox-only publications separately and include their consent
exclusions in the email exclusion total. “Sent” remains provider acceptance,
not confirmed delivery. Candidate preview counts can change before delivery.

## Isolated verification

Run the focused Node tests for bulk eligibility, send gates, campaign inbox
handlers, `campaignOptionalInboxSend.test.mjs`, and `campaignOptionalInbox.postgres.test.mjs`. The latter starts a
disposable local PostgreSQL instance; it must never use an application database.
The optional-inbox test in `tests/campaign-visual-loading.spec.mjs` mocks API
requests for save/reload and channel confirmation; it sends no member email.

The ordinary preview in this workspace currently reports “Tenant not found”,
so it is not evidence of the signed-in UI. The save/reload and confirmation
check uses a fully mocked authenticated browser fixture instead. Production
tenant verification remains a rollout prerequisite, not a live test performed
by this task.
