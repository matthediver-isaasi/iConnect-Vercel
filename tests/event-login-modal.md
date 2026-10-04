# Event login modal verification

Run `npm run test:event-login-modal:browser` with the development application running.
The suite intercepts API traffic and blocks external requests. It never logs in to a
real account, writes production data, books tickets, or follows Google to its provider.
It does not change default application startup.

Coverage includes simple single/multiple tickets, complex events, ID/slug routes,
both `embed=true` routes and Canvas event blocks, cancellation/focus restoration, focus trapping, background
click and scroll blocking, rejected/disabled login, stale storage, delayed session
verification, refresh failure and retry, ineligible membership, password setup and
recovery, safe Google return destinations, standalone and Canvas login redirects,
and retention of a valid public ticket selection and the event query/hash.

Investigation: simple member-ticket links and the complex CTA login already supplied
`returnTo`; the simple guest warning used bare `/Login`. No general live return
failure was reproduced. This change adds an in-place lifecycle, not a claim that
all prior return links were broken. Ticket policies and guest-email checks are
unchanged.

No database migrations are required, created, or applied. No production deployment
was performed. The unmocked development `/login` preview currently reports
`Tenant not found`; it does not establish live tenant behavior.

## Restricted ticket regression (2026-10-04)

Before changing rendering, the reported Canvas single-ticket fixture failed because
`link-login-ticket-single` did not exist. After the fix,
`npm run test:event-login-modal:browser` passed all 45 tests.

The additional fixtures reproduce the University Member, Partner/Freelance
partner/Alumni, and AHECS ticket names with `members_and_public`,
`role_match_only=true`, nonempty role IDs, and `allowGuestsToViewAllTickets=true`.
Both single and multiple Canvas ticket layouts exercise dismissal/focus, eligible
and ineligible validated login, preserved URL, and retained valid public selection.
The matrix also covers group-only restrictions, empty lists, members-only,
public/public-only, legacy missing visibility, sold-out, future release, and
malformed release schedules in both layouts.

These results are isolated fixture evidence, not a live-domain acceptance check.
No fresh live-domain requests or real-account sign-ins were performed for this
change. The development screenshot still shows the existing tenant-resolution
error; it is not evidence of the booking UI. No database changes or migrations
were applied to any database, and none remain to apply for this fix.