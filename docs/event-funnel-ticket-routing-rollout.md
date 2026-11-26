# Ticket-scoped event routing: installation and backout

## Authority and status

Prepared only. `202702050001_event_funnel_ticket_routing.sql` is **not installed
on any live database by this work**. Historical approval for the original funnel
release, membership additions or controlled activation does not authorize this
new migration. Obtain explicit owner approval after reviewing this file and the
exact SQL/hash. Do not run the migrations directory or a generic migration
runner. Do not add live database work to merge setup.

Prepared SQL SHA-256:
`cc7600655b26a626129c74ff29f110a3c251cef9cf0bca8d13a0c348018d846c`.
Recalculate and review it again if the SQL changes before installation.

No real BNMS funnels, event toggles, purchasing gates, workers, provider calls
or customer purchases are authorized here.

## Persisted compatibility contract

* An absent graph `entryMode` remains the original event-wide entry.
  An absent purchase node `selectionMode` remains **multiple ticket classes**.
  No existing definition, immutable version, hold, answer or session is rewritten.
* New editor drafts use `entryMode: "ticket_single"` and a source with
  `selectionMode: "single"`. New offers in these drafts default to single choice;
  administrators can explicitly select multiple classes for a later offer.
  One class may have many units/attendees and a group multiplier. No quantity,
  pricing, tax, reservation-duration or entitlement policy changes.
* The source node's `ticketIds` are the publication mappings. Several alternative
  initial classes may share a graph; disjoint graphs may use the same source event.
  The unique key is tenant + event kind + event ID + ticket ID.
* The legacy event entry table keeps one row **per definition**, so publication
  policies/discovery continue to join once per published version. Ticket mappings
  are separate and service-only. Entry-table event uniqueness is deliberately
  replaced, not silently relied upon by old callers.
* At installation, only events already owning a legacy published entry receive
  `enabled=true`. All other events are off by absence. This preserves existing
  publication behavior; it is not new purchasing activation.
* A legacy event-wide entry blocks other funnels for that event even when its
  source list is a subset. To subdivide it, explicitly change its editor entry
  mode and source choice mode, save and republish first. That replaces only its
  current entry/mappings; its already-active multi-class sessions retain their
  original immutable graph and original expiry and can finish.
* Disabling an event changes only **new admission**. Existing owned sessions do
  not re-resolve current mappings at every command or checkout.

## Routing and purchase boundary

Normal event pages continue to load their complete eligible catalogue. Discovery
returns ticket-routing mode, not an arbitrary version's source classes.
Submitting one initial class calls the server with event kind/ID, tickets,
answers and an idempotency UUID. Tenant, owner, version and source are server
authority. The private receipt fences changed event/class/owner reuse. The
existing maintenance sweep prunes these private admission receipts in bounded
batches after seven days, independently of admitted-order recovery.

An off event returns explicit `normal / disabled`. An on event returns
`normal / no_match` only after successful lookup and purchasing readiness.
Missing schema, failed lookup, ambiguous publication, stale reference and
inactive purchasing are errors, not no-match. A missing new migration therefore
blocks registration discovery in this application release: install before
deploying it. This is intentional fail-closed rollout, not a silent legacy
fallback. Waiting lists and simple programme entitlements remain on their
existing paths and cannot be enabled in the administration API.

The normal outcome reveals normal checkout on the same form; it does not
silently submit a payment. Selected attendees/quantities remain in the form.
Normal checkout rechecks server eligibility and capacity. Existing standalone
preparation guards call the same ticket authority under the event lock, so stale
browser discovery cannot buy a mapped class standalone. Exact previously
prepared standalone instructions retain their historical replay authority.

Sessions admitted to a funnel validate the source through the normal commercial
resolver before stock acquisition. A lost response can be retried with the same
request and HttpOnly guest capability. Without the capability, knowing the UUID
does not recover a guest session. Such requests fail rather than creating another
reservation under that UUID; unowned abandoned stock expires normally.

## Initial-ticket changes

An ordinary command cannot change a bound initial class. The source offer shows
all eligible initial alternatives and uses the authoritative source-switch
boundary for a changed class:

1. Revalidate the original owner/purchaser and requested ticket's eligibility.
2. Resolve current event setting/mapping server-side.
3. Lock publication, the original session, and the union of old/new inventory
   events; verify original revision, live expiry and expected candidate version.
4. Create a new owned, version-pinned session if mapped; replace inventory and
   cancel the old session in one transaction. All downstream holds are released.
   The new session inherits the original first-reserved time and exact deadline.
   Capacity or mapping failure rolls all of this back, preserving old stock.
5. If normal, release/cancel the old journey transactionally and return an
   explicit normal outcome. No replacement funnel reservation is created.
   The old deadline remains immutable in the old session and switch receipt;
   normal checkout uses its existing capacity/payment authority and has no
   newly extended funnel reservation.
6. Replay a committed switch by its owned receipt, not today's mapping.
   Paying/uncertain/confirmed/cancelled/expired originals cannot start another
   switch. The old cancelled URL cannot pay for released stock.

