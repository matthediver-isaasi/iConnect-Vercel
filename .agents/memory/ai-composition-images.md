---
name: AI Composition generated imagery (Phase 3)
description: Rules for image/illustration assets inside AI Composition documents — factual-text rule, per-asset failure isolation, alt-text flags, asset merge patches.
---

# AI Composition generated imagery

- **Factual-text rule:** `statistic` / `simple_chart` / `comparison_item` may NEVER carry `asset` or `imageBrief` — values render as real HTML text. The schema validator enforces it; image prompts additionally forbid text/numbers unless a digit-free `textOverlay` was authorised. **Why:** raster numbers are inaccessible and go stale.
- **Per-asset isolation:** a failed generation sets `el.asset = { status: 'failed' }` and KEEPS `imageBrief` so `collectImageBriefs` re-collects it for retry; the run continues. Never let one asset failure fail the composition.
- **Alt-text workflow:** every resolved image without alt text and every failed asset is flagged (`collectAltTextFlags` → `doc.accessibility.imageFlags`); flags must survive into responses so the UI can nag.
- **Asset edits (crop/focal) are merge ops:** always merge into the current asset (`buildAssetMergeOp`) so `fileRepositoryId` is never dropped. `crop.aspectRatio` format is `"16 / 9"` (slash with spaces), not `"16:9"` — the schema rejects colon form.
- **Pure lib + injected providers:** generation/storage are injected (`generateImage`, `storeAsset`) so the whole pipeline is node:test-able without keys. Assets live in `file_repository` + `ai_generated_asset` with storage metering via `addTenantStorageBytes`.
- The images action endpoint mirrors edit.js auth (404 not 403) and validates the full doc before saving a version.
