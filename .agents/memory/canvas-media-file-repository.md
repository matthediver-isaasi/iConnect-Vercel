---
name: Canvas media = File Repository (media_asset deprecated)
description: Canvas Builder media now lives in file_repository, not the old media_asset table; picker is event-bridged; schema gotchas when migrating.
---

# Canvas media source of truth = File Repository

The Canvas Builder no longer has its own Media Library. `file_repository`
(+ `file_repository_folder`) is the single source of truth for all canvas
media. The old `media_asset` table is **deprecated but intentionally left in
place** (rows + stored files untouched); its `/api/media-library/*` endpoints
and the `MediaLibraryDialog` component were deleted.

**Why:** one media surface instead of two divergent ones; authors upload once
and reuse everywhere.

## How the picker is wired
- One shared `FileRepositoryPicker` (exported from `client/src/components/ImageSelector.jsx`)
  is mounted once in `CanvasPageEditor.jsx`.
- Block inspectors don't import it. They dispatch a `window` CustomEvent
  `canvas:open-file-repository` with `detail: { onPick, kind }` (kind =
  image|video|document|any). The editor shell listens, opens the picker, and
  routes the selected asset back through `onPick`.
- `ImageSelector` has a `repositoryOnly` prop: when set it drops the
  Upload/URL tabs + Replace button and only allows browse-from-repository
  (upload happens *inside* the picker). Canvas image inspectors use this;
  non-canvas callers (e.g. CampaignEdit email builder) stay unchanged.

## Schema gotchas when migrating media_asset → file_repository
- `file_repository` has **NO `alt_text` column** — alt text on old
  `media_asset` rows cannot be preserved on migration.
- `file_repository.uploaded_by` is an **email string**, but
  `media_asset.uploaded_by` is a **UUID** — do not copy it across (type
  mismatch); leave null.
- `media_asset.kind` maps to `file_repository.file_type` (enum
  image|document|video|other); `media_asset.byte_size` → `file_size`,
  `media_asset.url` → `file_url`, `media_asset.name` → `file_name`.
- Migration script `scripts/register-canvas-media-assets.mjs` is idempotent
  (matches by `(tenant_id, file_url)`), dry-run by default, `--apply` to
  write, files everything under a per-tenant "Imported from Canvas" folder.
  Already applied to DEST once.
