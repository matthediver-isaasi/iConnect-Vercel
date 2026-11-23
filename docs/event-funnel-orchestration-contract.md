# Event ticket funnel orchestration contract

**Migration hold:** No migrations may be applied to Supabase DEST. The SQL is
stored, unapplied, for a future explicitly approved staging rehearsal.
See [staging migration instructions](../guides/event-funnel-staging-migrations.md).

## Implementation status

**Current cancellation-code status:** The grouped approval, final Zoom-access
revocation and dedicated credit-note email paths are implemented and covered by
isolated API, provider-adapter and PostgreSQL tests. This does not apply the
45 staged migrations, schedule recovery, enable purchasing or establish live
provider/signed-in browser acceptance. The incremental notes below describe
earlier implementation boundaries as well as the latest additions; use the
latest cancellation/recovery sections for those paths.

This is a **design and partial implementation**, not an available booking feature.
Implemented so far:

- Pure domain graph validation and evaluation, shared with the editor.
- React Flow authoring inside Event Settings, separate layout persistence,
  condition controls and server-evaluated sample previews.
- Tenant-scoped administrator save/preview API with revision checks, reference
  validation, origin checks and database-backed request limits.
- Fourteen **unapplied** migrations for private definitions, immutable versions,
  owner-bound sessions, draft answers, staged inventory holds and bounded cleanup.
- Disposable PostgreSQL tests for concurrent authoring/answer writes, access
  boundaries, immutable identity, fixed deadlines and financial-state retention.
- Isolated browser checks using the real editor and React Flow.
- Atomic complete-selection hold replacement with owner/revision checks, one
  fixed deadline, explicit expired re-reservation and uncertain-payment retention.
- Event/ticket guards count shopping holds separately from commercial commitments.
  Public event/ticket availability subtracts held stock without rewriting editor
  values or historical counters. Owner-only resume reads retain expired selections.
- Disposable PostgreSQL inventory tests exercise ordinary-booking competition,
  direct confirmed inserts, commercial allocation/naming, group multipliers,
  failed optional edits, expiry, private access and aggregate public projections.
- A server-owned journey planner and transactional route mutation: skip, source-only,
  branch pruning, branch rejoining with shared held selections, revision fencing,
  saved answers, explicit re-reservation and read-only payable states.
- An ownership-protected `/api/event-funnels/journey` read/edit endpoint with
  same-origin JSON requests, shared per-client rate limits and uncached responses.
  Member ownership comes from a verified session. Guest ownership uses the digest
  of an opaque host-only HttpOnly cookie, never an email or client-supplied member.
- A reusable customer frame and hook with persisted navigation decisions,
  server-based countdown, accessible time warnings, optional-selection failure
  recovery, source-only controls and explicit expiry recovery. This frame is
  mounted in the source event registration pages and a resumable reservation route.
- Authoritative selection pricing, guest/member/private/release/group eligibility,
  original purchaser preservation, normalized attendee details, current terms
  validation and common payment/currency/company compatibility. Browser snapshots
  omit internal accounting settings and payment-account fingerprints.
- Gated entry/start/offer endpoints, secure guest capability issuance and owned
  offer projections. Publication storage preserves active versions and enforces
  one source entry; offer availability excludes the displayed node's own hold.
- Source/offer registration integration reuses both existing event experiences.
  Active journeys defer per-event payment and billing; original guest identity,
  saved answers and policy-version acceptance survive navigation. Optional-node
  unlisted/prerequisite controls are present in the builder.
- A staged aggregate payment-order authority stores immutable purchaser, selected
  lines, invoice mode, payment terms and the original provider request before any
  provider write. Concurrent preparation returns the same order. Private RPCs
  bind one intent, pin uncertain stock and permit release only with a terminal
  cancellation outcome or proof that no provider request started.
- An adapter-based payment state machine verifies amount/currency/tenant/order/
  session/mode, retries the identical create key within a bounded replay window,
  retains paid stock through commit failures, and resolves success-versus-cancel
  races without starting another payment. Its tests use provider fixtures, not
  live Stripe. The production registration finalizer and provider adapter are
  not connected; payment cannot be enabled merely by installing these primitives.
- A deterministic registration plan allocates exact pennies to each event and
  attendee, preserves rounded original prices and generates stable registration
  identities without inserting draft attendees. A staged transaction converts
  ordinary, unfunded selections into individual registrations, private financial
  links and durable invoice/confirmation/integration delivery records together.
  Disposable PostgreSQL verifies two-event rollback on downstream failure and
  concurrent finalization without duplicate registrations or financial evidence.
  Simple-event group fulfillment is gated on its dedicated migration.
  Complex-event group fulfillment remains unsupported. Delivery workers are not connected.
- Internal checkout preparation now reuses the standalone unified customer
  resolver, revalidates every selection, freezes the verified contact and recovers
  a lost preparation response from the owned session's original order. Its request
  hash does not allow a retry to alter payable terms. The existing tenant Stripe
  adapter is implemented with isolated provider fixtures, not live calls.
- Card requests are restricted to cards, not newly introduced automatic payment
  methods. The server freezes the reservation deadline and rejects starting a
  new payment after expiry. A verified payment cancellation returns to the same
  still-valid reservation without extending its countdown; expired selections
  require explicit re-reservation.
