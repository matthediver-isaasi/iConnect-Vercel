# Member login landing verification

## Confirmed redirect paths

- MemberDetail previously POSTed `/api/auth/masquerade`, then assigned `/` even
  though the response created the target member session. Git history attributes
  that assignment to the original masquerade feature, not a recent change.
  No evidence establishes which later change exposed it.
- Masquerade now reads the target's tenant-owned role before issuing the session
  and returns a normalized `landingUrl`. MemberDetail performs a document
  navigation to that destination. The administrator return URL is stored
  separately, including its query and fragment.
- Password login and first-password setup prioritize explicit validated
  `returnTo`, then the authenticated member's role destination, then Preferences.
  Existing-session login uses the validated Layout session snapshot. Failed role
  discovery no longer silently substitutes a fallback.
- Public header login remains plain `/login`, including from Events. Inline
  content prompts retain explicit return context; event modal completion stays
  in place.
- A separate demonstrated Events path existed in PublicHeader: local storage
  enabled Member Area immediately, while its asynchronous role read still had
  `Events` as the initial destination (also retained after lookup failure).
  Member Area now performs a document navigation through `/login`, so validated
  session/role discovery decides the destination, including after a session
  changes in another tab.
- Google callback previously prepended a slash even to slash-prefixed role
  destinations, and lowercased query/fragment context. It now uses the shared
  normalization and tenant-bound role resolution; explicit safe contextual
  returns still take precedence.
- Root fallback and permission guards were not changed. Root with no configured
  homepage renders Events; masquerade no longer relies on that behavior.
- The intentional GSF MemberDemo policy is unchanged.

## Evidence and limits

`node scripts/run-isolated-tests.mjs node --test tests/member-login-landing.test.mjs shared/safeReturnTo.test.mjs`

Nine assertions pass, including execution of the real MemberDetail action
(failed at `/` before the fix), real handler bodies with isolated dependencies,
target identity, denial/cross-tenant cases, lookup errors, unsafe destinations,
fallback, OAuth precedence, and admin session restoration.

Focused Playwright cases in `tests/event-login-modal.spec.mjs` pass: 17 cases
cover first document navigation from Home/Events, existing-session delayed role
readiness, first-password setup, exact contextual return, simple/complex events,
embedded/Canvas events, retained ticket selection, masquerade banner and return
navigation, and Google initiation. The old focus assertion was updated to target
the actual focusable ticket card rather than its now-presentational text span.

These are isolated fixture checks, not live member-account verification or a
real Google provider login. They reproduce the header's unintended Events path
but do not prove that it caused the reported account-specific incident. If that
incident persists, the tenant/domain, entry URL and clicked sign-in control,
expected role destination, and observed URL sequence are needed—no credentials.

No database migrations or data changes were needed or applied to any database.
No production deployment was performed.

## Organisation-owned tenant compatibility

Members with a null CRM `tenant_id` and an organisation-owned tenant retain their
assigned role. Password login and set-password now project the already-resolved
session tenant into their authenticated response, without updating the member
record. Auth/me projects the organisation tenant only when its current joined
value agrees with the validated session. Foreign/mismatched role rows remain
rejected. This avoids comparing a tenant-owned role to a legacy null tenant.

The expanded isolated suite (including `api/auth/me.sessionRole.test.mjs`) passes
17 tests. Six focused browser cases were rerun after this compatibility fix,
including plain login and existing-session Member Area for organisation-owned
tenancy, and all passed. The earlier contextual/in-place checks remain unchanged.

The unmocked preview screenshot could not verify the page: the workspace's
configured backend reports that `public.tenant` is absent from its schema cache,
so `/login` displays “Tenant not found”. No connection settings or database
schema were changed to work around this environment limitation.
