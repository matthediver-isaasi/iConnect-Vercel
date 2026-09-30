# AI Design Studio — Architecture & Schema (Phase 0)

**Author:** Replit Agent
**Last Updated:** July 2026
**Module:** AI Design Studio / Canvas Builder
**Status:** Phase 0 design document — no production code, UI, endpoints or migrations exist yet. The validator draft (`api/_lib/aiCompositionSchema.js`) and example fixtures (`api/_lib/aiCompositionExamples.mjs`) are inert drafts that later phases will build on.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Existing Canvas architecture review (reuse baseline)](#2-existing-canvas-architecture-review-reuse-baseline)
3. [AI Composition document schema](#3-ai-composition-document-schema)
4. [Renderer approach](#4-renderer-approach)
5. [Parent Canvas flow participation](#5-parent-canvas-flow-participation)
6. [Generation pipeline](#6-generation-pipeline)
7. [Patch-based editing](#7-patch-based-editing)
8. [Versioning model](#8-versioning-model)
9. [Media-library integration plan](#9-media-library-integration-plan)
10. [OpenAI service reuse plan](#10-openai-service-reuse-plan)
11. [Usage-control plan](#11-usage-control-plan)
12. [Security assessment](#12-security-assessment)
13. [Recorded decisions](#13-recorded-decisions)
14. [Identified risks](#14-identified-risks)

---

## 1. Overview

The AI Design Studio extends the existing Canvas Builder with a single new first-class element: the **AI Composition**. One architecture serves every AI feature (whole pages, sections, heroes, infographics, illustrations, redesigns) — there are no parallel systems. An AI Composition is a self-contained responsive design area whose source of truth is a **structured composition document**, never raw HTML, an iframe, or a flattened image.

Core design principles:

1. **Structured document is the source of truth.** The LLM emits a JSON document conforming to a strict schema; invalid output is rejected and never replaces valid content.
2. **The AI designs; iConnect owns data and functionality.** Internal links are record IDs (never invented URLs); factual values are protected; application behaviour stays in approved iConnect components.
3. **Reuse over reinvention.** Branding, media library (`file_repository`), versioning patterns, link handling, quota enforcement and the existing OpenAI wrapper are all reused, not duplicated.
4. **Safe by construction.** No generated JavaScript, CSS restricted to a property allowlist rendered as scoped rules, tenant isolation at every stage, and failed generations leave the current composition untouched.

---

## 2. Existing Canvas architecture review (reuse baseline)

Everything below already exists in production and is the substrate the AI Composition builds on.

| Area | Files | What we reuse |
|------|-------|---------------|
| Canvas design model | `client/src/lib/canvasDesign.js` (3,600 lines) | v1 absolute + v2 flow document models, `BREAKPOINTS`/`BREAKPOINT_WIDTHS`, block registry (`BLOCK_TYPES`, `BLOCK_DEFAULTS`), responsive value helpers (`resolveBlockAtBreakpoint`, `writeResponsiveValue`), normalizers |
| Builder / editor | `client/src/components/canvas/CanvasBuilder.jsx` | Block selection, inspector panel, drag/resize, breakpoint switcher, manual-save + unsaved-changes guard |
| Public renderer | `client/src/components/canvas/CanvasPageRenderer.jsx` | Public render path, auto-height reflow (AccordionReflowContext-style push-down), scoped `@media` typography |
| Server layout engine | `api/_lib/canvasLayoutEngine.js` | Doc→Canvas design factories (sections, cards, buttons), spacing rhythm constants, HTML escaping discipline |
| AI generation baseline | `api/admin/canvas-from-doc.js` | Existing LLM page-generation endpoint: structured verbatim source, bidirectional fidelity guard (`isSpecFaithful`), deterministic fallback |
| LLM wrapper | `api/integrations/invoke-llm.js` | Server-side OpenAI call wrapper (gpt-4o-mini today), JSON-mode responses, key never exposed to browser |
| Page versioning | `api/canvas-versions/[pageId].js` | `canvas_page_version` table pattern: immutable snapshots, `MAX_KEEP=10` unlocked + `MAX_LOCKED=3`, restore = new version |
| Link handling | `client/src/lib/canvasLinks.js` | `LINK_FIELD_SPECS` / `HTML_FIELD_SPECS` registry, `extractCanvasLinks`, `applyCanvasLinkUpdate`, internal-page suggestion scoring |
| Branding | `api/_lib/tenantBranding.js` | `buildTenantBrandingPayload` — logos, colours, fonts (`installed_font`), button styles (`tenantButtonStyle`), microsite overrides |
| Media library | `file_repository` table | Source of truth for all media (media_asset deprecated); picker is window-event bridged; note: **no `alt_text` column today**, `uploaded_by` is an email |
| Quotas | `api/_lib/planQuota.js` | `checkStorageQuota` pattern (plan `quotas` JSONB, 402 + `PLAN_QUOTA_EXCEEDED` upgrade payload), `tenant.storage_used_bytes` metering |
| RBAC | `client/src/lib/roleAccessMap.ts` + `role_access_item` table | Feature-key gating; new keys need an idempotent seed script |

Key model facts the design must respect:

- **v1 (absolute) pages**: blocks carry per-breakpoint geometry (`x, y, w, h`); public height is grow-only vs authored; auto-height blocks bake measured heights and push blocks below by the delta.
- **v2 (flow) pages**: `isFlowDesign` branch; one pure `resolveFlowLayout` drives builder and public page; first paint uses a static per-breakpoint stylesheet, then a `hydrated` gate swaps to engine geometry.
- Every canvas block box is `overflow: hidden` in both renderers; blocks needing overflow must opt out via a registry flag.
- The public renderer passes no breakpoint — per-breakpoint styling must be emitted as scoped `@media` CSS, not inline styles.
- Editor zoom is `transform: scale`, so any DOM measurement feeding stored geometry must be zoom-normalized.

---

## 3. AI Composition document schema

Defined and enforced by the validator draft in **`api/_lib/aiCompositionSchema.js`** (`validateComposition(doc)`); two passing example documents live in **`api/_lib/aiCompositionExamples.mjs`** (whole-page and single-section). The schema is deliberately independent of the Canvas block registry — the spec requires layouts beyond existing Canvas primitives.

### 3.1 Top level

```json
{
  "schemaVersion": 1,
  "id": "comp_…",
  "name": "Annual conference landing page",
  "compositionType": "multi_section_page",   // or "section"
  "status": "draft",                          // draft | ready_for_review | approved
  "originalPrompt": "…",
  "sections": [ …AiSection ],
  "layouts": { "desktop": {…}, "tablet": {…}, "mobile": {…} },
  "protectedValues": [ …ProtectedValue ],
  "generatedAssets": [ …GeneratedAssetRef ],
  "conversation": [],
  "generationMetadata": {},
  "accessibility": {},
  "currentVersionId": null
}
```

- `schemaVersion` gates forward evolution: validators accept documents whose version they know; new element types/properties are added additively so old documents never invalidate (unknown *element types* are rejected at the version that doesn't know them; unknown *extra properties* on known objects are tolerated).
- `sections` is 1..n. A single-section composition and a whole-page composition are the same shape.

### 3.2 Sections and elements

```json
{
  "id": "section_hero",
  "name": "Hero",
  "type": "ai_section",
  "readingOrder": ["heading_01", "paragraph_01", "button_01"],
  "elements": [ …AiElement ]
}
```

- **`readingOrder` is mandatory** and must list every top-level element ID in the section exactly once. It defines semantic/DOM order independent of visual position (spec §7, §22). The renderer emits DOM in reading order and positions visually via layout frames.

Each element:

```json
{
  "id": "heading_01",
  "type": "heading",
  "role": "h2",                 // heading levels are data, not styling
  "content": { "text": "…" },   // or { "html": "…" } for rich paragraph content
  "link": { …LinkRef },          // optional; buttons/text_link
  "asset": { …AssetRef },        // optional; image/illustration/icon
  "data": { … },                 // optional; statistic/chart/timeline values
  "style": { …allowlisted },     // see §4
  "children": [ …AiElement ]     // container/group/card only
}
```

**Element types (v1 enum)** — mirrors spec §6: `section_background`, `container`, `group`, `heading`, `paragraph`, `label`, `caption`, `image`, `generated_illustration`, `icon`, `button`, `text_link`, `shape`, `line`, `connector`, `background`, `overlay`, `card`, `statistic`, `timeline_item`, `process_step`, `repeating_item`, `comparison_item`, `simple_chart`, `structured_infographic`, `svg_decorative`, `iconnect_action`, `canvas_component_placeholder`.

- `iconnect_action` / `canvas_component_placeholder` reference approved iConnect functionality by kind + record ID; the AI positions them but never recreates their behaviour.
- `svg_decorative` carries a constrained path spec (`d`, `fill`, `viewBox`) validated against a safe subset (no `<script>`, no event attributes, no external refs).
- Factual infographic values live in `data` as structured values rendered as real HTML/SVG text — never baked into raster images.

### 3.3 Links (`LinkRef`)

```json
{ "kind": "page", "pageId": "uuid" }
{ "kind": "event_registration", "eventId": "uuid" }
{ "kind": "form", "formId": "uuid" }
{ "kind": "document", "fileId": "uuid" }
{ "kind": "external", "url": "https://…" }
{ "kind": "email", "address": "…" }   { "kind": "tel", "number": "…" }
{ "kind": "anchor", "anchorId": "…" }
```

The validator rejects any internal destination expressed as a raw URL — internal destinations are **record IDs only** (spec §16) — and additionally enforces the identifier *shape* per field (record IDs must be UUIDs, anchors/action keys slug-form, email/tel well-formed), so junk values like `javascript:…` can never persist. External URLs must be `http(s)`. Resolution to a concrete `href` happens at render time through the same resolution layer `canvasLinks.js` uses (see Decision D4).

### 3.4 Per-breakpoint layouts

`layouts.{desktop|tablet|mobile}` maps element ID → **frame**:

```json
{
  "mode": "absolute",              // absolute | flow | flex | grid
  "x": 0, "y": 0, "w": 1200, "h": null,
  "minH": 480, "maxW": null,
  "z": 1, "rotation": 0, "opacity": 1,
  "visible": true,
  "flex": { "direction": "column", "gap": 24, "align": "center" },
  "grid": { "columns": 3, "gap": 24 },
  "objectFit": "cover", "focalPoint": { "x": 0.5, "y": 0.35 }, "crop": null
}
```

- **Desktop is mandatory** for every element; tablet/mobile inherit desktop and override sparsely (mirrors the Canvas `bp` override pattern, so a mobile-only prompt edit writes only the mobile map — spec §18's "a breakpoint change must not overwrite other breakpoints" falls out of the storage shape).
- `visible: false` supports responsive removal of decorative elements.
- Container elements with `mode: "flex" | "grid"` lay out their `children`; absolute frames position against the composition's internal coordinate space at the breakpoint's reference width (reusing `BREAKPOINT_WIDTHS`).
- Composition root height is **derived** (auto-height): the renderer measures rendered content per breakpoint; frames only supply `minH`.

### 3.5 Protected values

```json
{
  "id": "pv_price",
  "kind": "price",                  // link | form_ref | event_ref | date | price | statistic | name | sponsor_logo | legal_text | a11y_text | binding
  "elementId": "statistic_price",
  "path": "data.value",
  "value": "£249",
  "source": { "type": "event", "recordId": "uuid", "field": "early_bird_price" },
  "confirmedBy": "user_or_record"
}
```

Patch application and redesigns must not change any element path covered by a protected value unless the instruction explicitly targets it — the server enforces this mechanically (diff the patched doc against protected paths), not by trusting the LLM. Violations surface as a warning requiring user confirmation.

### 3.6 Generated assets, conversation, metadata

- `generatedAssets`: `{ fileRepositoryId, altText, prompt, model, aspectRatio, placement, parentAssetId, generationCost }` — asset bytes live in `file_repository`; the doc holds references + alt text (see §9).
- `conversation`: `{ at, userId, instruction, scope: { sectionId?, elementId? }, interpretation, patchIds, accepted, versionId }` — context only; the document stays authoritative.
- `generationMetadata`: model/provider, pipeline stage timings, creativity level, visual-review cycles used.
- `accessibility`: latest automated check result `{ checkedAt, passed, critical: [], warnings: [] }` — critical failures block approval.

---

## 4. Renderer approach

**In-DOM, scoped CSS, no iframe, no flattening** (spec §21).

1. Each composition renders inside a wrapper `<div data-aic="comp_id">`. All generated styling is emitted as a `<style>` block whose every selector is prefixed `[data-aic="comp_id"] …` — generated styles cannot reach navigation, footer, other Canvas blocks or admin UI.
2. **CSS property allowlist**: element `style` objects may only use keys in `CSS_PROPERTY_ALLOWLIST` (exported from the validator module): color/background/gradient, typography (family restricted to installed tenant fonts + system stack), border, radius, shadow, spacing, transform (rotate/translate only), opacity, overflow, clip-path from an approved shape list, filter subset. Values are sanitized per-property (no `url(…)` except same-origin asset refs resolved server-side, no `expression`, no custom properties, no `!important`). Unknown keys fail validation.
3. Breakpoint-specific styling is emitted as `@media (max-width: …)` rules scoped by the same attribute — matching the existing rule that the public renderer passes no breakpoint, so responsive behaviour must be CSS, not JS.
4. DOM order = `readingOrder`; visual position via the frame layout. Headings render as real `h1–h6` per `role`, text is real HTML text (searchable, selectable, translatable), images get `alt` from asset refs.
5. **No generated JavaScript ever executes.** Interactive behaviour (accordion-style, tabs) is out of scope for v1; approved interactions come only from `iconnect_action` placeholders rendering existing components.
6. Editor rendering reuses the same renderer with a selection overlay (composition → section → group → element), mirroring how Canvas block selection works today.

---

## 5. Parent Canvas flow participation

The AI Composition is registered as one new Canvas block type (`aiComposition`) in the existing registry (`BLOCK_TYPES`, `BLOCK_DEFAULTS`, validate + render + inspector in `dynamicBlocks.jsx`), holding `{ compositionId }` in its props plus outer layout settings (width, min-height, auto-height on/off).

### v1 (absolute) pages

- The block behaves like existing auto-height leaf blocks: it renders, measures its content height per breakpoint (zoom-normalized in the editor), and participates in the established bake/reflow path — growing pushes blocks below it down by the delta and grows containing sections; shrinking closes space via the same grow-only public rule that keeps public and builder consistent.
- `minH` from the block props is the floor; the composition never requires the user to predict a fixed height (spec §4).

### v2 (flow) pages

- The block is added to `AUTO_HEIGHT_LEAF_TYPES` so `resolveFlowLayout` treats it as content-sized. Flow reflow is native — nothing extra to build beyond correct first-paint CSS (the composition's own static breakpoint stylesheet slots into `buildFlowCanvasCss` output).

### Overflow

The composition block sets the registry `allowOverflow` flag **off** (compositions are self-contained; internal overlap is handled inside the scoped coordinate space) — but internal elements may overlap freely within the composition.

---

## 6. Generation pipeline

Multi-stage server-side workflow (spec §13), run as a resumable job so one failed image doesn't restart everything (mirrors the existing chunked-worker patterns: wall-clock budget per invocation + resume cursor, given Vercel `maxDuration`).

```
Request (tenant, user, scope, brief, mode, creativity)
  → 1 Context assembly    — branding payload, page context, candidate records
                            (pages/events/forms/docs by ID), media candidates,
                            permissions; STRICT tenant filter on every query
  → 2 Creative plan       — LLM: audience, narrative, section list, imagery
                            needs, facts-to-verify; stored for audit, never
                            shown as raw reasoning
  → 3 Fact resolution     — required facts fetched from iConnect records or
                            queued for user confirmation; NEVER invented;
                            resolved facts become protectedValues
  → 4 Copy generation     — headings/copy/labels/alt-text; provenance tagged
                            (user-provided | record | ai_copy | claim)
  → 5 Document generation — LLM emits composition doc (JSON mode);
                            validateComposition() rejects invalid output;
                            invalid ⇒ retry (bounded) ⇒ fail WITHOUT touching
                            the current composition
  → 6 Asset generation    — images/illustrations → file_repository, quota-
                            checked, referenced by ID (skippable/resumable)
  → 7 Render validation   — server render at 3 breakpoints: schema, security,
                            missing assets, broken record links, overflow,
                            contrast, heading order, alt text
  → 8 Visual review       — rendered screenshots to a vision model; bounded
                            correction cycles (org-configurable max)
  → 9 User preview        — insert / apply / refine / alternative / discard
```

Every stage failure is terminal-safe: the job records the failed stage + reason; the page and any existing composition version remain untouched (spec §30).

---

## 7. Patch-based editing

Minor changes are structured patches, validated by `validatePatch()` in the same module:

```json
[
  { "op": "update_content", "elementId": "heading_01", "changes": { "text": "…" } },
  { "op": "update_link",    "elementId": "button_01",  "changes": { "link": { "kind": "event_registration", "eventId": "uuid" } } },
  { "op": "update_style",   "elementId": "card_02",    "breakpoint": "mobile", "changes": { "style": {…}, "frame": {…} } },
  { "op": "replace_asset",  "elementId": "image_01",   "changes": { "asset": { "fileRepositoryId": "uuid", "altText": "…" } } },
  { "op": "insert_section", "afterSectionId": "section_programme", "section": {…} },
  { "op": "remove_section", "sectionId": "…" },
  { "op": "reorder_sections", "order": ["…"] },
  { "op": "replace_section", "sectionId": "…", "section": {…} }
]
```

- Patches are applied server-side to a copy of the current document; the result must pass full `validateComposition()` **and** the protected-value diff check before it becomes a new version.
- Change scopes map to ops: content-only → `update_content`; asset change → `replace_asset`; layout → `update_style` (breakpoint-scoped or all); section redesign → `replace_section`; complete redesign → new full document generation, defaulting to an **alternative** rather than replacing the current version.
- Accepted patches are recorded in `conversation` with the version they produced.

---

## 8. Versioning model

Follows the proven `canvas_page_version` pattern but in a dedicated table (Decision D1):

- **`ai_composition`** — one row per composition instance: `id, tenant_id, page_id, name, composition_type, status, current_version_id, created_by, created_at`.
- **`ai_composition_version`** — immutable snapshots: `id, composition_id, tenant_id, parent_version_id, document (jsonb), change_summary, operation_type, validation_result, accessibility_result, generation_metadata, created_by, created_at, is_alternative, locked`.

Rules:

- Every successful AI operation (generation, accepted patch, restore, alternative) inserts a version; documents inside versions are never mutated.
- Restore = insert a new version whose document copies the restored one (parent chain preserved) — same semantics as canvas page versions.
- Retention mirrors canvas versions (keep last N unlocked + up to M locked; exact numbers set in Phase 1) but **the current version and the last known-valid version are never pruned** ("never overwrite the only valid version").
- Alternatives are sibling versions (`is_alternative`, shared `parent_version_id`); "keep both" duplicates the composition row.
- The parent Canvas page continues to snapshot independently via `canvas_page_version`; a page version references the composition block (with its `compositionId` + `currentVersionId` at snapshot time), so page restore also restores which composition version was live.

---

## 9. Media-library integration plan

- All generated imagery is written to **`file_repository`** (the single media source of truth) under the tenant, via the existing upload path so `addTenantStorageBytes` metering and `checkStorageQuota` enforcement apply automatically.
- Generated-asset metadata that `file_repository` cannot hold goes in the composition's `generatedAssets` array + a small `ai_generated_asset` table (prompt, model, aspect ratio, placement, parent asset, cost, usage status). **Note:** `file_repository` has no `alt_text` column — alt text lives on the asset reference in the document (per-placement alt is more correct anyway).
- Replacement flows ("use an existing image") reuse the existing window-event-bridged file picker.
- Asset ownership checks: every `fileRepositoryId` referenced by a document must belong to the tenant (validated at save time, stage 7).

---

## 10. OpenAI service reuse plan

- All model calls go through the existing server-side wrapper (`api/integrations/invoke-llm.js`) — browser never sees keys (spec §23). The wrapper gains optional parameters Phase 1 needs: model selection per stage, JSON-schema response format, and token accounting returned to the caller for usage metering.
- Stage model mapping (initial): plan/copy/document → the current default chat model in JSON mode; visual review → a vision-capable model; images → the image-generation model behind a new thin server helper alongside the wrapper.
- `api/admin/canvas-from-doc.js` remains the reference for prompt discipline: verbatim structured source, strict output contract, fidelity/validation guard, bounded retries, deterministic failure. The composition pipeline generalizes that pattern rather than replacing it.

---

## 11. Usage-control plan

Reuses the `planQuota.js` pattern (plan `quotas` JSONB, discriminated `{ ok } | { ok:false, status, body }` results, 402 `PLAN_QUOTA_EXCEEDED` upgrade payload):

- New quota keys: `ai_generations_per_month`, `ai_images_per_month`, plus org-level settings (max alternatives, max visual-review cycles, max prompt length, per-user rate limits, warning threshold, optional hard spend limit) in the AI Design Studio admin config.
- New **`ai_usage_event`** table records every operation: tenant, user, page, composition, section, operation type (creation / section / content update / layout / redesign / visual review / image gen / image edit), model, input/output tokens, image count, date, estimated cost.
- Image storage counts against the existing `storage_mb` quota automatically (assets go through `file_repository`).
- Duplicate-submission prevention: an in-flight generation lock per composition (job row keyed on composition + status) — a second submit while one is running is rejected, mirroring the concurrency-guard patterns already used for background workers.
- RBAC: new `role_access_item` keys (generate, request changes, approve content, configure studio, view usage) seeded idempotently; publishing permission stays the existing separate key.

---

## 12. Security assessment

| Threat | Mitigation |
|--------|-----------|
| Cross-tenant data access via context assembly | Every stage-1 query is tenant-filtered through the existing tenant-context helpers; record IDs supplied by the client are re-verified against the tenant before use |
| LLM inventing internal URLs | Schema forbids internal raw URLs; links are record IDs resolved server-side; broken/unknown IDs fail validation |
| Script/markup injection | No generated JS; `content.html` sanitized against a tag/attribute allowlist (no event handlers, no `<script>/<style>/<iframe>`, no external resources); SVG paths validated against a safe subset |
| CSS escaping the composition | Property allowlist + per-property value sanitizers + all selectors scoped to `[data-aic]`; no `url()`, custom properties, or `!important` |
| Prompt injection via user content / uploaded docs | User content is passed as data (structured, delimited), never as instructions; output is schema-validated regardless of what the prompt said; protected values enforced mechanically post-hoc |
| Privilege escalation | Admin endpoints use `getTenantContext` + `hasAdminAccess` (not `getTenantIdFromSession`, which only checks membership); generation/approval/publish are separate RBAC keys |
| Resource abuse | Prompt-size and output-size limits, per-user throttling, org allowances, bounded retry/review cycles, provider timeouts |
| Partial-output corruption | Invalid output never persisted as current; versions immutable; failed stages retain the prior valid version |
| Asset theft/reference | Asset ownership check on every referenced `fileRepositoryId` |
| Audit | Every operation writes `ai_usage_event` + conversation entries with user, scope, and resulting version |

The AI cannot: run DB queries, publish pages, touch navigation/footer/legal controls, create payment or auth logic, or emit uncontrolled forms — none of these are expressible in the schema.

---

## 13. Recorded decisions

**D1 — Storage: new tables, not inside `canvas_design`.**
Composition documents live in `ai_composition` / `ai_composition_version`; the Canvas block stores only `{ compositionId }`. *Why:* composition docs are large and independently versioned with rich metadata (validation, accessibility, generation, conversation); embedding them would bloat every `canvas_page_version` snapshot, break the immutable-version requirement (canvas designs are mutable until saved), and make retention rules impossible to apply independently. The page ↔ composition reference still snapshots cleanly (§8).

**D2 — Patch representation: named-operation JSON array (not RFC 6902 JSON Patch).**
Operations like `update_content` / `replace_asset` / `insert_section` (§7). *Why:* semantic ops are what the LLM can reliably emit, they map 1:1 to the spec's change scopes, they make protected-value enforcement tractable (each op declares its target element/path), and they audit legibly in conversation history. RFC 6902 paths are brittle against array reordering and would let a patch touch arbitrary document internals.

**D3 — CSS strategy: property allowlist + value sanitizers, emitted as attribute-scoped `<style>` rules.**
Not Shadow DOM, not iframes, not inline styles. *Why:* attribute scoping keeps content in the normal DOM (searchable/accessible/SSR-able) while guaranteeing isolation; the allowlist is enforced at validation time (bad docs never save) rather than render time; `@media` rules are required anyway because the public renderer is breakpoint-agnostic. Shadow DOM would fight the tenant typography/branding cascade and existing SSR.

**D4 — Record-ID links resolve through the existing canvas link layer.**
`LinkRef` objects are the storage form; a small adapter registers the composition block in `canvasLinks.js`'s spec registry so `extractCanvasLinks` lists composition links in the existing page link audit, and href resolution (page slug, event URL, form URL, document download, anchor `id` emission) reuses the exact routes the current LinkField system produces. *Why:* one resolution path means broken-link detection, the link editor UI, and future URL scheme changes all stay single-sourced.

---

## 14. Identified risks

1. **LLM schema-conformance rate.** Complex nested documents raise invalid-output rates; bounded retries + JSON-schema response mode mitigate, but generation cost/latency may need a simplified "document skeleton then per-section fill" split if failure rates are high. (Watch in Phase 1 POC.)
2. **Creative ceiling vs safety floor.** The CSS allowlist and no-JS rule cap some spec §7 ambitions (e.g. curved journeys) — approved clip-paths and SVG decorative elements cover most, but expectations need managing.
3. **Auto-height measurement loops.** Compositions with internal responsive reflow feeding parent Canvas reflow risk oscillation; the established bake/measure discipline (grow-only public, zoom-normalized editor measurement, collapsed-baseline rules) must be followed exactly.
4. **Serverless time budget.** The full pipeline exceeds a single invocation; the resumable-job pattern is required from day one, not bolted on.
5. **Cost exposure.** Vision review + image generation are the expensive stages; hard org limits and per-stage skip flags must ship with the features, not after.
6. **Version storage growth.** Full-document snapshots per operation are simple but heavy; retention pruning must be in Phase 1 (not deferred), with the never-prune-last-valid rule.
7. **Accessibility gate friction.** Blocking approval on critical failures is correct but will frustrate users if the generator frequently produces failures; stage-7 checks must feed back into stage-8 correction cycles so failures are fixed before the user sees them.
8. **Prompt-injection via tenant content.** Page context and uploaded documents are attacker-influenceable in multi-admin tenants; the mechanical post-validation stance (never trust the model followed instructions) is the real defence and must never be weakened for convenience.
