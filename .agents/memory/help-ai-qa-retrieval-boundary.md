---
name: Help Center AI Q&A retrieval security boundary
description: Why AI help answers can only cite content the asker may see, and what must stay in lockstep.
---

The Help Center AI Q&A (natural-language question -> grounded answer + citations)
uses **retrieval as its security boundary**: an answer may only be built from
help-article chunks the asking user is allowed to see. There is no separate
authorization on the answer text — if an inaccessible chunk reaches the LLM it
leaks, so the filter is the whole game.

Two gates, both enforced at retrieval time, both resolved server-side:
- article-level `help_article.required_feature`
- section-level `{{feature: key}} ... {{/feature}}` blocks (nestable)

**Rule:** each stored chunk carries `feature_gates` = required_feature + every
enclosing {{feature}} key; a chunk is retrievable iff the asker can access
EVERY gate in that array (any denied gate hides it — same as the page renderer).

**Why:** the chunker's gate computation MUST mirror the display DSL parser in
`client/src/components/help/HelpArticleContent.jsx`. If they drift, the AI can
surface guidance (e.g. training-fund steps) to members who can't use that
feature, even though the page hides it. Parity is locked by
`api/_lib/helpArticleChunker.test.mjs` (mirrors the HelpArticleContent tests).

**How to apply:**
- Chunking + gate logic: `api/_lib/helpArticleChunker.js`. Any change to the
  section-gate DSL in HelpArticleContent.jsx must be reflected here AND the
  index re-built, or gates go stale.
- Access resolution: `api/_lib/memberFeatureAccess.js` (server twin of the
  client `useMemberAccess` hook) — combines role.excluded_features +
  member.member_excluded_features, reuses roleVisibility.isResourceExcluded,
  and **fails closed** on a role lookup error (tolerates a missing role row).
- Authenticated non-members (tenant/admin users, no member record) get full
  access, matching the article editor preview.
- Embeddings need an OpenAI key, which is NOT present in the Replit workspace —
  the `--apply` backfill (`scripts/reindex-help-articles.mjs`) and any live
  ask/index path only work on Vercel/CI. Dry-run (chunk plan) works locally.
