# Tenant favicon delivery and rollout

## Read-only public evidence — 13 October 2026

Both `https://graduatefutures.org/` (following the apex-to-www redirect) and
`https://www.graduatefutures.org/` advertised the configured storage PNG in normal
HTML. Googlebot HTML advertised the same artwork. The actual downloaded PNG
was **67 × 60**. Running that unchanged artwork through the local delivery
normalizer produced **192 × 192 PNG**; proportional containment adds transparent
padding without cropping or stretching.

The apex legacy icon and manifest paths return 307 to www. On www:

| Path | Existing public response before rollout |
| --- | --- |
| `/favicon.ico` | 302 to the original storage PNG |
| `/favicon-32.png` | 200 image/png, 32 × 32, old static asset |
| `/favicon-192.png`, `/favicon.png` | 200 image/png, 192 × 192, old static asset |
| `/favicon-512.png` | 200 image/png, 512 × 512, old static asset |
| `/apple-touch-icon.png` | 200 image/png, 180 × 180, old static asset |
| `/site.webmanifest` | 200, static iConn branding and legacy icon paths |

This establishes served defects, not which source Google selected or cached.

## Implementation contract

- Conventional public paths resolve the current host tenant with a fresh read.
  Browser HTML, crawler HTML, startup code and both existing React writers use
  the normalized same-origin paths. Microsite favicon ownership remains tenant-level.
- All dynamic image paths return actual PNG bytes, including `/favicon.ico`;
  Content-Type is therefore `image/png`, not an invented ICO type.
- Manifest name/short name and valid primary color follow the tenant. Display,
  start URL, white background and icon sizes remain unchanged.
- Unknown tenants, invalid artwork and unavailable sources get the same neutral
  platform icon. Checked-in binary fallbacks also contain only that neutral icon.
- Uploads already use public Supabase storage. Delivery accepts HTTPS public
  storage object paths on single-label Supabase project hosts or vault.iconn.app.
  Arbitrary external URLs, relative paths, signed/query URLs and redirects are
  deliberately not fetched; they produce the neutral fallback.
- DNS answers are checked and pinned to the socket. Downloads are limited to
  2 MiB and four seconds. Rasterization is bounded to 16 megapixels and three
  seconds; ICO directory/embedded dimensions are separately bounded. SVG resource
  references/entities are rejected. PNG, SVG and bounded PNG/DIB ICOs are supported.
- No derived cache is used: tenant/source changes and in-place object replacement
  cannot reuse stale output. Responses are private/no-store; HEAD has the same
  image metadata without a body. Root-level discovery avoids the existing private
  `/api/` robots exclusion; robots policy is unchanged.

## Verification

Run:

```
node --test api/_lib/faviconImage.test.mjs api/_lib/homepage.test.mjs api/_lib/micrositeBranding.test.mjs
node --test scripts/tenant-favicon.browser.test.mjs
```

The browser test requires the running development workflow and system Chromium.
It supplies fixture branding to the real mounted app; it does not claim a live
GFI deployment test. The unconfigured preview host itself shows “Tenant not found”,
so its screenshot is not proof of a configured tenant homepage. Isolated tests
cover tenant HTML/crawler parity and existing homepage/microsite routing.

## Approval boundary and Google follow-up

No deployment, production settings/assets changes, or cache purges were performed.
No database migration is needed; none was applied to any database and none remains.

After separately approved rollout, verify GET and HEAD on the exact apex and www
hosts above and a second configured tenant. Decode the bytes, not just headers:
check proportional artwork, dimensions, PNG MIME, manifest identity, no-store
headers, normal/crawler HTML, hydrated DOM, and unknown-host neutral fallback.
Confirm apex redirects retain the full path. Compare downloaded output against the
configured artwork and ensure all legacy paths are no longer Replit-branded.

Only then use the owner's Search Console property to inspect the canonical www
homepage, run the live URL test and request indexing. Check that Googlebot can
fetch the root-level favicon and manifest URLs. Google controls recrawl timing and
favicon selection; correct served bytes cannot guarantee an immediate search-result
change. No Search Console account action is included here.