- Private fenced recovery/delivery queues and bounded worker libraries are
  implemented and tested; they are not scheduled or connected to production
  invoice/email/integration adapters. Verified successful payment evidence is
  persisted independently before registration conversion so a failed database
  commit can retry even during a subsequent provider outage, without offering
  another payment. A verified paid order cannot release its inventory.
- A staged training-fund reservation ledger serializes competing checkouts and
  legacy balance writers without consuming funds early. Order confirmation
  debits once and writes the existing training-fund transaction; cancellation
  releases the reservation without a refund transaction. Pending reservations
  also prevent deletion or re-tenanting of their owning organization.
  Internal checkout preparation, exact per-booking allocations and finalization
  now use this ledger. Disposable PostgreSQL covers fully funded zero-balance
  checkout, partial funding plus card, retry without duplicate debits, and
  rollback of registrations and funds if the audit transaction fails.
  The public checkout UI and routes remain unavailable.
- Voucher allocation now follows existing expiry-first ordering and preserves
  event-specific eligibility rather than spreading credit across ineligible
  events. Registration plans require exact per-voucher/per-line allocation
  evidence; this pure allocator does not reserve or consume vouchers.
- Read-only voucher preflight reloads the original member, voucher ownership,
  role/settings/currency restrictions and each selected event's actual date
  (including complex-event sessions). It rejects membership-only credit and
  failed policy reads.
- Internal voucher checkout uses the existing credit ledger through atomic,
  amount-capped per-voucher reservations. Short reservations roll back rather
  than increasing the promised card charge. Confirmation commits once; verified
  cancellation releases reserved credit. PostgreSQL rehearsals include the
  existing voucher migration, competing purchases, and combined training-fund/
  voucher zero-balance checkout with exact financial links.
- Simple-event group conversion creates one existing group-management
  entitlement per purchased group, with an opaque random token and no invented
  participants. Shared capacity counts its fixed purchased multiplier after
  conversion. Naming participants cannot consume stock twice or exceed the
  group size in concurrent requests. Cancellation closes group access; direct
  re-parenting remains blocked pending allocation-aware transfer handling.
- A fail-closed, secret-authenticated recovery handler now composes the payment
  recovery worker and bounded draft maintenance. It is not scheduled. Maintenance
  expires abandoned holds without extending timers, respects answer retention,
  and preserves uncertain payment evidence and cancelled-order parent records.
- Checkout HTTP handlers now enforce owned member/guest access, same-origin JSON,
  request allowlists and private no-store responses. New payable orders remain
  activation-gated; existing frozen orders can recover after purchasing is
  disabled. Local HTTP checks reject GET checkout and unauthenticated recovery.
  Read-only quotes expose exact per-line funding and remaining payable methods;
  preparation checks the amount the purchaser explicitly reviewed.
- The checkout UI now uses those endpoints for verified customer details,
  vouchers/training funds, reviewed quotes, card setup and non-card submission.
  Original-order recovery requires server confirmation; returning after verified
  cancellation and resuming a verified retryable card attempt are explicit.
  The frame exposes its expiry latch directly, leaving recovery accessible
  without unlocking event editing. Mounted browser fixtures cover review,
  closed activation, non-card completion, cancellation and ambiguous setup.
  The normal development preview still reports Tenant not found, so the
  tenant-backed signed-in screen has not been visually verified.

- Active published unlisted policies now filter public event lists, member
  entity discovery, search, sitemap and crawler event lists in PostgreSQL before
  pagination/counts. Admin management and direct ID/slug lookup remain unchanged.
  Remaining discovery surfaces and legacy purchase prerequisites still require
  the complete access-path audit before activation.
- New unified standalone purchase contracts reject active funnel-only ticket
  policies. The database insertion guard shares publication's event lock and
  rechecks after a competing publication commits. Owned, immutable contracts
  prepared previously still resume. Recorded older address-policy and public
  guest-purchase preparations use the same insertion boundary. Generic booking
  inserts and the complete historical-payment cutover remain unfinished.
- Disposable PostgreSQL plus real local PostgREST verified computed discovery
  filters before pagination/counting and both simple/complex overloads. No
  application or production schema was changed.

Discount funding, accounting, complete discovery/access enforcement, legacy prerequisite
enforcement and cancellation compatibility are **not yet integrated**. Publishing
remains disabled in the administration API; session creation remains disabled
by readiness. The implemented checkout UI cannot start new purchases until
activation is authorized and the remaining integrations are ready.
No cleanup/recovery schedule is configured yet. Existing
reservation read/answer/skip/source-only paths do not create confirmed bookings. No migrations
were applied to application databases and no provider operations were performed.
The complete task remains open.

### Invoice allocation preparation

`eventFunnelInvoiceAllocation.js` now reconciles frozen registration economics
against committed per-booking financial links before producing per-event or
consolidated invoice allocations. Same-event add-ons share one event allocation;
every participating booking remains linked. Card allocations retain the original
charge amount separately from each invoice's settlement share. Zero-balance
groups retain evidence without requesting an invoice or card settlement.

This is a private planning primitive, not an accounting delivery adapter. It
does not invent tax lines, call providers, enqueue invoices or implement refunds.
The delivery/outbox integration and allocation-aware accounting consumers remain
required before activation.

### Remaining legacy purchase cutover

