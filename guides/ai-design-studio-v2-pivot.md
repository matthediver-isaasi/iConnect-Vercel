# AI Design Studio V2 — Native Code Pivot (Phase 0)

**Author:** Replit Agent
**Last Updated:** July 2026
**Module:** AI Design Studio / Canvas Builder

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [The Safety Pipeline](#the-safety-pipeline)
4. [The V2 Code Package Contract](#the-v2-code-package-contract)
5. [Code Paths / Entry Points](#code-paths--entry-points)
6. [Safeguards and Error Handling](#safeguards-and-error-handling)
7. [Frontend UI](#frontend-ui)
8. [Database Tables](#database-tables)
9. [Data Flow Diagrams](#data-flow-diagrams)
10. [What Was Reused vs. Deprecated from V1](#what-was-reused-vs-deprecated-from-v1)
11. [Phase 0 Scope and What Comes Next](#phase-0-scope-and-what-comes-next)

---

## Overview

V2 pivots the AI Design Studio away from V1's coordinate-based scene graph
(JSON blocks with per-breakpoint x/y/w/h frames, rendered by
`AiCompositionRenderer`) to **native AI-generated HTML/CSS/SVG**. Instead of
asking a model to emit geometry that a bespoke renderer interprets, V2 lets
the model write real markup and stylesheets — the medium it is strongest in —
and invests the engineering effort in a deterministic **safety pipeline** that
makes untrusted generated code safe to embed inside tenant pages.

The core design principle: **sanitise once, server-side, at store time**. A
V2 document stored in `ai_composition_version.document` is already fully
sanitised and CSS-scoped; every consumer (canvas block, preview page, future
SSR) renders it verbatim and never re-processes it. The composition id doubles
as the CSS scope (`[data-ai-composition="<uuid>"]`), so a package can never
style anything outside its own wrapper.

Phase 0 proves the entire pipeline with a hand-authored fixture — a BNMS
"I'm having a scan" patient-information section — **before** any AI
generation exists. V1 remains fully operational and read-only untouched;
V2 lives beside it behind a new `renderer_version` discriminator and a new
canvas block type.

## Architecture

### Key Files Table

| File | Purpose |
|------|---------|
| `api/_lib/aiCodePackageSchema.js` | Structural validation of a raw V2 package (`schemaVersion "2.0"`) + manifest cross-checks (actions/slots/assets declared vs. used) |
| `api/_lib/aiCodeHtmlSanitizer.js` | Two-pass HTML/SVG sanitisation via jsdom + DOMPurify (allowlist tags/attrs, strips scripts/handlers/iframes, constrains URLs) |
| `api/_lib/aiCodeCssScope.js` | postcss AST scoping: every selector prefixed under `[data-ai-composition="uuid"]`, dangerous at-rules/declarations rejected, plus `assertAllSelectorsScoped` leak check |
| `api/_lib/aiCodePipeline.js` | `runAiCodePipeline(pkg, compositionId)` — orchestrates schema → sanitise → cross-check → scope → leak-check, returns the stored document + report |
| `api/_lib/fixtures/bnmsScanFixture.mjs` | Hand-authored BNMS proof fixture (`BNMS_SCAN_FIXTURE`) |
| `api/_lib/aiCodePipeline.test.mjs` | 24-test suite covering the pipeline and fixture (part of `ai-assistant-tests`) |
| `api/ai-compositions/preview.js` | Signed, CSP-locked standalone preview page (GET) + Browserless screenshot capture at 1440/1024/390 (POST, editor-only) |
| `client/src/components/canvas/blocks/AiCodeCompositionBlock.jsx` | The `ai-code-composition` canvas block: Render (verbatim injection) + Phase 0 Inspector (attach by id, safety report) |
| `client/src/components/canvas/canvasDesign.js` | Block registration: `BLOCK_TYPES.AI_CODE_COMPOSITION`, defaults, auto-height leaf, validation |
| `client/src/components/canvas/blocks/dynamicBlocks.jsx` | Block definition wiring (`autoHeight: true`) |
| `supabase/migrations/20260720_ai_code_renderer_version.sql` | Adds `ai_composition.renderer_version` (int, default 1) |
| `scripts/apply-ai-code-renderer-version.mjs` | Idempotent migration runner (applied to DEST) |
| `scripts/seed-bnms-scan-fixture.mjs` | Seeds the fixture through the full pipeline into a tenant (dry-run default, `--apply`) |

### Design Principles

1. **Server-side, store-time sanitisation** — the client never sanitises; a stored V2 document is trusted-by-construction so all render surfaces stay dumb and identical.
2. **Composition id = CSS scope** — the pipeline runs against the real composition uuid, so scoping cannot drift from the wrapper attribute.
3. **Reject, don't repair** — hard-fail on `@import`, `@font-face`, `@keyframes` (Phase 0), `position: fixed/sticky`, `html`/`body` selectors, external `url()`, undeclared actions/slots; the caller (future: the generation loop) retries, humans never receive silently-mutated packages.
4. **Immutable versions** — every pipeline output is a new `ai_composition_version` row; V2 reuses V1's versioning, pruning, and restore wholesale.
5. **V1 untouched** — `renderer_version` discriminates; the V1 block, renderer, generation and edit pipelines are unchanged and continue to serve existing compositions.

## The Safety Pipeline

`runAiCodePipeline(rawPackage, compositionId)` runs five stages in order and
fails closed — any hard error aborts with `{ ok: false, errors }` and nothing
is stored.

```text
raw package (schemaVersion "2.0")
  → 1. validateAiCodePackage      structural/shape validation, size caps
  → 2. sanitizeAiCodeHtml         jsdom+DOMPurify two-pass: tags, attrs,
                                   URL schemes, SVG subset, data-ai-* attrs
  → 3. crossCheckManifests        every data-ai-action / data-ai-slot used in
                                   HTML must be declared in the manifest (and
                                   vice versa); asset refs must resolve
  → 4. scopeAiCodeCss             postcss AST rewrite: strip any model-supplied
                                   scope, prefix all selectors under
                                   [data-ai-composition="<uuid>"], :root → wrapper,
                                   reject dangerous at-rules/declarations
  → 5. assertAllSelectorsScoped   independent re-parse proving zero selector
                                   escapes the scope (belt-and-braces)
  → stored document { schemaVersion, compositionId, html, css, svg…,
                      rendererVersion: 2, sanitisation report }
```

The returned `report` (also stored in `validation_result`) records every
removal/rejection: `aiIds`, `actionKeys`, `slotKeys`, `headings`,
`htmlRemoved[]`, `cssRejections[]` (hard vs. warning).

## The V2 Code Package Contract

A generator (Phase 1+) or fixture author supplies:

```js
{
  schemaVersion: '2.0',
  title, compositionType,            // 'section' | 'page'
  html,                              // semantic markup, data-ai-id on every element
  css,                               // UNscoped; pipeline scopes it
  responsiveTargets: { desktop: 1440, tablet: 1024, mobile: 390 },
  manifest: {
    actions: [{ key, label, kind, … }],   // every interactive intent
    slots:   [{ key, description }],      // editable content regions
    assets:  [{ key, kind, … }],          // referenced images/SVGs
  },
}
```

Interactivity is **declared, not embedded**: no `<script>`, no event handler
attributes survive sanitisation. Elements carry `data-ai-action="key"` and the
host application decides what those actions do (Phase 0 fixture declares
`find-scan` and `patient-leaflets`).

## Code Paths / Entry Points

### Seeding the proof fixture

- **File:** `scripts/seed-bnms-scan-fixture.mjs`
- **Trigger:** manual, `node scripts/seed-bnms-scan-fixture.mjs --tenant=bnms [--apply] [--force]`
- **Flow:**
  1. Resolve tenant by slug/uuid (DEST Supabase, service role).
  2. Mint the composition uuid up front and run `runAiCodePipeline` against it (scope = real id).
  3. Print the full report; stop here on dry-run.
  4. Insert `ai_composition` (`renderer_version: 2`) + one `ai_composition_version` (document, `validation_result`, metadata), set `current_version_id`.
- **Key details:** idempotent by composition name; `--force` adds a new version to the existing composition after re-running the pipeline against the *existing* id.

### Reading a V2 composition

- **File:** `api/ai-compositions/[id].js` (unchanged)
- **Flow:** the existing public GET returns `{ composition, document, versionId }`; V2 documents are distinguished purely by `document.schemaVersion === '2.0'`. No V2-specific server read path was needed.

### Signed preview page

- **File:** `api/ai-compositions/preview.js` (GET)
- **Trigger:** a signed URL — `?compositionId&versionId&exp&sig` where `sig = HMAC-SHA256(compositionId.versionId.exp)` keyed by `AIC_PREVIEW_SECRET || CRON_SECRET`, TTL ~10 minutes.
- **Flow:** verify signature (timing-safe) → load the exact version → emit a standalone HTML page: scoped `<style>` + sanitised HTML inside the `[data-ai-composition]` wrapper.
- **Key details:** locked down with `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; …` — no scripts can ever run; `noindex` everywhere. Exists so Browserless (no session cookie) can render the document.

### Screenshot capture

- **File:** `api/ai-compositions/preview.js` (POST)
- **Trigger:** editor-authenticated request `{ compositionId, versionId? }` (tenant admin or `site-builder.page-editor` feature).
- **Flow:**
  1. Verify the composition belongs to the caller's tenant and the version is a V2 document.
  2. Build the signed preview URL.
  3. Capture 1440×900 / 1024×768 / 390×844 full-page screenshots via `captureScreenshot` (`api/_lib/browserlessScreenshot.js`).
  4. Store each via `storeGeneratedAsset` (tenant media library, `ai_generated_asset` provenance row).
  5. Record `generation_metadata.screenshots[]` on the version.
- **Key details:** partial failures are reported per-breakpoint; a total failure returns 502 and records nothing.

## Safeguards and Error Handling

- **HTML sanitisation (DOMPurify allowlist):** scripts, iframes, `on*` handlers, `javascript:`/unknown URL schemes, non-allowlisted tags removed; removals are *recorded* in the report, not silent.
- **CSS scoping leak check:** after scoping, `assertAllSelectorsScoped` re-parses the emitted CSS independently and hard-fails if any selector is not under the scope attribute.
- **Dangerous CSS rejected outright:** `@import`, `@font-face`, `@keyframes`, `html`/`body`/admin-UI selectors, `position: fixed|sticky`, `|z-index| > 1000`, external `url()`.
- **Manifest cross-check:** an action/slot used in HTML but not declared (or declared but unused) is a hard error — the interactivity surface is always fully known.
- **Preview signature:** HMAC with expiry, `timingSafeEqual`, 403 on any mismatch; a leaked URL dies within ~10 minutes.
- **Preview CSP:** even if sanitisation were somehow bypassed, the preview page's CSP blocks all script execution and non-https resources.
- **Tenant scoping:** the screenshot POST resolves the composition strictly within the caller's tenant; unauthenticated/unauthorised callers get 404 (existence masking, same convention as `[id].js`).

## Frontend UI

- **File:** `client/src/components/canvas/blocks/AiCodeCompositionBlock.jsx`
- **Render:** fetches `GET /api/ai-compositions/:id` (shared with V1), branches on `schemaVersion === '2.0'`, and injects `<style>{doc.css}</style>` + `dangerouslySetInnerHTML` inside `<div data-ai-composition={compositionId}>`. Wired into canvas auto-height reflow via `useReportReflowHeight`; registered as an auto-height leaf so the flowed document drives block footprint at every breakpoint.
- **Inspector (Phase 0):** paste-a-composition-id "Attach" field plus a read-only safety report (identified elements, actions, slots, sanitiser removals, blocked CSS rules). A V1 document attached here shows a clear "use the original AI Composition block" message. No generation UI yet.
- **Cache:** query key `['/api/ai-compositions', compositionId]`, 30 s stale time (same as V1 block).

## Database Tables

### `ai_composition` (extended)

| Column | Type | Description |
|--------|------|-------------|
| `renderer_version` | int, default 1 | 1 = V1 scene graph, 2 = native code package. Discriminator only — reads still branch on the document's `schemaVersion`. |

### `ai_composition_version` (reused unchanged)

V2 stores its document, pipeline report (`validation_result`) and screenshot
records (`generation_metadata.screenshots`) in the existing columns. Version
pruning and restore work identically for both renderer versions.

## Data Flow Diagrams

```text
Fixture / (future) generator output
  → runAiCodePipeline(pkg, compositionId)
    → hard failure? → abort, nothing stored
    → success → ai_composition_version.document (immutable)
      → canvas block GET /api/ai-compositions/:id → verbatim render
      → POST /api/ai-compositions/preview
        → signed GET /api/ai-compositions/preview (CSP page)
          → Browserless 1440/1024/390 full-page captures
            → storeGeneratedAsset → tenant media library
              → generation_metadata.screenshots[]
```

## What Was Reused vs. Deprecated from V1

**Reused:** composition/version storage + pruning + restore, the public
`[id].js` read endpoint, Browserless screenshot infrastructure
(`browserlessScreenshot.js`), asset provenance (`aiCompositionAssetStore.js`,
`ai_generated_asset`), tenant permissions conventions, Design DNA/branding
context (Phase 1), the canvas block registration machinery and auto-height
reflow.

**Deprecated for V2 (V1 keeps them, read-only):** coordinate/scene-graph
generation, `AiCompositionRenderer` and its responsive geometry engine
(`buildAicCss`, per-breakpoint frames), client-side style sanitisation
(`sanitizeAicStyle` — V2 sanitises server-side at store time), the V1 patch
engine for prompt-led editing (V2 editing model is a Phase 2+ decision).

## Phase 0 Scope and What Comes Next

Phase 0 deliberately ships **no AI generation**: the pipeline is proven with
the hand-authored BNMS fixture end-to-end (validate → sanitise → scope →
store → render → screenshot). Phase 1 adds the generation loop that produces
V2 packages and retries on pipeline rejection; the reject-don't-repair design
above is what makes that loop convergent.
