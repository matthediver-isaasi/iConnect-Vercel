---
name: Making an auth-only page render for logged-out guests
description: Pattern for exposing an admin/member-only React page (e.g. Dynamic Directory) to public guests without leaking admin data.
---

Turning an authenticated page into one that also renders for logged-out guests takes four coordinated moves, not just "hide the buttons":

1. **A dedicated guest endpoint.** The entity/base44 queries the page uses require a session. Add a public endpoint (mirroring the guest-compatible `members.js` / `member-preferences.js` conventions: `getTenantContext` + `supabase` from `_lib/database.js`) that resolves tenant from host, 404s on missing/inactive, and returns the same shapes the auth queries would. Replicate any server-side visibility/enrichment logic there.
2. **Gate every auth query with a guest flag** (`enabled: ... && !isGuest`) and pick guest-vs-auth data via merged consts. Watch ordering: `useMemo`s that consume the merged consts must sit AFTER the merged block or you get a temporal-dead-zone ReferenceError at runtime.
3. **Render-gate every admin/auth-only affordance** with the guest flag — counts, contacts, emails, events/articles/awards stats, "view members", logo edit, "show disabled" toggle. Some collapse naturally (their source query is empty for guests) but gate explicitly anyway.
4. **A loading gate keyed on auth resolution.** The non-obvious bug: the page flashes "Not Found" before auth resolves because `directory` is briefly null. Guard with `(!authResolved && !directory)` in the `isLoading` check. `authResolved` (from LayoutContext, exposed via useMemberAccess) flips true once `/api/auth/me` completes success OR failure, so it always resolves.

**Why:** guests without move #4 saw a "Not Found" flash; without #1 the page can't fetch anything; #2's TDZ crashes the whole page.

**How to apply:** `isGuest = authResolved && !memberInfo`. Reuse `is_active` for the public gate; inactive still 404s. Guest mode is UNTESTABLE from the Replit workspace — localhost skips host-based tenant resolution (tenant null), prod uses subdomains.