The simple payment entry is `createStripePaymentIntent`; complex purchases use
the public complex-event payment-intent handler for both members and guests.
Post-booking donations and program purchases in the shared simple handler are
not new event registrations and must not acquire event prerequisites.

Version-two callers persist `unified_booking_contract` before Stripe. The new
insertion guard protects this boundary, including a publication-versus-prepare
race, while replay validates the original owner and immutable request first.
Older member flows may have `event_invoice_address_policy`, but that mechanism
is conditional on accounting configuration. Provisioned guest purchases may
have `public_ticket_member_purchase`; other legacy intents historically had
neither. Therefore those records cannot cover every already-issued payment.

The insertion guard now also covers new address-policy and provisioned-guest
authorizations. Exact existing snapshots remain replayable even when their
preparation RPC uses `INSERT ON CONFLICT DO NOTHING`; changing a snapshot is not
an authorization bypass. Pure legacy intents without either durable record,
registration-level proof and generic writes still need the cutover below.

New pure legacy card creation now persists a service-only access journal before
the Stripe call and binds its returned intent before returning a client secret.
The permission check shares publication's event lock. Existing donation,
program, unified, invoice-address and provisioned-public idempotency paths remain
separate. Only unbound journal rows older than thirty days are pruned; bound
records retain original access evidence. This journal is **not** verified payment
or purchaser ownership and must not by itself authorize a booking insertion.

Before guarding legacy registration inserts, persist verified purchase
authority before provider creation on all remaining paths and define recovery
for already-issued intents. Do not simply reject a paid registration against
the latest published policy. Generic booking creation and event/ticket edits
currently use the private-ticket helper, including its administrator exemption;
that is not funnel prerequisite authority. API-only checks are insufficient
because publication can race the later write. Aggregate financial linkage is
currently inserted after each booking; any insertion-time authorization guard
must account for that ordering without accepting client-supplied order IDs.
Audit already-purchased commercial entitlements separately: preparing a delegate's
registration/billing record is not necessarily a new sale of that admission.
The cutover must preserve those existing commitments without treating an earlier
source-event purchase as permission to buy a new follow-on offer.

Broader regression checks are not yet all green: resource-release secondary
tests, route-inventory tests, and the generated generic-entity test bundle still
need investigation. The latter currently contains an awaited module initializer
inside a non-async generated function. These failures are not counted as passes;
the focused discovery/PostgreSQL, homepage and immediate-event checks pass.

The payment-order migration rejects discount reservations until their
transactional fence and checkout adapter are connected. Training-fund and
voucher checkout each remain disabled until their dedicated migration is installed.
These are staging safety gates, not a replacement funding policy or
completed checkout capability. The payment store requires an explicit aggregate
registration finalizer and has no fallback to sequential event endpoints.

The inventory migration is a staged primitive, **not completed inventory
activation**. Its replacement RPC is reached through the owned
graph/eligibility/pricing adapter; it is not a public booking API.
Remaining inventory work includes authenticated/editor-safe availability
projections, auditing every legacy counter/import/group writer, aggregate
conversion and payment-state transitions under the same locks, and rehearsing
the full installed commercial function chain. The local inventory fixture
executes the actual ticket guards, public batch and simple-total migrations,
but does not install the full commercial sales/invitation subsystem. Journey
integration scenarios use a deterministic commercial resolver, not live pricing,
funding or provider operations. The future resolver must freeze per-unit economics
and applicable pricing rules, not mistake a quantity-specific total for a unit price.

Expired selections may be pruned without reacquiring stock; this leaves the session
expired and retains its deadline and answers. This is necessary so an unavailable
optional offer cannot block source-only re-reservation. New tickets still require
explicit re-reservation. Live holds preserve their original group multiplier and
price snapshot; reducing an administrative capacity does not invalidate removing
optional items or maintaining the existing source, but cannot authorize an increase.

The application workflow starts successfully. Actual Event Settings verification
is blocked by the existing preview's “Tenant not found” response; the browser
evidence above is isolated fixture evidence, not signed-in tenant verification.

The domain graph must not be connected to customer checkout until the
transactional adapters and compatibility gates below are implemented and tested.
Graph validation alone does not prove that an event exists, is eligible, has
available tickets or uses compatible billing.

## Observed integration boundaries

| Boundary | Existing code | Required integration |
| --- | --- | --- |
| Simple member and guest registration | `client/src/pages/EventDetails.jsx`; function dispatcher `api/functions/[functionName].js` | Preserve forms and validation; introduce draft submission instead of confirmed registration only when server capability identifies an active journey. |
| Complex registration | `client/src/pages/ComplexEventDetail.jsx`; `api/public/complex-event-booking.js` | Preserve per-class attendees, discount answers and private allocation context; do not call this endpoint once per basket event. |
| Group ticket participant management | `client/src/pages/GroupBookingPage.jsx`; `api/public/group-booking/[token].js` | This manages participants after purchase, not another shopping cart. Preserve group-size inventory multipliers and group links at aggregate conversion. |
| Meeting scheduling | `client/src/pages/PublicBooking.jsx` | This is a meeting-slot scheduler, not public event ticket checkout; leave unchanged. |
| Total simple-event inventory | `api/_lib/simpleEventCapacity.js`; `202701220001_simple_event_total_capacity.sql` | The migration locks event rows for booking/commercial writes and verifies total capacity. Holds must join this authority and its projections, not introduce a parallel counter. |
| Complex and legacy inventory | `api/public/complex-event-booking.js` | Capacity checks and seat-decrement RPCs coexist with booking insertion. Trace and adapt each RPC and every ordinary/commercial writer before activation. |
| Funding and atomic booking | `api/_lib/bookingCreditAttempt.js` | `finalizeBookingCredit` and unified finalization currently operate on an event. Aggregate conversion must consume funding once across all child bookings. |
| Payment authority | `api/_lib/unifiedBookingContract.js` | Contract and provider metadata bind a single event. Introduce separately versioned aggregate authority; never overload that event ID with a basket. |
| Invoice recovery | `api/_lib/unifiedBookingRecovery.js`; `api/_lib/eventInvoiceProducer.js` | Existing durable handoff uses source/purchase identity. Aggregate accounting requires new immutable event-line linkage and settlement allocations. |
| Cancellation | `api/_lib/bookingCancellation.js` | Existing refund allocation hooks do not by themselves establish aggregate refund authority. Resolve purchased-line limits and remaining amounts transactionally. |

