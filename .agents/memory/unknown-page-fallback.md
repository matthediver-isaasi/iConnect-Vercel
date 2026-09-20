---
name: Unknown-page fallback authority
description: Keep missing-route evidence independent of rendering coverage and tenant caches.
---

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