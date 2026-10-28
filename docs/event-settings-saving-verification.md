# Event Settings save verification

## Reproduced failure

The helper text was already serialized and hydrated. Running the original shared
handler against an in-memory adapter with default settings produced **28 sequential
writes**, with the banner last. At a controlled 25 ms delay per write this took
**710 ms**. Rejecting the first unrelated write prevented the banner request
entirely. The original settings-query effect also rehydrated all drafts whenever
the query changed; the save handler itself reset seat-label drafts.

The focused banner path now issues **one write** (or zero for an acknowledged,
unchanged value). It incurs one simulated request delay rather than 28.
These are controlled local request counts and timings, not production latency
measurements. Public/member listings already consume the same whitelisted JSON;
no API whitelist or schema change was necessary.

## Implementation boundaries

- Each shared save button selects an explicit setting scope. Existing serialization
  is collected before network I/O; unchanged acknowledged values are not written.
- The mounted editor initializes its drafts once, after a successful fresh fetch
  after mount (never from an in-flight cached result). Query invalidations cannot
  overwrite other drafts. Acknowledged rows supply IDs for subsequent saves,
  including first creation. Failure retains drafts; partial multi-setting failure
  reports failure, not full success.
  Subsequent successful reads refresh the persistence baseline without replacing
  drafts; reads started before a write acknowledgement are generation-fenced.
  The PO notification button writes only its own email setting.
- All async buttons use a synchronous page-wide submission lock, pending labels,
  disabled/inert fieldsets (including rich text and dialog content), and guarded
  dialog dismissal.
- Duplicate rows in the loaded setting set are rejected, not merged or deleted.
  This is not a cross-tab/database uniqueness guarantee or optimistic concurrency
  control. No live settings audit, migration, or tenant write was performed.
- Safe custom fragments retain the legacy target as an alias. Navigation waits
  for data and the rendered section, and handles each matching navigation once.
  Eligibility, filtering, and placement remain unchanged.

## Automated checks

```
node scripts/run-isolated-tests.mjs node --test client/src/lib/eventSettingsSaving.test.mjs client/src/lib/tbcEventsBanner.test.mjs
npx playwright test --config=tests/event-settings-saving.config.mjs
```

The browser suite bundles the actual settings and listing pages with in-memory
adapters. All external requests are blocked. It covers save/reload, earlier-write
failure isolation, slow and failed saves, repeated clicks, draft preservation on
refetch, cached initial-load locking, server-baseline refresh, PO/bank-account
draft isolation, duplicate detection, invalid fragments, independent settings saves, and
guest/member listing text and styling. Hook navigation fixtures cover delayed
content, custom/legacy fragments, in-app navigation, unrelated hashes, hidden
sections, one-time scrolling, and 390/1280-pixel viewport header clearance.
The listing fixtures stub event cards and provider-facing dependencies; they are
not live authenticated tenant verification.

The application workflow starts on port 5000. The unauthenticated preview capture
could not verify the signed-in settings UI: the workspace tenant lookup returned
“Tenant not found” (the configured backend reported its tenant table missing).
Auth was not bypassed and database configuration was not changed.
No production deployment or rollout is claimed.
