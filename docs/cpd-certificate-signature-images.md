# CPD certificate signature images

## Storage and lifecycle

Signature uploads are decoded as single-frame JPEG or PNG, limited to 2 MiB and
16 megapixels. Ordinary files are retained byte-for-byte, including PNG alpha.
EXIF-oriented images have their orientation baked into pixels so the browser and
PDF do not disagree.

Small immutable image blobs are held in service-only PostgreSQL tables rather
than Supabase object storage. This is deliberate: content, metadata and
template ownership publish in one transaction, avoiding an uploaded-object /
database-reference failure window. The browser receives an opaque asset ID,
SHA-256 and dimensions, never a storage path or remote URL. Permission-gated
preview requests stream bytes with private/no-store headers.

Uploading locks/checks the template version and rejects active templates but
does not change its layout or version. Whole-layout saves use the image-aware
checked RPC; any missing ownership, wrong hash or dropped image/geometry rolls
back the save. A successful reference marks the immutable asset as published.

Unpublished assets are staged for at least 24 hours and expire on the next
upload to that template. At most 20 staged uploads per template are allowed.
Deleting a template removes its unpublished assets transactionally. Published
assets and ownership bindings are retained as evidence, including after
replacement, removal or template deletion. Duplicated templates receive their
own authorized binding to the same immutable bytes. This intentionally favors
snapshot preservation over automatic disposal of previously used signatures.

Issued certificate downloads remain authoritative stored PDFs, not fresh
renders. Removing an image never rewrites an issued certificate. New generation
fails if an image cannot be authorized or its bytes do not match its hash.

## Database rollout

Applied on 2026-11-06 to verified DEST `lvmzliemqnieeoruhkik`, using
`scripts/apply-cpd-certificate-images.mjs` with verified TLS and exact SQL hashes:

- `202701190002_cpd_certificate_images.sql`:
  `836a740835c3cd116414e260da93193360949433cf399870979d1674a6ff77c4`
- `202701190003_cpd_certificate_image_cleanup.sql`:
  `a6f7a06246e1ffc7f0c3d53ad59df156f18e40396e4c72b27cd2517731788615`
  (runner option `--lifecycle`)

Verified private table/function grants, image persistence projection and unchanged
existing template/placeholder content. SOURCE was not modified. No production
signature was uploaded, no certificate issued, and no email sent. Matching
application code still needs merge/release; this task did not deploy it.

## Verification

- Disposable PostgreSQL tests exercise full save/reload, stale versions,
  same-tenant unbound and cross-tenant references, duplication, removal,
  template deletion, staged cleanup, active locks and browser/service grants.
- API tests exercise real multipart parsing, capability checks, invalid uploads,
  ownership and integrity errors, and authenticated uncached image streaming.
- Independent PDF.js rasterization verifies JPEG and alpha-PNG image boundaries
  on all four rotations, non-zero crop origins and multi-page sources.
- Member-route tests issue real PDFs for both event types and historical awards,
  inspect image operators in downloads, reject missing images and verify retained
  downloads remain identical after image/template changes.
- Mounted designer and five Playwright fixture tests exercise upload, drag,
  proportional resizing, page selection, save/reload, replacement, removal,
  duplication, checked-save failure and active locks.

The browser fixtures use the real transformed designer but intercept backend
calls and leave the background URL empty; independent PDF tests cover source
geometry. The unmodified workspace preview reports `Tenant not found` against
its legacy SOURCE configuration. These results are not a signed-in deployed
tenant UI or live delivery test.

Commands:

```sh
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test supabase/migrations/cpdCertificateImages.test.mjs
node scripts/run-isolated-tests.mjs node --test api/_lib/cpdCertificateImages.test.mjs api/_lib/cpdCertificateImagesApi.test.mjs 'api/members/[memberId]/cpd-certificate.test.mjs'
node scripts/run-isolated-tests.mjs node --test client/src/lib/cpdCertificateContract.test.mjs client/src/lib/cpdCertificateGeometry.test.mjs client/src/pages/CPDCertificateTemplates.signatures.test.mjs
npx playwright test --config=client/src/pages/CPDCertificateTemplates.signatures.browser.config.mjs
```
