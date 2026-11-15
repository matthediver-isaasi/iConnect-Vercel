# Project assignments and Activity images

## Rollout boundary

This change was verified with isolated API, React, browser and disposable
PostgreSQL fixtures. No customer records, production database, deployed UI or
real storage provider were modified or verified.

Apply the schema **before releasing the matching API/UI**. The comment/detail
reads fail explicitly if image relations are unavailable; they do not silently
hide existing comments. The new migration depends on the existing Projects
tables and `202610090002`, `202610090003`, `202610090004` mention migrations.

Migration: `supabase/migrations/202701250001_project_comment_images.sql`

Pinned SHA-256:
`b4c78fdc9dd038427aa51b4a4f92b6b1e64d976aab870398279771108d367b01`

`node scripts/apply-project-comment-images.mjs` is an offline checksum review.
After destination approval, the existing destination-pinned runner conventions
are used by:

```sh
node scripts/apply-project-comment-images.mjs --apply --review-sha256=b4c78fdc9dd038427aa51b4a4f92b6b1e64d976aab870398279771108d367b01
```

It rejects SOURCE/unpinned targets, verifies TLS, holds a migration lock, keeps
schema and grants verification in one transaction, and records an exact-hash
receipt for repeat execution. It is intentionally not appended to automatic
post-merge setup; applying a live migration is a separate rollout action.

Activity signing requires the existing `SESSION_SECRET`. The scheduled cleanup
endpoint requires `CRON_SECRET` and denies all requests when it is absent.
Neither value belongs in documentation or source.

## Saved state and timing

Assignee writes preserve the existing independent assignment capability gate.
The modal serializes assignment commands and captures their card IDs. Confirmed
deltas cancel older detail/board reads and merge only the assignee relationship.
Pending feedback ends after publication, not after the eight-root Sales/Projects
refresh. Failed writes retain the saved state and show an error.

The timing test uses isolated task data and the real query refresh function,
with a simulated 25 ms write and 150 ms dependent reads. Recorded before/after
pending durations were **176.8 ms / 25.9 ms**; write durations were **25.1 ms /
25.2 ms**. This demonstrates removal of refresh waiting, **not** a measurement
of deployed network/database speed. Server assignment queries were not removed
without evidence of a server bottleneck.

## Image contract and lifecycle

- PNG, JPEG, GIF and WebP only, up to 10 images/comment and the existing 100 MB
  per-file limit and tenant quota.
- Clipboard handling belongs only to the focused Activity textarea. Native text
  paste and selected mentions are retained. Clipboard items/files are not read
  twice. Previews use local object URLs, revoked on removal/unmount.
- Pasted files remain local until Submit. Upload stages are shown individually.
  Submission and removal controls are locked during the operation. Failures
  keep text, mentions, files and completed upload state available for retry.
- Each modal retains drafts by card. Async work captures the originating card,
  and late results cannot clear another card's draft. Drafts are in-memory, not
  durable across a browser reload; **submitted** comments/images are durable.
- Activity uploads use the signed pipeline with a signed stable attachment ID.
  Confirmation verifies storage metadata before idempotent insertion. A lost PUT
  response can recover by confirmation rather than overwriting an existing file.
- Comment creation, image links, mentions and activity are atomic. Request IDs
  deduplicate retries. Cross-card references, another uploader's files,
  unsupported types, oversized records and viewers are rejected.
- Removing an unsent preview creates no remote file. Removing a preview after a
  successful upload **keeps the task attachment**; the composer states this.
  Cancelling a comment is not authority to delete a file used elsewhere.
- The service-only upload ledger tracks unconfirmed objects. Hourly cleanup
  handles up to 100 entries older than 24 hours, after signing capabilities have
  expired. Confirmed attachments are never deleted by cleanup. Failed storage
  or database reads retain the ledger for retry. Existing quota reconciliation
  accounts for unused upload reservations and cleaned objects.
- Deleting a comment cascades only its links, never files. Deliberately deleting
  an attachment removes its comment links; an otherwise empty entry displays
  “Image attachment removed.” Existing attachment deletion permissions apply.
- Cover-only uploads remain separate and cannot be passed as attachment IDs.
  Ordinary file uploads and their existing behavior are retained.

## Verification

```sh
node scripts/run-isolated-tests.mjs node --test \
  client/src/lib/projectBoardCache.test.mjs \
  client/src/components/sales/ProjectCardDetailModal.test.mjs \
  api/_lib/projectCoverUpload.test.mjs \
  api/_lib/projectCommentImagesApi.test.mjs \
  api/_lib/projectActivityUploadCleanup.test.mjs
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test \
  api/_lib/projectMentionInbox.postgres.test.mjs
node --test tests/project-card-modal.browser.test.mjs
```

The PostgreSQL command needs the installed PostgreSQL tools on PATH. It creates
and destroys its own socket-only cluster, not a development/customer database.
Browser tests use the real modal and clipboard in Chromium with intercepted
fixture APIs, including image-only and mixed comments, retry, reload, ordinary
text paste, mentions, read-only access, and existing cover/file workflows.
