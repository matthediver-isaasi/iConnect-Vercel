# Portal menu referrer verification

## Local results — 2026-11-02

- `node scripts/run-isolated-tests.mjs node --import tsx --test client/src/lib/portalMenuLinks.test.mjs api/_lib/portalMenuLinks.test.mjs`: 26 passed.
- `node --import tsx --test tests/portal-menu-referrers.browser.test.mjs`: passed; 32 combinations plus an ordinary-anchor control.
- Chromium used actual HTTP/HTTPS local receivers and the real `PortalNavLink` rendered markup, with the `no-referrer` meta tag extracted from `client/index.html`. Received request headers contained only the source origin for HTTPS destinations and no Referer on HTTPS-to-HTTP downgrades. All new tabs had `window.opener === null`.
- Matrix: desktop/mobile viewport, user/admin record section, top-level/child record, same/new tab, HTTPS/HTTP destination. This is a shared-component fixture, not an authenticated full Layout interaction test. The existing Layout source regression verifies all eight leaf call sites use this component; parent and child mapping spread the shared destination attributes.
- Internal-link rendering, URL validation, structural-parent restrictions, canonical NMC Journal access and unchanged document defaults are covered by focused regressions. No menu data, roles, provider settings, resource links or global referrer policies changed.
- Application workflow restarted and served on port 5000. Preview showed `Tenant not found`; logs report missing `public.tenant` in the configured database schema cache. The signed-in portal UI could not be visually verified in this environment. No database configuration was changed.

## Live verification status

**Awaiting live verification after merge/deployment.** This task runs on a fork and did not deploy. No authorized BNMS browser session was supplied or used. Neither the deployed BNMS bundle nor real NMC Journal authentication has been verified by these local tests.

After the changed bundle reaches the BNMS domain:

1. Using an authorized session, confirm the actual NMC Journal menu anchor has `referrerpolicy="strict-origin"` and retains its configured destination and tab preference. New-tab anchors must have `rel="noopener"` without `noreferrer`; the document default must remain `no-referrer`.
2. Preserve the browser Network log and open the menu link. Inspect the initial journal request's **Referer request header**, which should be the current portal origin with a trailing slash, without member path/query/fragment. Do not fabricate a BNMS referrer from another host.
3. Separately record redirects and whether the journal recognizes the subscription. Successful initial header transmission does not prove downstream authentication. Browser privacy restrictions may still suppress headers.
4. Keep cookies, tokens and private member URLs out of retained evidence. Do not change journal authentication, tenant menu data or provider settings to make the check pass.

The browser test requires local `chromium` and `openssl` executables. It generates a disposable certificate, binds receivers to loopback, maps only synthetic `.test` hosts to them and cleans up on completion; it does not contact the journal.