This inventory is an initial trace, **not a claim that all legacy writers or
downstream consumers have been audited**. Remaining tracing must include imports,
transfers, event deletion, allocation claims, webhooks, reports, invoice downloads,
emails, and public/member/Canvas discovery.

## Domain graph version 1

`shared/eventFunnelGraph.mjs` implements a bounded acyclic graph with exactly one
source and one checkout. Event identities include kind, ID and tenant. Purchase
nodes explicitly enumerate allowed ticket IDs; visual coordinates are not part
of the domain graph. React Flow will maintain a separate layout document.

Source nodes have an accept destination. Optional event/add-on nodes have accept
and skip destinations. Same-event add-ons require an earlier source/event
purchase of that event. Prerequisites reference purchase node IDs. An event
skipped on a route cannot authorize a dependent add-on.

Condition nodes contain rules with distinct non-negative priorities (lowest
number wins), `any`/`all` predicates, and a mandatory fallback. Predicates test
selected/not-selected events or ticket classes offered earlier in the graph.
Only selections traversed on the current route satisfy predicates; stale answers
on another branch cannot influence the route. A graph may rejoin later nodes.
Duplicate event purchases and overlapping ticket subsets on a purchasing path
are rejected conservatively, including paths made unlikely by conditions.

Evaluation takes selections and explicit skip decisions, never next-node IDs.
It reports the route, rule priorities, retained nodes, pending downstream drafts,
and selections to remove with a customer-facing explanation. A newly unanswered
offer pauses routing without discarding potentially reachable shared drafts.
Pending drafts cannot authorize checkout. A source-only action reaches checkout
only after a source selection and removes optional selections.

Structural validation does not substitute for tenant-scoped event/ticket lookup.
Publication must resolve every reference from the database, verify event and
ticket eligibility, payment/accounting compatibility, access rules and exactly
one published source entry. Preview uses sample selections and does no stock work.

### Invoice preparation progress

Invoice allocations now consume the actual `registrations` shape produced by
checkout rather than a separate fixture-only `bookings` shape. A cross-module
test exercises that contract. Invoice dates and PO references are frozen at
checkout. Automatic captured-charge evidence retains the actual charge date;
missing accounting evidence never changes a successful registration outcome.

Frozen Xero and QuickBooks preparation preserves per-event funding conventions,
consolidated booking links and exact settlement shares. Migration
`202701230015_event_funnel_invoice_preparation.sql` adds service-only,
lease-fenced immutable capture with allocation/link checks. Local PostgreSQL
tests verify replay, changed-payload rejection, lease expiry and role denial.
This migration remains unapplied to application databases.

Migration `202701230016_event_funnel_invoice_delivery.sql` adds a dedicated
aggregate invoice journal and booking links. Xero delivery reuses the existing
provider recovery algorithm while retaining separate aggregate ownership,
sharing the ordinary connection lease/cooldown, and persisting exact event
settlement shares. The recovery endpoint now dispatches invoice work separately
from payment recovery. No cron scheduling or production execution is authorized.

Local PostgreSQL/provider-fixture tests cover an accepted invoice whose response
was lost, subsequent recovery without duplicate invoice/payment creation, stale
tokens, connection contention, immutable tax resolution and persisted booking
links. These are not live-provider tests.

Migration `202701230017_event_funnel_quickbooks_delivery.sql` connects original
QuickBooks instructions to the existing shared accounting queue. Dedicated
source guards and idempotent link operations preserve tenant, provider company,
order and allocation ownership. The existing event preparation adapter resolves
the frozen tax/item mapping without changing the checkout customer. Payment
settlement remains the exact invoice allocation, not a repetition of the full
charge. PostgreSQL and provider-fixture tests exercise queue contention, lost
invoice responses, original request reuse, repeated linkage, role denial and
cross-tenant rejection. Both providers are now dispatched by the funnel recovery
endpoint; no live provider calls or cron scheduling have been performed.

Migration `202701230018_event_funnel_invoice_readers.sql` adds bounded private
report projections and download authorization. Registration-report cells and CSV
now identify the shared checkout and invoice mode, retaining per-event financial
totals. Existing invoice actions resolve the original Xero/QuickBooks invoice
through protected booking links. Downloads require the original member purchaser
or a tenant administrator, not an attendee or organisation colleague. Provider
requests retain the captured company, connection and environment even if the
tenant changes its active provider. Missing staged RPCs retain legacy behavior;
authorization/storage failures never fall back to legacy permissions.

