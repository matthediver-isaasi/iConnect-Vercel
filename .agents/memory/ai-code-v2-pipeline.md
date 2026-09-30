---
name: AI Design Studio V2 native-code pipeline
description: How V2 (schemaVersion "2.0") HTML/CSS packages are sanitised, scoped, stored and rendered; gotchas found in Phase 0.
---

# AI Design Studio V2 pipeline lessons

- Sanitise ONCE server-side at store time (`runAiCodePipeline`); every render surface (canvas block, signed preview page) injects the stored document verbatim. Never re-sanitise client-side.
- The composition uuid IS the CSS scope (`[data-ai-composition="uuid"]`). Always run the pipeline against the REAL composition id — mint the uuid before piping; re-runs on an existing composition must re-pipe against the existing id or the scope won't match the wrapper.
- **Why:** if scope and wrapper drift, the stored CSS silently applies to nothing (or, worse, a stale scope could collide).
- DOMPurify quirks: `'#text'` must be in ALLOWED_TAGS, and hook-based filters must skip `#`-prefixed pseudo-nodes plus body/html/head, or plain text gets stripped.
- Reject-don't-repair: hard-fail on @import/@font-face/@keyframes, html/body selectors, fixed/sticky, external url(), undeclared actions/slots — the future generation loop retries; never silently mutate a package.
- Verification split in this workspace: dev server runtime DB is the legacy SOURCE (no `tenant` table), so DEST-seeded compositions can't render in local dev — verify via direct DEST supabase-js reads; Browserless + preview HMAC secrets exist only on Vercel.
- Signed preview: HMAC(compositionId.versionId.exp) with `AIC_PREVIEW_SECRET||CRON_SECRET`, ~10 min TTL, CSP `default-src 'none'` page — exists solely so cookie-less Browserless can render a version.
