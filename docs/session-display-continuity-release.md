# Session display continuity — release evidence

Baseline source: `1196980915ccabd93c9fd2c310034f05be286e1d`.
No production deployment was made. No database migrations were needed, created
or applied to any database. No campaign processing was changed.

## Deliberate policy change

The established viewer no longer starts five-minute `/auth/me` checks. Timer,
focus, visibility and online events do not expire its display authority. The
independent stale-tenant refocus check remains in place. Seven-day server session
lifetime is unchanged.

Previously displayed content can remain visible after server-side expiry or
revocation until a protected request or explicit invalidation establishes loss
of access. This is an accepted display tradeoff, not authorization to perform
server operations. Browser roles never authorize server writes. Failed mutations
are not queued or replayed. Retained unsaved controls are not durable storage.

Session/member/revocation lookup outages throw `SESSION_UNAVAILABLE` rather than
returning guest/null or deleting a valid session. Shared reads have a five-second
budget. Auth/me, tenant-user-me and the inspected entity/complex-session handlers
return 503 for that contract. Other legacy handlers may return generic 500 when
they catch the error; this is not a comprehensive endpoint audit.

Explicit session rejection is recognized by an invalid-session response header.
An unmarked protected 401 gets a bounded, coalesced auth/me confirmation, not a
request replay or a check before every operation. Unmarked 403, network failures
and 5xx do not invalidate established display. Request generations fence late
responses and parsed bodies after identity invalidation.

## Evidence and limitations

Controlled preview tests cover portal, public main site and a real microsite
prefix. They advance a day, dispatch repeated focus/offline/online/visibility
events, and assert the exact unsaved input node remains attached and visible,
without another auth/me read. Protected-response fixtures verify repeated
503/403/200 outcomes preserve drafts and a marked 401 closes the old page.
Existing preview cases cover route/history shell retention, public/blank chrome,
cold guest functions, pending explicit logout and stored-member guest transitions.

Isolated actual-helper tests cover session/member/revocation-fence database
failures without session deletion, recovery, absent/expired sessions and disabled
login. Additional tests cover bounded reads, auth/me 503, role projection
boundaries, transport denials and late body publication.

The old timer-retention browser assertions are retained as opt-in historical
baseline cases (`SESSION_POLLING_BASELINE=1`), not current-policy tests.
Legacy coordinator unit tests still exercise the helper independently; Layout
no longer invokes its periodic scheduler.

Current verification: 12 active browser cases passed (11 opt-in historical
polling cases are skipped), alongside 24 server/transport tests and 17 mounted
lifecycle/readiness tests. After the full browser run exposed three old
timer-triggered rejection tests outside the historical group, those were
converted to explicit-invalidation cases and all three passed.

Unmocked preview rendered `Public API Error (404): Tenant not found`, consistent
with the prior verification document. No live signed-in UI or incident-correlated
production failure was verified. Tests intercept all writes; no real users,
emails or providers were altered.

## Run and rollback

Run the isolated tests with `scripts/run-isolated-tests.mjs`, including:
sessionAvailability, sessionLookup.continuity, organisationLoginAccess,
auth/me.sessionRole, viewerProtectedWorkGate, viewerSessionLifecycle and
PortalReadiness tests. Browser config: `playwright.portal-session-boundaries.config.mjs`.

For release rollback, revert the eventual isolated task merge commit with
`git revert <session-continuity-merge-commit>`, then run the checks above and
restart the preview. Do not reset the whole repository or discard unrelated
work. The baseline source reference above permits comparison; a previous
production deployment reference has not been obtained. Production rollback or
deployment requires separate approval.

Baseline delayed-response reproduction and rollback rehearsal used a detached
worktree at the baseline commit, with a separate preview on port 5173 and the
original fixture suite. Both the slow five-minute retention case and the
timeout-closes-access/Retry case passed. The first startup attempt raced server
readiness and got connection-refused; that case passed after startup completed.
This verifies running the baseline source in preview without resetting the
working tree. It does not rehearse a Vercel production deployment rollback.
