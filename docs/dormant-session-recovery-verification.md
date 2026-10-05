# Dormant session recovery verification

Historical policy: superseded by [session display continuity](session-display-continuity-release.md).
The ten-second retention and periodic checks described below are no longer the
established viewer policy; retain this document as baseline context only.

## Failure classification

Source inspection establishes the old client failure path, not the cause of a
production incident. A routine check previously closed readiness on an
inconclusive response, and the scheduler required validated readiness to run
again. Manual Retry was then the only recovery path.

The controlled tests distinguish:

- Fetch rejection/offline, bounded timeout, and retryable server responses:
  verification is inconclusive, not proof of logout.
- Successful `/api/auth/me` returning `null`, or HTTP 401/403:
  authoritative invalid-session outcomes; old authorization must be removed.
- Missing, invalid or failed role projections: never equivalent to a valid role
  with no exclusions. Legacy member responses require a fresh role lookup.
- Account/tenant changes and explicit invalidation: independent boundaries that
  cancel old request ownership and must not restore old page state.

The server endpoint returns HTTP 500 when its handler throws and HTTP 200/null
when its member resolver returns no member. Lower-level session/member helpers
can also return null after failures. The client must honor this existing
authoritative contract rather than reinterpret null as a network outage.
Changing that backend contract is outside this recovery change.

No incident-correlated browser trace, response status, or historical server log
has established the exact production failure type. In particular, source
inspection cannot distinguish a real expired/revoked session from a transport
failure observed by a dormant browser in production.

## Test isolation

`tests/portal-session-boundaries.spec.mjs` exercises the real application shell
with Playwright-controlled clocks and intercepted API responses. It blocks
unrecognized writes and external requests. The retention controls are explicit
test controls attached to two rendered Canvas portal routes; they prove DOM
retention, not every product-specific form's behavior.

Run with `playwright.portal-session-boundaries.config.mjs`. The config honors
the existing `PLAYWRIGHT_BASE_URL` and
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` settings.

Mounted/unit tests cover the recovery coordinator, request leases, readiness
boundary and protected-work gate separately. Passing fixture tests is not a
live authenticated production verification.

Final verification: 40 mounted/unit tests and all 19 browser cases passed.
The browser suite includes exact draft/control/scroll retention on both portal
fixture routes and locally rejected protected GET/POST requests while blocked.
Successful routine checks, timeout late responses, offline recovery, exhausted
retry budgets, concurrent return events, legacy role revocation, invalid
sessions, account switches, and logout are covered. Layout JSX syntax and
diff whitespace checks also passed. Additional transition regressions verify
reconnection before the retention deadline and real client invocation of
guest job/payment functions reaching the intercepted transport after a cold
null session.

## Deployment and database

The unmocked development preview was checked and rendered “Public API Error
(404): Tenant not found”. This host/tenant setup does not provide an authenticated
live portal verification. Controlled browser fixtures supply tenant and session
responses explicitly; they must not be reported as production evidence.

No production deployment is authorized by this task. No database migrations are
required or applied to development, production, SOURCE, or DEST.