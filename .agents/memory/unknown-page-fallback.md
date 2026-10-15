---
name: Unknown-page fallback authority
description: Keep missing-route evidence independent of rendering coverage and tenant caches.
---

New built-in pages must be registered in the shared server route registry as well
as the client router, and their roots reserved against CMS/member-slug collisions.

**Why:** A deployed report with valid RBAC still received an HTTP 302 to `/`
before React loaded because the server registry omitted it. The homepage then
forwarded the member to their role landing page, resembling an access denial.

**How to apply:** Inspect the original HTTP status and Location without following
redirects before changing permissions. Test direct links against unknown-page
fallback, including case, trailing slash and query strings.

Only a confirmed route miss may use legacy redirect mappings or the optional
homepage fallback. A renderer lacking support for a route is not missing-route
evidence; neither are failed lookups, pending requests or denied access.

**Why:** Broad prefix rules previously intercepted pretty forms, and crawler
rendering covers fewer routes than the browser. Reusing renderer absence would
redirect working forms and protected pages.

**How to apply:** Keep registered-route parity checks when routes change. Resolve
dynamic page/form/microsite existence before mappings, and read the fallback
setting fresh so disabling it does not depend on per-instance tenant cache expiry.
Legacy document suffixes such as `.html`, `.aspx` and `.php` are page URLs, not
asset exclusions.

Check deployment rewrites as well as handler tests when changing page suffix
handling.

**Why:** Vercel's former generic dotted-path static bypass prevented legacy
`.html` URLs from reaching otherwise-correct page handlers.

**How to apply:** Exercise ordered deployment rewrite rules alongside route
policy tests; retain explicit asset exclusions rather than treating every
filename suffix as a static asset.

Confirmed public-page misses may survive a public-to-member layout remount, but private page payloads must not share that cache.

**Why:** Changing layouts can remount the page and repeat discovery even when automatic retries are disabled. Sharing private responses to avoid the repeat risks crossing session boundaries.

**How to apply:** Retain only exact endpoint-contract miss evidence within the current route/tenant/audience/readiness scope. A generic 404, tenant failure, denied access, or cancelled request is not a public-page miss; authenticated fallback still requires a validated member.