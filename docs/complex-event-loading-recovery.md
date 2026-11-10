# Complex-event loading recovery

## Production evidence (2026-11-10)

- Read-only REST lookup on pinned DEST `lvmzliemqnieeoruhkik` resolved tenant `gsf` to `21296ad6-1350-483a-a90c-1b06ece70501` and Annual Meeting 2028 to `c3422e00-a0c0-4093-8925-1d20b8100367`. It was already published with `waiting_list_enabled: true`.
- Both live GSF public complex-event list and slug-detail endpoints returned 503, `Unable to load event tickets`.
- Replaying each repository ticket projection against DEST returned PostgreSQL `42703`: `column complex_event_ticket_class.audience_mode does not exist`. A separate read-only SQL catalog transaction confirmed both audience columns were absent, rather than merely missing from the PostgREST cache.
- With explicit owner approval, the existing `scripts/apply-ticket-selected-member-audience-migration.mjs` runner applied `202612310005_ticket_selected_member_audience.sql`, SHA256 `1df3da1ce2fe2d94a69fb15cfd09c01137532f2c183f5f2e7e7db5d65c05ff33`. Destination pins, verified TLS, nullable/no-default columns, constraint, triggers and function privileges were verified. PostgREST schema reload was requested.
- Afterwards, live list and slug detail both returned 200. The list contained six events, including Annual Meeting 2028; detail returned one visible ticket and waiting-list mode.
- A read-only browser screenshot of `https://gsf.iconn.app/session-events/annual-meeting-2028` showed the event title, Standard Ticket, waiting-list explanation and “Log in to join the waiting list”, not “Event Not Found”.

The deployed failure and recovery match the repository query contract, but an exact deployed commit comparison was not obtained. No application deployment was performed. The additional service-error UI and explicit database-error/404 separation are workspace changes awaiting merge.

## Regression checks

```sh
node scripts/run-isolated-tests.mjs node --test \
  api/public/complex-event-loading.test.mjs \
  client/src/lib/eventWaitingList.test.mjs \
  client/src/pages/ComplexEventDetail.loading.test.mjs \
  scripts/apply-ticket-selected-member-audience-migration.test.mjs \
  api/_lib/eventWaitingList.test.mjs \
  client/src/components/booking/WaitingListCheckout.mounted.test.mjs
npx playwright test --config=tests/event-card-waiting-lists.config.mjs
```

The API tests use isolated dependencies and real audience/capacity projection. Mounted detail tests exercise both slug and ID failure, retry and not-found states with real React Query. Waiting-list submission tests use fixtures only. The browser suite intercepts all traffic and tests existing card waiting-list management; the internal Join CTA navigation is separately guarded by source assertions. Browser harnesses run outside the Node isolation wrapper, which intentionally blocks browser child processes.

No customer event configuration or historical ticket data was rewritten; the additive migration performs no backfill. SOURCE was untouched. No production login, join, booking, payment or email attempt was made. Authenticated production waiting-list submission is intentionally unverified. The local app starts normally, but its legacy database/tenant resolution cannot establish GSF production behavior.
