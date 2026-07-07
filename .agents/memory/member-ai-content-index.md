---
name: Member AI content index
description: What it takes to add/change a content type in the Member AI Knowledge Assistant RAG index, and why retrieval is the security boundary.
---

# Member AI Knowledge Assistant (RAG over member content)

Tenant-isolated RAG chat that answers member questions over resources, events
(`event` + `complex_event`), `news_post`, `blog_post`. Reuses the Help RAG stack
verbatim (embedding `text-embedding-3-small`/1536, chat `gpt-4o-mini`, key
resolution `AI_INTEGRATIONS_OPENAI_API_KEY`→`OPENAI_API_KEY`).

## Retrieval IS the security boundary
`api/_lib/memberContentVisibility.js#isChunkVisibleToMember` is the single source
of truth for "may this member see this chunk". It is a PURE function (unit-tested
in `memberContentVisibility.test.mjs`) and mirrors the public/browse rules
(status gates, `member_group_id`, `allowed_role_ids`, `event_state=draft`,
`group_event_public`, `published_date<=now`). Admins (authenticated non-member
tenant users) bypass group/role gating. Tenant scoping is enforced twice: the
`match_member_content_chunks` RPC filters by `p_tenant_id` AND the visibility
function re-checks `chunk.tenant_id` (defence in depth).

**Why:** a change that widens retrieval silently widens what members can read.
Never relax the visibility function to "make search find more".

## Adding / changing a content type touches 4 places
1. `CONTENT_TYPE_CONFIG` (table, columns, feature_key) in `memberContentIndexer.js`
2. visibility rules in `memberContentVisibility.js` (+ `CONTENT_TYPES`)
3. text builder in `memberContentChunker.js` (`buildMemberContentText`)
4. entity-name→type map in `memberContentReindexHook.js` (`ENTITY_TO_CONTENT_TYPE`, lowercased)

## Freshness
On-save hooks (`reindexMemberContentEntitySafe` / `deleteMemberContentEntitySafe`)
are best-effort and wired into the generic entity endpoints only
(`api/entities/[entity]/index.js` POST, `[id].js` PATCH/DELETE). Content edited
through non-generic flows (e.g. the multi-step event cancellation flow) bypasses
them — the cron `/api/cron/reindex-member-content` (and
`scripts/reindex-member-content.mjs --apply`) reconciles everything.

## Orphan chunks are an access-control bug, not just cruft
`member_content_chunk` is polymorphic (`content_type` + `source_id`) with NO FK
cascade, and the ask endpoint trusts chunk metadata for visibility (it does not
re-check that the source row still exists). So a chunk left behind by a hard
delete can still be retrieved and cited = data leak. Two defences, keep both:
1. Immediate delete hook in every NON-generic hard-delete flow (the big one is
   `api/_lib/eventDeletion.js`, which deletes event/complex_event rows directly).
2. `sweepOrphanedMemberContentChunks` runs at the end of `reindexAllMemberContent`
   (cron/backfill): lists indexed source_ids per type, checks which still exist in
   the source table, deletes chunks for the missing ones.

**Why:** the reviewer rejected the first pass precisely because reconcile only
re-indexed existing rows and never purged rows for deleted sources. Any new
non-generic hard-delete path for an indexed entity MUST call
`deleteMemberContentChunks(type, id, {supabase, tenantId})`.

**Why no embedding from the workspace:** the OpenAI key only exists on Vercel/CI.
The on-save hook DEFERS indexable content to the cron when no key is present; the
backfill script's `--apply` and the cron both require the key. Dry-run works
anywhere (chunk plan only).

## Broad/recency questions fail at the PROMPT, not retrieval
When the assistant gives its stock "I don't have that information" answer despite
a healthy index, check the model refusal path first: retrieval can succeed (good
chunks reach the model) and the strictly-grounded model still declines to
synthesise "latest developments in X" because excerpts carry no dates and the
prompt forbids anything not directly answered. Fixes that matter, in order:
synthesis-permissive prompt + today's date, per-excerpt published/event dates,
bigger deduped context budget (per-source cap), recency re-rank (blended
similarity+date decay, strictly AFTER the visibility filter), multi-query
expansion for broad questions (skipped for short factual ones, best-effort so a
failure never blocks answering). The hard fallback path logs a structured line
(candidate count, drops by similarity floor vs visibility, top similarities) so
future misses are diagnosable from Vercel logs — distinguish "fallback fired"
from "model refused" before touching retrieval.

**Why:** the first diagnosis assumed the FALLBACK_ANSWER fired; prod showed the
model itself refused. Retrieval-side "fixes" would not have changed the answer.

## Reindex cron is a resumable self-triggering chain (60s cap)
`reindexAllMemberContent` takes `deadlineMs` + `cursor` and returns `{done,
nextCursor}`. The cron processes a ~40s slice then self-triggers the next slice
(POST to itself, Bearer CRON_SECRET, `cursor` in body, bounded-abort dispatch
like the import worker). Cursor is `{type,lastId}` (keyset, NOT offset — rows can
shift between slices) then `{phase:'sweep'}` then done.

**Why no job table / heartbeat lock here (unlike the import/export workers):**
re-indexing is idempotent — unchanged chunks reuse their embedding — so a dropped
chain costs nothing to restart; the 6h cron just re-runs from `cursor:null` and
makes progress off the persisted `member_content_chunk` state. Durability lives
in the DB rows, not in a job/cursor table. A MAX_HOPS guard caps the chain only
as a runaway safety net (progress is monotonic, so it's never hit normally).