Migration `202701230019_event_funnel_owned_invoices.sql` adds invoice lists and
downloads for the original reservation owner, including guests. The confirmed
checkout displays invoice readiness and download controls. Same-origin POST
requests use the existing HttpOnly guest capability or authenticated member;
the database revalidates ownership, access expiry, confirmed order state and
invoice/order linkage before returning any private provider binding. Provider
identifiers and capabilities are never placed in browser links. This does not
extend the reservation's access lifetime or introduce emailed guest access links.

Migration `202701230020_event_funnel_confirmations.sql` freezes the enabled
confirmation-template set per committed registration. A private, per-template
write journal fences the existing event confirmation renderer and email service.
Confirmed submissions and explicit non-submissions are recorded separately;
unknown provider outcomes and crashes after the send marker require review,
never an automatic resend. Known non-submission retries use the original saved
envelope. Existing event-specific agenda, survey, QR, calendar and notification
preference rendering is reused. Accounting completion is not a prerequisite.

The confirmation worker is wired to the protected recovery endpoint but waits
for the order's **integrations** delivery record before generating personal
attendance links. Those integration workers are still unfinished, so this
adapter must not be mistaken for activated end-to-end confirmation delivery.
Operator reconciliation of uncertain email attempts remains an activation gate.

Migration `202701230021_event_funnel_confirmation_retention.sql` clears delivered
confirmation bodies, recipient/template snapshots and attachments after the
original session's `retain_until` deadline. The service-only cleanup runs in
bounded, skip-locked batches independently of payment recovery. It preserves
registration/order identifiers, delivery timestamps and provider message IDs;
pending, writing and review-required attempts retain their recovery evidence.
Redaction never reopens a delivered item or changes financial snapshots.
Cleanup failures are reported separately and cannot stop payment reconciliation.

Funnel confirmation rendering now requests strict entrance-ticket preparation.
Applicable QR failures stop that confirmation before its send journal starts,
rather than silently delivering an email without entrance codes. Strict check-in
operations verify the persisted tenant/registration scope, read complete bounded
session/token lists, preserve existing tokens across partial failures, and
distinguish unavailable metadata from a verified empty or online-only scope.
Ordinary confirmation callers retain their existing behavior. This is not a
replacement for the remaining Zoom/Teams and other external integration adapters.
Funnel QR and notification planning now share a bounded, fail-closed session
resolver. It combines direct and junction track links, supports common
untracked sessions alongside selected tracks, and grants no sessions for an
explicitly restricted ticket with no tracks. This matches the existing follow-up
eligibility model without changing standalone QR/reminder behavior.

Migration `202701230022_event_funnel_integration_steps.sql` provides independent
per-registration checkpoints for check-in, notification scheduling and providers.
The notification planner reuses ordinary reminder, training-agenda and follow-up
timing/snapshot policies. Scheduling and its checkpoint commit together, with
existing unique indexes protecting against concurrent ordinary/admin scheduling.
Notification scheduling also requires that registration's provider preparation
checkpoint, so reminders cannot be released while required joining access is
still unresolved.
Failed siblings retry without recreating completed work. The recovery endpoint
runs integrations before confirmations within a shared invocation deadline.
Verified absence of configured provider work is a valid no-op. Existing Zoom
access can also be verified using the same recipient-specific resolver as email,
with account-bound token caching and an invocation deadline. These checks are
read-only when using the access verifier. The recovery adapter additionally
supports scheduled Zoom meeting/webinar registration through migration
`202701230023_event_funnel_zoom_recovery.sql`. It freezes target/account authority,
records write intent before POST, and never repeats an uncertain request just
because a later provider listing is empty. Approved existing registrations and
lost-response successes are adopted through provider reads. Each new
registration preparation independently verifies access rather than treating an
old successful receipt as proof that access was never revoked. Parent completion
is blocked in SQL while linked work is unresolved. The private journal stores
recipient hashes and provider IDs, not access tokens or personal joining URLs.
New occurrence-specific/recurring registrations, Teams and other external
provisioning still require adapters and remain pending, not silently completed.

Migration `202701230024_event_funnel_confirmation_receipts.sql` adds a
server-issued correlation token to each confirmation. The final Mailgun
envelope includes this token and the confirmation ID. The existing webhook
routes these receipts through mandatory signature verification, independently
of its older campaign compatibility behavior. Receipt processing checks the
original primary recipient, token, message identity and event ordering before
changing the private journal. It resolves accepted/delivered outcomes without
another send, preserves failures for review, and wakes the outbox without
stealing a running lease. Late synchronous sender responses cannot undo a
successful receipt. CC/BCC receipts cannot establish delivery to the purchaser.

Activation requires `MAILGUN_WEBHOOK_SIGNING_KEY` and a verified signed
delivery/failure callback path. An unset key fails closed for funnel receipts.
Neither receipt tokens nor signing secrets are customer checkout authority.
There is no automatic resend when evidence is missing, and provider test-mode
messages cannot carry live confirmation receipt authority.