Guest-owned sessions remain guest-owned even if the browser signs in later.
The original purchaser is not replaced by the current viewer.

## Graph inference

A positive ticket test implies exclusion of its single-choice alternatives only
when a uniquely attributable earlier purchase step offers that ticket and no
other potential earlier purchase could hold the excluded class. This is
conservative at joins. Intersections retain only facts true on every incoming
edge. Accepting a later offer invalidates corresponding exclusions. Runtime
selection and checkout duplicate checks remain independent of these proofs.
Legacy multi-class graphs still need explicit negative tests for overlapping
re-offers. Direct disjoint day-ticket funnels need no initial branching condition.

## Installation preflight and ordering

1. Confirm the owner-approved target from current deployment/database evidence,
   not environment variable names. Verify a usable recent recovery point with
   the owner. A local transaction test is not a live backup restoration test.
2. Keep new purchasing disabled during installation/deployment verification;
   do not stop recovery for admitted orders. Do not alter activation as part of
   this installation without separate approval.
3. Inspect actual installed signatures/definitions/grants for definitions,
   versions, sessions, holds, journey application, publication, policy and
   controlled activation. Historical migration filenames may not match installed
   managed versions. Never replay prerequisites to make filename history match.
4. In particular, the publication migration patch asserts the exact old
   event-wide collision block. An unexpected prerequisite aborts the transaction.
   Review unexpected differences; never remove this assertion to force install.
5. Check existing entry uniqueness per tenant/event and per tenant/definition,
   graph source references and absence of pre-existing new routing objects.
   Record event/settings/version/session/hold counts and checksums. The additive
   migration is intentionally one-time, not an idempotent repair tool.
6. Rehearse the **single new migration** in a transaction on the approved target,
   inspect the new constraints, RLS/service-only grants, compatibility backfill
   and unchanged existing-session checksums, then roll back. Obtain any necessary
   execution approval before doing this against a live target.
7. Apply that exact approved SQL/hash in one transaction; verify schema cache
   reload and service-role RPC discovery. Check `anon`/`authenticated` denials,
   uniqueness, setting revisions and no new activation/toggle side effects.
8. Deploy the matching API and client together after installation. Do not leave
   old writers calling event-wide entry after enabling ticket mode: the legacy
   finder intentionally rejects ticket-mode discovery rather than choose a row.
9. Run authenticated, separately approved sandbox acceptance before enabling
   real event routing. Cover member/guest/no-match, switching, deadlines and a
   real provider outcome. Fixture/browser evidence is not live-provider proof.
10. Publish/configure real event funnels only under separate owner instructions.

## Backout limits

* Before commit: rollback the transaction, including renamed functions, tables,
  compatibility rows, constraints and grants. No customer version is modified.
* After commit, before any ticket-routed publication/session: prefer leaving the
  additive schema in place with events off and the matching application retained.
  A DBA-reviewed reversal can restore the original event-key primary key only
  after proving there is at most one entry per tenant/event and no new references.
* After multiple definitions or new sessions exist, **do not** restore the old
  primary key, drop mappings/bindings/receipts, reinterpret single-choice graphs,
  or roll back only the client. Old code cannot safely discover multiple entries.
  Pause new admissions under separately approved activation controls and keep
  compatible readers/recovery running for pinned orders.
* Disabling an event routes new registrations normally; it is not a purchase
  pause and does not cancel existing stock or provider work. Do not describe it
  as an emergency global stop.
* Financial/customer effects after activation require the existing reconciliation
  and refund procedures; dropping schema or restoring a database is not a
  compensating payment action.

## Verification commands

```
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test --test-concurrency=1 api/_lib/eventFunnel*.test.mjs shared/eventFunnel*.test.mjs client/src/components/events/eventFunnelBuilderModel.test.mjs
node --test --test-concurrency=1 tests/event-funnel-builder.browser.test.mjs tests/event-funnel-journey.browser.test.mjs tests/event-funnel-ticket-routing.browser.test.mjs
```

These use disposable PostgreSQL and intercepted/local browser fixtures, not live
databases/providers. The inventory suite includes publication, activation,
checkout, recovery, cancellation and the new ticket-routing scenarios.

### Recorded local verification

* 378 isolated domain/API/model/database tests passed, with no skips.
* 14 browser fixture tests passed, covering the existing editor/journey and the
  new entry/source-switch controls. The source-switch fixture substitutes event
  field rendering; inventory transactions are exercised separately on PostgreSQL.
* Changed JavaScript/JSX parsed successfully with esbuild; whitespace checks passed.
* `npm run build` did **not** pass: Vite exited with segmentation fault/status
  139 during transformation, without a source diagnostic. A direct Vite run with
  increased stack/heap also exited 139. This is a release blocker pending
  diagnosis, not successful production-bundle evidence.
* The development application restarted and served port 5000. An unauthenticated
  `/EventFunnels` screenshot reached the application but displayed
  `Tenant not found` for the preview's tenant configuration. The signed-in
  administration screens were therefore **not** verified in the running app.
  Authentication/tenant configuration was not bypassed or changed.
