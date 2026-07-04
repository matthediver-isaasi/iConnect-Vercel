---
name: Canvas "page from document" text fidelity
description: How AI page generation from .docx/pasted text is kept 100% faithful to the source wording.
---

# Canvas page-from-doc fidelity guarantee

The `/IEditPageManagement` "create Canvas page from document/text" feature
(`api/admin/canvas-from-doc.js`) must reproduce the supplied wording exactly —
no fabricated, injected, dropped, paraphrased, or duplicated text. Layout may be
auto-chosen.

The guarantee is enforced by three cooperating mechanisms, not by trusting the LLM:

- **Structured extraction is the single source of truth.** docx → ordered
  heading/para/listitem blocks; pasted text → verbatim paragraphs (leading
  bullet/number markers are part of the user's content, so they are NOT stripped —
  stripping them drops supplied text). `structureToText(structure)` is the source
  string both the fidelity check and the deterministic fallback use.

- **Fidelity guard is bidirectional** (`isSpecFaithful`): every emitted text chunk
  must be a contiguous verbatim (whitespace/case-normalised) substring of the
  source, AND source⊆spec (no drop) AND spec⊆source (no add/duplicate) on the word
  multiset. The LLM spec is accepted only when this passes; otherwise the
  deterministic 1:1 spec is used. Long docs (> MAX_DOC_CHARS) skip the LLM entirely
  and go deterministic, so their full text is never silently truncated.

- **Deterministic fallback is faithful by construction** (`buildDeterministicSpec`):
  the hero headline is the FIRST verbatim source block (never the admin page
  title/filename — that is not document body), consumed out of the body so it is
  not rendered twice.

**Why:** the LLM would otherwise inject CTAs/closing heros ("Learn more", "Get in
touch") and paraphrase. The layout engine's own factories were also fabricating
copy — `makeHero` now emits `ctas:[]` with no label, `makeCard` CTA defaults to
`''`, and `buildDesign` omits the closing hero unless `spec.closingHero.headline`
is present.

**How to apply:** any new text field the spec can render MUST be added to
`collectSpecTexts` or fabricated/dropped text will slip past the guard. Any layout
factory that interpolates source text into an HTML string MUST escape it (see
`escHtml` used in `makeH2`/`makeH3`) or literal `< > &` from the source get parsed
away — this is a fidelity bug, not just XSS. Body text paths already escape via
`ensureHtml` (plain lines) / `escapeHtml` (deterministic runs).