**Still incomplete:** other activity/email invoice consumers and
allocation-aware refunds/cancellations, alongside the
other outstanding activation gates.
Legacy single/group
cancellation paths now check shared-checkout ownership before financial side
effects, and database guards protect linked booking financial fields/deletion.
Those guards reject unsupported cancellation; they are not the finished
allocation-aware cancellation feature. Activation remains disabled.

`eventFunnelReversalAllocation.js` now provides the private arithmetic boundary
for that replacement: it validates the complete immutable order/booking
allocations, selects only explicitly requested registrations, and deducts
reserved, uncertain and completed prior operations from each monetary limit.
It keeps card, invoice, training-fund and voucher limits separate and distributes
explicit partial amounts with exact capped penny arithmetic. It does not choose
refund defaults or authorize a provider call. The transactional ledger, provider
execution, funding restoration and existing cancellation UI/endpoint routing
remain required; legacy cancellation remains blocked in the meantime.

The card-reversal recovery adapter now requires a durable write barrier before
submission, reconciles lost responses against a complete provider refund list,
and refuses unknown external refunds or a changed provider account. It submits
only the selected allocation amount with a stable operation idempotency key.
The staged reversal ledger serializes allocation reservations under the order
lock, keeps uncertain operations charged against their limits, and provides a
one-writer card barrier and immutable completion receipt. A scoped store adapter
rejects missing or conflicting persistence acknowledgements. The cancellation
endpoints, funding restoration and remaining financial legs are not yet wired;
these components do not enable customer refunds by themselves.

The training-fund restoration primitive now returns only the reserved amount to
the original committed organisation. It requires cancelled registrations, writes
the balance, audit entry and receipt in one transaction, and serializes retries.
Its isolated tests model the separate cancellation authorization boundary; they
are not evidence that the still-unwired end-to-end cancellation flow works.
Voucher restoration and the accounting-credit legs remain separate outstanding
work. No application database migrations have been applied.

Cancellation can now commit selected registration status changes and inventory
restoration in one transaction using private transaction-bound authority.
Ordinary direct financial edits remain blocked. The primitive refuses missing
original stock evidence and commercially reassigned bookings rather than guessing
stock movements. It does not recreate a legacy counter superseded by counted
capacity. Cancellation endpoint routing and downstream cleanup remain unwired.

Voucher reversal now has a server-derived, amount-fenced plan and a recovery
adapter reusing the existing original-owner/backed-credit return service.
Lost local receipts replay the same allocation refund key. Existing expired
voucher replacement rules remain mandatory. The separate receipt tests seed
accepted cancellation authority; they are not a full provider integration test.

New invoice preparations now preserve per-registration line provenance,
including separate signed funding lines. The accounting credit calculator uses
issued tax/account evidence and cumulative, monotonic penny allocations rather
than prorating an entire shared invoice. The issued-invoice capture preserves the
resolved customer identity and immutable financial lines, excluding balances.
Older preparations without attribution retain their original delivery path.
Remaining provider coverage, reversal queue completion and endpoint routing
remain required before activation.

The Xero credit adapter now exercises exact-line submission through the existing
provider helper with an original-company check, separate durable barriers for
credit creation and invoice allocation, and strict returned-line/tax validation.
Unknown writes cannot be repeated; malformed allocation evidence stays pending
for reconciliation. The private journal and original-invoice job producer now
serialize credit history under the order lock. Database-backed tests run the
producer, scoped store and real Xero helper against a mocked provider, including
replay without another POST. The full reversal worker and cancellation endpoints
are not wired yet.

QuickBooks preparation now freezes native tax references for attributed funnel
invoices. Issued-invoice capture preserves the original customer, native lines
and provider tax totals; only aggregate rounding differences are distributed
deterministically across lines. A database-backed test exercises preparation,
provider-result validation and repeated linkage without a second invoice write.
The QuickBooks credit-memo writer now uses the frozen native customer, item and
tax references with explicit per-rate tax amounts. Credit creation and allocation
have separate durable barriers; lost responses reconcile without another POST.
The producer, scoped journal and provider adapter pass a database-backed replay
test. Cancellation endpoints and the overall reversal worker remain to be wired.
All provider responses in these tests are isolated fixtures, not live-provider evidence.

Voucher replacement decisions now belong to the private reversal snapshot.
The authorization RPC reserves financial limits and freezes those choices in
one transaction. Recovery cannot replace them with caller-supplied options;
missing original evidence requires reconciliation before cancellation or funding
restoration. A leased worker now claims only explicitly authorized operations.
Expired leases can recover without resetting provider write barriers; late
workers cannot overwrite newer results. Completion requires durable stock and
financial receipts rather than trusting the worker's reported success.
Administrators can now inspect and retry already-approved cancellation recovery
from a shared checkout's registration report. The endpoint checks cancellation
management permission, tenant ownership, same-origin JSON and rate limits; it
cannot authorize new cancellations or alter refund choices. A separate
authenticated cron handler gives reversals their own time budget rather than
putting refunds behind invoice/confirmation queues. Its schedule remains disabled.
Routing new cancellation approvals and their operational cleanup is still outstanding.

Approval amount preparation now derives per-registration refundable limits from
the immutable purchase and all non-released refund reservations, not mutable
booking payment fields. Replays preserve their original amounts. Explicit zero
refunds and per-voucher partial choices are retained; the database verifies each
selected voucher funded that registration and still has the requested share.
Legacy total-only reservations retain their existing deterministic allocation.
This preparation is tested independently; connecting approval routes and cleanup
remains the next integration boundary.

