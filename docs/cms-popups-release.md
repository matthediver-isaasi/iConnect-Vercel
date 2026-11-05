# CMS Canvas Popups — Phase 1 release boundaries

## Storage and deployment

`supabase/migrations/202611050001_cms_popups.sql` is **not applied to a live
database**. It adds service-only definitions, page links, preferences and two
transactional RPCs. Deploy it to verified DEST only after schema approval, before
releasing the matching application. Never apply it to workspace SOURCE.
Source merge is not evidence of public rollout. No popup content is published
automatically by this change.

No browser role has direct grants to the popup tables or RPCs. Dedicated
`site-builder.popups` and `site-builder.popup-editor` permissions protect the API.
Page-editor permission alone is insufficient. Page scope is immutable to preserve
microsite typography meaning. Duplicate creates a draft with no visitor state;
restore returns to draft. Reset advances the separate dismissal generation.
Ordinary edits and archive preserve preferences. Save and link replacement are
one transaction with expected revision checks.

## Eligibility contract

Delivery resolves the host tenant, current session and published page independently.
The page ID and microsite ID must agree. Member pages require a member, not only
a tenant-user session. Responses are private/no-store. The batch contains no
design or targeting clauses; only the selected, freshly authorized document and
its referenced, tenant-owned symbols are returned.

One request evaluates at most 100 scoped active definitions. Larger or incomplete
sets fail closed; they are not silently truncated. Metadata and viewer-affiliation
reads have explicit completeness checks and limits. No campaign-recipient
enumeration is used. Unsupported/deleted conditions invalidate eligibility.
All organisation clauses in an AND group match the same real affiliation.
Secondary assignments use the configured profile-affiliation relationship pair;
department ownership does not create affiliation.

Membership status/type reuse the existing Canvas commitment selector and summary,
including retained history and amendment/recognition overlays. Membership class
and organisation type/category are exposed through active typed tenant custom
fields where defined; they are not invented as universal database columns.

Supported Canvas content is the explicit list in `shared/cmsPopupContract.js`.
Both design versions use the existing renderer. Nested symbols and unsupported
blocks fail explicitly. Symbols are resolved at save/preview/delivery; missing
symbols never authorize a fallback catalogue as popup content.

Schedule input is converted from tenant wall time into explicit UTC timestamps.
Ambiguous/nonexistent DST times are rejected. The saved lifecycle is independent
of schedule availability. Calendar-day frequency uses tenant timezone; N days
uses elapsed 24-hour intervals.

## Visitor persistence and interference

See `client/src/components/popups/README.md` for history-entry identity, storage
keys, consent and accessibility. Permanent member preferences are monotonic,
server-backed and generation-scoped. Impression retries use the original
`shown_at` and a monotonic maximum, so retrying cannot advance frequency time.
Ordinary open revalidation retains the mounted interactive document.

Foreground revalidation runs every 30 seconds with 10-second request deadlines
(at most 50 seconds for both checks). Background browser suspension prevents a
hard wall-clock guarantee; focus/visibility return rechecks and scheduled end is
also checked locally. This is not instantaneous revocation.

## Verification evidence

Run isolated API/evaluator/mounted checks:

```
node scripts/run-isolated-tests.mjs node --test \
  api/cms-popups/popups.test.mjs shared/cmsPopupContract.test.mjs \
  client/src/lib/popupRuntimeState.test.mjs \
  client/src/components/popups/*.test.mjs
```

Run disposable PostgreSQL checks:

```
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test \
  supabase/migrations/cmsPopups.test.mjs
```

Real-browser fixture suite (existing application workflow must be running):

```
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="$(command -v chromium)" \
  npx playwright test --config=client/src/components/popups/browser/playwright.config.mjs
```

Browser fixtures intercept API calls and block external origins. They exercise
actual Radix/Canvas rendering, responsive layouts, keyboard/focus, overflow,
priority, navigation/history, consent and storage denial. They are **not**
authenticated tenant evidence, a live cross-device check, or production rollout
evidence. Disposable PostgreSQL verifies permissions/ownership, revision
conflicts, reset generations, duplicate state isolation and foreign-key cleanup.
