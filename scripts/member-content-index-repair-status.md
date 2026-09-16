# Member content index repair — operational report

## Final-path verification (2026-09-16, 21:41 UTC)

The final database package is explicitly **destination-only operational SQL**,
outside the normal Supabase migration chain. Its checked-in manifest orders
`001-publish.sql`, `002-canvas.sql`, then `003-microsite-fence.sql`; tests apply
the entire manifest twice. This does not invent or replay the separate
generation-schema foundation.

The microsite extension invalidates affected Canvas generations on
deactivation, rename and deletion. Publication locks the microsite before the
canonical page and source, rechecks the current route, and rejects stale
snapshots. The private publisher core cannot be called by `service_role`,
`anon` or `authenticated`; only the fenced wrapper permits service execution.
Real-PostgreSQL tests cover repeat application, role grants, Unicode route
encoding, tenant isolation and a concurrent FK-delete/publication race.

After reviewed dry-run output, the complete manifest was applied to DEST at
approximately **21:40 UTC**. At **21:40:41 UTC**, the complete scoped REST
index-and-sweep cycle passed twice again: four processed items, four reused
chunks, `done:true`, null cursor, zero errors, unchanged fingerprints and zero
duplicate groups. At 21:41:01 UTC, live catalog checks confirmed the enabled
microsite invalidation trigger and wrapper/private-core execution boundaries.
No application redeployment was required for this unchanged six-argument RPC.

The full focused suite passed **93 tests**; the final URI-encoding change and
all operational SQL/manifest tests were subsequently rerun successfully.

The completion review identified two gaps in the initial authored-content
release. Both are now implemented and tested:

- Public Canvas pages are canonically re-read after claiming. The shared guest
  projection removes member-only content before extraction. Symbol dependencies
  use the deployed retrieval contract's exact JSON keys; publication locks and
  verifies their registry generations before locking the parent. Private layouts
  publish an empty index snapshot, never their content.
- Deleted sources are reconciled from the registry through the same fenced
  publisher. The sweep is bounded and resumable, and excludes `canvas_symbol`
  dependency-fence rows rather than treating them as indexing failures.
- The additive Canvas publisher extension was applied only to DEST. No dependency
  table, retrieval change, security bypass or source-record deletion was added.
- A real REST test exposed Supabase's safe-update restriction on temporary-table
  normalization (`21000`, “UPDATE requires a WHERE clause”). Both narrow
  migrations now use a meaningful staging predicate; invalid null chunk indices
  still fail validation. Failed attempts rolled back. This was fixed without
  disabling safe updates and then verified through REST, not just direct SQL.
- At **20:53:32 UTC**, three production Canvas pages saved eight chunks through
  Supabase REST and repeated successfully: eight reused embeddings per pass,
  zero errors, unchanged fingerprints and zero duplicate groups.
- At **20:55:38 UTC**, a small tenant completed the full all-content-type indexing
  **and registry sweep** twice: `done:true`, null cursor, four processed items,
  four reused chunks per pass, zero errors and unchanged fingerprints.
  This is a complete scoped production cycle, not an observation of the global
  scheduled cron.
- The three previously pending Canvas pages were separately attempted with zero
  embedding allowance. They now reach the functioning writer but require 3, 7
  and 6 new embeddings respectively. Together with the two pending events, five
  sources remain for a paid bounded pass. No new embedding calls were made.
- All **90 focused tests** pass. After the staging-predicate fix, both real
  temporary-PostgreSQL migration suites were rerun successfully.

The final isolated application revision is
`9d10ed67b3d59f2df767acabec1ccad0fffb2774`, adding only the Canvas adapter,
tombstone helper and shared guest-projection helper to the initial three-file
hotfix. Deployment `dpl_App9UxyA3mLbBrsQqZKaeXbabkKh` became **READY at
21:12:56.585 UTC** on the existing production aliases. Subsequent production
HTTP checks returned 200 for the homepage and 401 for the unauthenticated cron.

At 21:13:48 UTC the database still contained 3,287 chunks, all flagged active,
zero duplicate five-column keys, and the same five pending sources (two events,
three Canvas pages). The remaining five are now supported by the runtime; they
were not forced past the zero-new-embedding operational allowance.

The final deployment's runtime-log request ran from **21:13:57 to 21:16:25 UTC**,
including **120.002 seconds of stream observation** after response headers.
Fourteen JSON records contained no `42P10`/matching ON CONFLICT signature and no
“UPDATE requires a WHERE clause” signature. This is a limited post-publication
window, not proof of a complete global scheduled cron or comprehensive Supabase
database-log coverage. The complete scoped production cycle described above was
verified separately through the actual REST publisher.

Use `--transport=rest` with the recovery command for `--type=canvas_page` or
`--type=all`; the pinned DEST REST client exercises the application's actual RPC
transport. The default operational allowance remains zero new embeddings.