Request approval now has a transactional database boundary: the reviewed
requests, exact refund reservations, stock cancellation and durable cleanup job
commit together. Stale legacy reviewers cannot overwrite an accepted approval;
standalone requests retain their existing path. New approved operations cannot
report completion without a cleanup receipt. The worker can complete the quiet
path when the database verifies empty provider plans, no linked provider access,
settled message attempts, and an original approval suppressing cancellation emails.
Cancellation notifications now use original snapshot attendee/purchaser addresses,
deduplicated per registration, and an immutable private envelope/write journal.
Accepted messages are not resent; uncertain sends require reconciliation. Messages
confirm cancellation only and do not claim independent refunds have completed.
This is provider acceptance evidence, not inbox delivery evidence. External provider
cleanup uses a durable grant-generation/revocation journal. Both single-request
and grouped administrator approval routes use atomic funnel approval and leased
recovery, including zero-value refunds and exact request-set replay. Group totals
are distributed from original per-registration remaining shares with exact
integer rounding, preserving card, invoice, training-fund and voucher limits.
Both routes exit before legacy refunds, request updates or notification sends.
Unsupported discount replacement still fails before approval; standalone requests
retain their existing path.

Verified Zoom access shared by confirmed registrations is retained, with the
remaining entitlements recorded in the cleanup receipt. Funnel entitlements need
verified current-generation provider links; ordinary registrations must match
the actual event/session resource. An unrelated event for the same email does
not block revocation or new bookings. Provider revocation admission shares a row
lock with new confirmed entitlements and funnel grants. A last-entitlement
cancellation revokes only funnel-owned nonrecurring meeting/webinar registration
IDs against the original provider authority; external grants are retained, and
unknown provenance/changed accounts require reconciliation. Unknown external
write outcomes are read-reconciled, never automatically reissued. New purchases
create a fresh grant generation without erasing old cancellation evidence.

An explicitly approved credit-note email address is frozen with cancellation
authority. Once every required credit is issued and allocated, each Xero or
QuickBooks credit PDF is downloaded using the original company/environment,
validated and frozen in a private email envelope. Known non-submission can retry;
accepted messages are not resent and unknown sends remain visible for
reconciliation. Suppressing cancellation notifications does not silently cancel
an explicit credit-note email instruction. Provider and email cleanup legs
recover independently; completion requires all applicable private receipts.

Cancellation now shares an order lock with confirmation and Zoom write grants.
Unstarted confirmations and integration steps are explicitly cancelled, without
blocking another registration in the same order. An admitted send or provider
write is not treated as unsent: late provider receipts remain recordable for
cleanup. Still-pending ordinary reminders and follow-ups are cancelled using
their template's tenant, event and booking model; already claimed or sent
attempts are preserved. The reminder sender revalidates cancellation and recipient
identity after rendering. This does not revoke Zoom access or deliver cancellation
notifications; those cleanup paths remain separate implementation requirements.

New confirmations also record their actual per-event legacy inventory debit
atomically with registration creation. Counted inventory records an explicit
zero debit. Cancellation must use this evidence rather than infer stock
restoration from the event's current settings. The staged migration does not
invent evidence for any previously confirmed order; such orders require
reconciliation before an automated counter restoration can be authorized.

## Persisted authority and remaining storage work

The first two staged migrations implement service-only definitions, versions,
sessions and private draft answers with RLS and revoked browser writes. The
session store only exposes owner-checked RPCs; even service-role direct reads
of private session and answer tables are revoked. Guest capability digests are
never returned in session responses. Identity and definition version are
immutable. Draft answers use compare-and-swap revisions and cannot change payable
or confirmed sessions.

Storage design for the full orchestration layer:

- Definition identity and immutable published versions; one published source
  mapping per `(tenant, source kind, source ID)`.
- Sessions bound to version and original authenticated purchaser or hashed,
  expiring guest capability. Capabilities must not appear in logs or URLs.
- Event draft answers, selected lines, immutable hold-price/tax snapshots, and
  one session revision used for compare-and-swap updates.
- Holds with event/ticket units, group multiplier, session expiry and conversion
  identity. No confirmed registration represents an unpaid shopping hold.
- Aggregate orders/payment attempts, per-event and per-booking settlement
  allocations, invoice-to-booking links and durable integration outbox records.
- Funding reservations/fences and reversal evidence that retain original owner,
  currency, eligible event and redemption identity.

Tenant checks and composite foreign keys must apply to every relationship.
Server endpoints enforce existing event-management permissions, ownership,
request limits, CSRF protection and capability verification. Retention cleanup
must eventually run on a bounded schedule without deleting payment/accounting
evidence still required for recovery. The current store provides a 100-session
cleanup RPC, seven-day draft retention and one-day access expiry; scheduling and
customer recovery after access expiry remain to be wired.

## Session and payment transitions

