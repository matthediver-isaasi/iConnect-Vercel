# Portal navigation lifecycle measurements

The final frozen-implementation comparison, including zero-loading-reset
assertions and three-run medians, is in
[portal-navigation-lifecycle-comparison.md](portal-navigation-lifecycle-comparison.md).
The individual runs below record the investigation and cold-request breakdown.

## Controlled environment

These checks use Playwright request interception against the already-running
development preview. Critical fixture responses have a fixed 200 ms delay.
They exercise the real router and UI, but not a production tenant, production
database, production network, or production build.

The local preview cannot currently perform a live-tenant check: `/login`
renders `Public API Error (404): Tenant not found` because the configured
legacy runtime database has no tenant table. No database changes were made.
The screenshot is saved at `screenshots/task-4666-login-preview.jpg`.

## Current checkout: measured

Command:

```sh
PLAYWRIGHT_BASE_URL=http://127.0.0.1:5000 \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium \
PORTAL_MEASUREMENT_LABEL=task4666-after \
npx playwright test --config=tests/portal-loading.config.mjs \
  --grep "controlled portal cold"
```

One controlled run produced:

| Step | Visible content | `/api/auth/me` | Role GET | Public-page GET |
| --- | ---: | ---: | ---: | ---: |
| New browser document | 5,906 ms | 1 | 1 | 4 |
| Same-context reload | 8,075 ms | 1 | 1 | 4 |
| Internal `/portal` → `/portal-next` | 670 ms | 0 | 0 | 2 |

On that cold document, `/api/auth/me` began at 4,321 ms, completed at
4,522 ms, and content became visible at 5,906 ms. Thus 1,384 ms of the observed
cold path followed auth completion; this run does not attribute that remainder
to one subsystem.

The internal route transition retained the validated session: it issued no
authentication or role request. The raw request timeline was written to
`/tmp/portal-loading-task4666-after.json`; `/tmp` is runner-local and is not a
repository artifact.

The dedicated initial → next → back → forward browser regression passed and
asserted exactly one `/api/auth/me` request and zero Role GETs across all four
views. The existing-session login matrix passed 9/9 scenarios and asserts:

- one `/api/auth/me` request;
- no redundant Role GET when the verified session contains the role;
- fallback Role GET when the role is genuinely missing;
- no trusted `sessionRole`, `role`, or `memberRole` projection in localStorage.

The broader sidebar run now passes all seven scenarios, including trusted role,
delayed account switch, reload, forward/back, visible role failure/retry, and a
bounded stuck-auth retry. Role feedback remains visible in the compatible
portal shell while the protected route workspace is not mounted.

The dedicated bounded-session browser regression additionally verifies that:

- navigation before five minutes issues no new `/api/auth/me` request and does
  not show the full-page `Loading portal…` fallback;
- expiry immediately removes the protected workspace while revalidation is
  pending, then restores the destination after validation;
- a failed expiry remains closed and exposes a working retry; and
- logout removes protected content and navigation before the intercepted
  fixture-only logout POST settles.
- a member-to-guest boundary can still mount a confirmed public destination;
  protected-route gating is confined to the authoritative portal branch rather
  than inferred globally from a sticky member identity.

## Matched original-lifecycle/current comparison

The controlled fixture can serve the original route-scoped session lifecycle by
intercepting Vite's transformed `Layout.jsx` and `viewerSessionPreload.js`
modules. The interception restores the original pathname scope and pathname
auth-effect dependency. It does not copy or modify shared source.

The original lifecycle and current lifecycle then ran consecutively against the
same already-running server, browser executable, fixture, 200 ms delays and
test command:

| Lifecycle variant | Cold | Reload | Internal transition | Internal auth | Internal Role GET | Internal page GET |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Original route-scoped lifecycle | 4,409 ms | 3,871 ms | 1,528 ms | 1 | 1 | 5 |
| Current session-bound lifecycle | 4,526 ms | 4,936 ms | 654 ms | 0 | 0 | 2 |

This matched controlled pair demonstrates the navigation result: the current
internal transition removed one delayed auth request and one delayed Role GET,
and was 874 ms faster in this single sample. Cold/reload results vary in the
opposite direction and are not claimed as improvements. This isolates the
session lifecycle expressions while retaining the current remainder of the
application; it is not a full historical-checkout or production benchmark.

Commands:

```sh
PORTAL_SESSION_LIFECYCLE_VARIANT=original \
PORTAL_MEASUREMENT_LABEL=task4666-original \
npx playwright test --config=tests/portal-loading.config.mjs \
  --grep "controlled portal cold"

PORTAL_MEASUREMENT_LABEL=task4666-current \
npx playwright test --config=tests/portal-loading.config.mjs \
  --grep "controlled portal cold"
```

## API cold-path evidence

Before the API change, `/api/auth/me` called `getSessionMember(req)` and then
called `getSession(req)` again for Canvas/session metadata. That repeated the
session-row and revocation-fence path. It now resolves one session and passes
the same object into the member lookup. Host tenancy starts only after a member
exists, so a guest/failed member lookup cannot leave an unhandled host promise.

The isolated API suite passes 13/13:

```sh
node scripts/run-isolated-tests.mjs --shell \
  "node --import tsx --test api/auth/me.canvasMemberValues.test.mjs \
  api/auth/me.sessionRole.test.mjs api/_lib/canvasMemberValues.test.mjs"
```

The tests disable and replace the import-time role-access overlay, so the
result does not access live credentials or network services.