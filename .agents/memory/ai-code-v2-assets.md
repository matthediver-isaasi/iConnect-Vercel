---
name: AI V2 generated raster imagery (Phase 5)
description: How V2 compositions request/receive raster images — placeholder contract, fulfilment injection points, hard-reject rules.
---

# AI V2 generated raster imagery

- The model NEVER writes external image URLs. It places `<img data-ai-id data-ai-asset="<key>" alt>` (no src) and declares the key in the package `assets` manifest (`image_request`: subject/alt/style/aspectRatio/required/librarySearch). The sanitiser strips foreign `src`; a code gate rejects ANY model-output `<img>` without `data-ai-asset` (even with a relative/same-origin src — that would bypass the manifest/provenance flow) and manifest keys never placed in markup; fulfilment/replace keep `data-ai-asset` so legitimate srcs always co-exist with a key.
- Fulfilment (`api/_lib/aiCodeAssets.js`) is dependency-injected (generateImage / storeAsset / searchLibrary) so it is fully testable offline. Library-first when `librarySearch` is set; per-asset failures keep the brief on the manifest (`fulfilment.status='failed'`) so a later pass retries; a wall-clock deadline defers `remaining` for resume.
- **Only unfulfilled `required: true` requests hard-reject a composition**; optional failures degrade gracefully (placeholder keeps CSS aspect-ratio so layout holds).
- Sanitised documents must be re-sanitised with `allowedImageHosts` = the tenant public asset prefix at every store point (generate, repair, edit accept, replace-image), or fulfilled srcs get stripped.
- Image replacement goes through the Phase 4 edit flow as a deterministic `replace-image` action (tenant ownership check on file_repository, swap by `data-ai-id`, new version + provenance in generation_metadata) — never an LLM rewrite.
- V1→V2 migration is an explicit admin "Rebuild with new renderer" action seeding a fresh V2 generation from the old job's brief; the V1 composition is never mutated automatically.
- alt text lives on the manifest/img (file_repository has no alt column).
- Focal point/crop are MERGE operations on the asset manifest entry (mirroring V1 asset merge ops): setting one never drops the other or the fulfilment; crop aspect is CSS format `"16 / 9"` (never `"16:9"`). Because inline `style` attributes are sanitiser-forbidden, presentation is applied as a marker-delimited scoped stylesheet rule per `data-ai-id`, rewritten in place (never accumulated); layout markup stays untouched.

**Why:** images are the largest injection/exfiltration surface in generated markup; declarative requests + host-allowlisted src keep the sanitiser the single choke point.