The following sections record the earlier authored-only release and investigation;
their Canvas deferral statements are historical, superseded by the results above.

## Initial authored recovery (2026-09-16, 20:17 UTC)

The original three-column index must **not** be restored. Production deliberately
uses generation-scoped uniqueness. The targeted repair adapts the writer to that
contract rather than replacing it.

- Applied only `scripts/sql/member-content-repair/001-publish.sql` to DEST at 19:44 UTC
  using verified TLS, a transaction, a 3-second lock timeout and a 30-second
  statement timeout. The existing valid five-column unique index was retained.
- The new service-role-only publisher locks the source registry row, checks its
  generation and five-minute claim lease, validates the complete snapshot,
  upserts the five-column key, removes only superseded authored chunks, and
  activates the result atomically. No source records, retrieval RPCs, or tenant
  access controls were changed.
- The replacement writer re-reads canonical source content after claiming and
  refuses Canvas, event-linked resources and non-authored provenance. It checks
  publisher readiness before any embedding calls.
- At 19:51:42 UTC the one-article production sample saved four chunks and repeated
  successfully: four reused embeddings per pass, no new embeddings, no errors,
  stable chunk IDs/content hashes/access metadata, and zero duplicate groups.
  The scoped chunk total stayed at 139. A subsequent content change still
  requires an embedding; reuse is allowed only for the same model and exact
  title/content input.
- At 19:58 UTC, four pending authored sources were attempted through the existing
  bounded/resumable indexer, one source/15 seconds per slice, embedding budget
  zero. Two articles reconciled successfully: one no-longer-indexable article
  published an empty index snapshot (the source record was not deleted), and
  another reused three embeddings. Two events stopped explicitly with
  `MEMBER_CONTENT_EMBEDDING_BUDGET`; they need new embeddings. Three pending
  Canvas sources remain outside this narrow repair.
- Validation: 66 focused tests passed, including actual temporary-Postgres
  publication and adapter tests. Missing/correct/mismatched/invalid indexes,
  duplicate data, stale claims, provenance conflicts, repeat IDs, rollback,
  budget handling and provider failures are covered. A read-only live composite
  check confirmed the 1,536-dimensional pgvector input format.
- The initial operational adapter attempts exposed bigint/JSON serialization and
  reporting issues. They were corrected and covered with real-Postgres tests.
  Failed publication attempts rolled back and released their own claims; no
  source content or embeddings were printed.

### Targeted application deployment

GitHub branch `repair-member-ai-index`, commit
`b2b04c6a7118d54e6fa6d1bac77c9d1729951937`, is based on the exact previous
production commit `aaa9e9008ec751cab605ce9a12f98b34dd29c7a6`. It changes only:

- `api/_lib/memberContentIndexer.js`
- `api/_lib/memberContentGenerationWriter.js`
- `api/cron/reindex-member-content.js`

The cron passes at most 20 new embedding chunks through a sequential continuation
chain and at most 50 sources/40 seconds per slice. Provider attempts remain
charged even when publication fails. Budget exhaustion stops self-continuation.
This is not a replay-proof durable billing ledger.

Vercel deployment `dpl_9BF3FaXXYaxt67KkRV9Ptc7oMtCK` became **READY at
20:15:52.982 UTC** with the recorded hotfix commit. Vercel assigned the existing
production aliases, including `iconn.app`, `*.iconn.app`, `isupporter.app`,
`*.isupporter.app`, BNMS and Graduate Futures domains. A subsequent HTTPS check
returned 200 for the production homepage and 401 for an unauthenticated cron
request. No broader branch, full schema replay or AI UI change was included.

The focused SQL was reapplied successfully to verify repeatability and notify
PostgREST to reload its schema cache. Live catalog checks confirmed the pinned
function search path, SECURITY DEFINER status, execution denied to `anon` and
`authenticated`, and execution granted to `service_role`.

### Observation and remaining limits

- After publication, a 20.002-second Vercel runtime-log stream returned six JSON
  records and zero matches for `42P10` or the matching ON CONFLICT error message.
  This is a short observation, **not evidence of an entire scheduled indexing
  cycle**. The pre-publication log attempt timed out; Supabase log callbacks
  were unavailable, so no comprehensive database-log claim is made.
- The last aggregate check (20:01:59 UTC) found 3,287 chunks, all flagged active,
  zero duplicate five-column keys, and five pending registry sources: two
  events and three Canvas pages. Active flags alone do not override the
  retrieval generation fence. The two events exceeded the zero-embedding
  catch-up allowance; Canvas is deliberately unsupported by this narrow writer.
- No paid embedding calls were made during the manual repair or catch-up.
  Scheduled authenticated continuations now carry the bounded allowance
  described above.
- The development preview still cannot resolve its tenant against the
  unchanged legacy SOURCE configuration. Production HTTP checks passed; SOURCE
  was not changed. Existing broader workflow logs also contain unrelated
  payment, reserved-slug and membership-workflow test failures. The focused
  repair suite passed; this report does not claim every Postgres or project-wide
  error is resolved.

