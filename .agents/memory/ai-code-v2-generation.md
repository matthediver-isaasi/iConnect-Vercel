---
name: AI V2 code-first generation
description: Decisions for the V2 (native HTML/CSS) AI section generation path.
---

- The V2 generation endpoint is staged/resumable like V1 (context → code) on the same job table with `options.rendererVersion=2`; the client drives it with a jobId poll loop. The composition UUID is minted at the context stage because the CSS scope is keyed on it; DB rows are only inserted on success.
- **Reject-don't-repair extends to sanitiser removals:** DOMPurify silently STRIPS disallowed markup (scripts, iframes, handlers) rather than failing the pipeline, so the generation gates must treat any non-empty `htmlRemoved` in the sanitisation report as a hard rejection. **Why:** a stored document must never be a silently repaired version of the model output.
- Breakpoint previews of V2 documents must render in an `iframe srcDoc` at the real width and scale the iframe down — `@media` rules evaluate against the viewport, so a `transform: scale()` div always shows desktop styles.
- Canvas inspector components receive `update` (an updater-fn setter), NOT `onChange` with the whole block; a mismatch fails silently.
- `recordAiUsageEvent` default status is `'succeeded'` (do not pass `'success'`); `ai_composition` has no `original_prompt` column.
- **Phase 2 page bodies:** `page_body` runs a deterministic-checked plan stage first (content manifest + creative plan); code gates then enforce the plan's own promises (section keys present, slots reserved) and forbid header/footer/nav. Actions are hint-based (`data-ai-action` + manifest) resolved server-side best-effort before persist; only actions referenced from the markup (`sanitisation.actionKeys`) gate page publish — slots never do. Slot placeholders are filled client-side via `createPortal` with trusted registry blocks (`el.innerHTML=''` first).