| State | Permitted transition | Required authority |
| --- | --- | --- |
| draft | held | First successful source reservation starts server expiry. |
| held | held | Atomic selection/pruning update; unchanged expiry. |
| held | expired | Server expiry, provided no potentially payable attempt exists. |
| expired | held | Explicit re-reservation/repricing; show differences and require acceptance. |
| held | payable | Unexpired holds, current eligibility, compatible methods, frozen customer/funding/financial revision. |
| payable | confirming | Persist provider request identity before making a network call. |
| confirming | payment_uncertain | Timeout or ambiguous provider outcome; prohibit replacement charge and stock release. |
| confirming/payment_uncertain | confirmed | Verified payment success plus atomic conversion; or accepted Invoice/PO/zero-balance authority. |
| confirming/payment_uncertain | held/expired | Only verified provider non-payment/cancellation permits release of payment fencing. |
| confirmed | confirmed | Idempotent replay; downstream failures affect outbox status, never registration success. |

Expiry is fixed at the first source reservation, not updated by browser refresh,
back navigation, add-ons or rejected optional selections. Explicit renewal after
expiry is a new reservation revision, not a silent extension. If payment creation
is uncertain, reconciliation rather than the normal expiry job owns stock.

## Transactional selection protocol

1. Authenticate owner and tenant; lock session and compare expected revision.
2. Load the frozen definition and authoritative current selections.
3. Resolve the requested edit, eligibility and server prices; evaluate routing.
4. Determine removed selections and candidate additions; order all affected
   event/ticket locks deterministically across **all** writer families.
5. Check capacity counting confirmed purchases, unused commercial commitments
   and live shopping holds exactly once. Exclude this session's old hold while
   checking its replacement. Never reinterpret historical capacity maxima.
6. In one transaction replace holds, record draft answers/pruning explanation
   and increment revision. Any failed addition rolls back the entire mutation,
   retaining the source hold and answers.

All ordinary, group, commercial and funnel writers must share locking and
capacity semantics. A new hold table without adapting these writers would
permit overselling. Funding remains fenced/reserved until final conversion;
failed optional offers never consume credits.

## Checkout, settlement and accounting

The allowed payment set is the intersection across payable selected lines and
the verified purchaser. Public Invoice/PO is never inferred from another event.
Currency, payment provider account and accounting company must be compatible.
One accounting customer follows existing unified member/guest rules.

At payable preparation freeze definition version, original purchaser, customer,
provider company/account, currency, prices, taxes, discounts, funding ownership,
invoice mode and permitted method. Subsequent configuration edits cannot
reinterpret a provider request. Integer-minor-unit event allocations must sum
exactly to the single charge; never attach the full charge as settled on every
child invoice.

Conversion inserts all individual registrations, group entitlements, funding
consumption, allocation links and outbox evidence atomically, then converts the
holds. Confirmations, provisioning and external operations run idempotently from
that evidence. Accounting outages retain confirmed bookings and original invoice
intent, not a new payable checkout.

Per-event invoicing includes same-event add-ons. Consolidated invoicing includes
event-specific lines and links to every participating booking. Zero-balance
policies remain unchanged. Cancellation/refund/credit-note consumers must resolve
exact purchased-line allocations and serialize against remaining refundable
amounts. A shared invoice or payment ID is not permission to reverse other events.

## Access and presentation

Unlisted is a discovery property, independent from active/draft status. All
public/member calendars, Canvas lists and other discovery surfaces must agree.
Funnel-only eligibility requires server-verified same-checkout prerequisite
selections and must be enforced on legacy direct purchase endpoints too.
Member/private tickets, deadlines, release rules and audience restrictions remain
in force. A visited offer event cannot recursively start its own source funnel.

Existing registration components retain event content, ticket and attendee
questions and validation. Only active server-owned journeys defer billing and
payment controls. The journey needs Back, Skip, Proceed to checkout, source-only
completion, refresh recovery, revision conflict handling and accessible
server-synchronized expiry warnings.

## Activation and verification still required

Purchasing readiness is currently hard-disabled. A future activation gate must require
schema, all readers, ordinary/commercial writers and recovery workers at compatible
versions before publishing or starting a journey.

Required remaining evidence includes the actual migration chain in disposable
PostgreSQL; competing hold/ordinary/commercial transactions; funding races;
payment success/expiry and uncertain create recovery; duplicate webhook/retry
handling; tenant/member/guest authorization; mounted React Flow and registration
UI; browser back/refresh/expiry; both invoice modes/providers; cancellation and
standalone regression coverage. Pure graph tests are not evidence for any of
these operational guarantees.

Run the implemented isolated graph checks with:

```sh
node --test shared/eventFunnelGraph.test.mjs
```

Authoring API, domain/model and disposable database checks:

```sh
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test shared/eventFunnelGraph.test.mjs api/_lib/eventFunnelAdmin.test.mjs api/_lib/eventFunnelDefinitions.postgres.test.mjs client/src/components/events/eventFunnelBuilderModel.test.mjs
node --test tests/event-funnel-builder.browser.test.mjs
```

Journey, ownership and inventory verification (all disposable fixtures):

```sh
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test shared/eventFunnelJourney.test.mjs api/_lib/eventFunnelJourneyHandler.test.mjs api/_lib/eventFunnelInventory.postgres.test.mjs
node --test tests/event-funnel-journey.browser.test.mjs
```

The browser fixture mounts the real frame and hook and calls the real HTTP
handler/service/domain planner. Its database RPCs and commercial resolver are
fixtures; the separate PostgreSQL suite exercises actual transactional mutations.
Neither is authenticated tenant/UI or deployed-provider evidence. The generic
isolated-test wrapper intentionally prohibits launching Chromium; browser fixtures
run directly with requests restricted to their own local fixture server.