### Reproducible operational commands

- `node scripts/apply-member-content-repair.mjs` — read-only catalog check.
- Add `--apply` to install only the focused, repeatable migration.
- `node scripts/recover-member-content-index.mjs --tenant=<uuid> --type=blog_post
  --max-items=1 --seconds=20` — read-only source plan.
- Add `--apply --repeat` for the zero-embedding bounded save/repeat check.
- Use `--cursor='{"type":"blog_post","lastId":"<previous-id>"}'` to resume.
- `node --test api/_lib/memberContent*.test.mjs api/cron/reindex-member-content.test.mjs
  scripts/lib/member-index-pg-client*.test.mjs scripts/recover-member-content-index.test.mjs
  scripts/sql/member-content-repair/*.test.mjs`

The entries below record the earlier investigation and are historical, not the
current status.

## Verified on 2026-09-16

Read-only inspection of destination project `lvmzliemqnieeoruhkik` used the
destination-only connection string and verified TLS with Supabase's published
CA certificate. No SOURCE connection was used.

- The original `member_content_chunk_source_idx` is absent.
- `member_content_chunk_generation_idx` is unique, valid and ready on
  `(tenant_id, content_type, source_id, chunk_index, source_generation)`.
- `source_generation` is NOT NULL and has no default.
- `is_active` defaults to false.
- Production has source invalidation, queued reindex jobs and a
  claim-token-fenced generation activation function.
- Activation publishes the claimed generation and removes older generations.
- Retrieval checks active generation and dependency generations.
- The inspection counted 3,287 chunks, all active generation 1.
- A 20-second-timeout duplicate-key check completed and returned zero
  duplicate groups on `(content_type, source_id, chunk_index)`.
- The supplied production log proves the legacy writer uses that three-column
  ON CONFLICT target; the current checkout uses the same target.
- The generation-aware writer and migration were not found in this checkout or
  the available Git history. This does not establish that they do not exist in
  another task workspace or unmerged change.

## Why no DDL was applied

This is deliberate schema evolution, not a missing equivalent index.
Reintroducing the old index would prevent staging a new generation alongside
the previous one. It would not repair the current writer: it supplies neither
the required generation nor the activation protocol. Changing only its conflict
target, or adding a generation default, is also insufficient.

An independent safety review confirmed that restoring legacy uniqueness is
unsafe. No migration, source deletion, index rebuild, retrieval change, or
production indexing run was performed. There were no embedding calls.

## Remaining work

Recover and inspect the generation-aware implementation from the related
knowledge-service work, then reconcile the deployed writer and live database
contract. Any urgent compatibility release must preserve claims, staging,
generation-scoped cleanup and fenced activation. Verify with a bounded real
indexing sample, repeat it, then process bounded/resumable catch-up.

No post-repair observation window exists because no repair was applied.
The Supabase log tools were documented but unavailable as callable tools in this
session. No claim is made about error recurrence or unrelated Postgres errors.

## Repeatable read-only inspection

`node scripts/inspect-member-content-index.mjs`

The command pins DEST, verifies TLS, uses a read-only transaction and per-query
timeouts, and prints only catalog metadata and aggregate counts. It does not
print source text, embeddings or credentials. The duplicate query stops after
ten duplicate groups but may scan the table; the timeout bounds its runtime.

## Continued investigation and protective changes

Vercel's production deployment listing identified the READY production
deployment `dpl_216D9K59eK2y8ZzdXvxX9eibQ5ea`, from the `object` branch.
Its recorded commit's writer also uses the legacy three-column conflict target.
All advertised origin branch tips were present locally; reachable and
unreachable history searches did not locate the generation-aware writer.
The related knowledge-service specification explicitly requires generation
staging and fenced activation, confirming that the database contract must not
be replaced by legacy uniqueness.

The 2026-09-16 19:09 UTC destination recheck still found 3,287 chunks and no
legacy-key duplicate groups.

Protective code is now prepared, **not deployed**:

- Legacy indexing checks for the generation schema before embeddings or chunk
  mutations. It refuses incompatible runs with `MEMBER_CONTENT_SCHEMA_MISMATCH`.
- Direct chunk deletion and orphan sweeps use the same guard.
- The old full-migration runner now defaults to read-only inspection, is
  destination-pinned with verified TLS, and refuses the generation schema.
- Explicit legacy migration application serializes its schema check with DDL
  on an existing chunk table and has lock/statement timeouts.

Verification: all 29 member-content tests pass; syntax and diff checks pass.
The live destination **dry-run** correctly refuses the original migration.
Independent code review found no defects in this limited safeguard.

This does not restore indexing and is not a completion of the repair. No
production writes, deployment, embedding sample, catch-up, or post-repair
observation window has occurred. The unavailable generation-aware writer is
still the blocking dependency; do not interpret the guard as a successful
recovery.