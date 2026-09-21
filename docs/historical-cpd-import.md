# Historical CPD import — approval runbook (Task 4580)

## Live execution outcome — 2026-09-21

The user confirmed production project `lvmzliemqnieeoruhkik` and the BNMS
tenant, directed exclusion of all 18 flagged rows, explicitly approved the
sealed import below, and confirmed native CPD awards/member tenant changes
were paused for the import and replay.

| Reconciliation | Rows | Exact credits |
| --- | ---: | ---: |
| Source | 5,904 | 55,284 |
| Accepted and newly applied | 5,886 | 55,136 |
| Explicitly excluded pending review | 18 | 148 |
| Blocked | 0 | 0 |
| Already present on first apply | 0 | 0 |
| Replay: already present, skipped | 5,886 | 55,136 |
| Replay: newly applied | 0 | 0 |

All 2,580 source member UUIDs matched the confirmed BNMS tenant; none were
missing or cross-tenant. No native event-award overlaps or existing historical
source entries were found during initial preflight. The seven duplicate-looking
groups were contained within the nine repeated-code groups. Every flagged row
was explicitly excluded; no duplicate was automatically selected or deleted.

The import committed 59 batches. Live state was revalidated before each batch
and after each run, including verification that every accepted source hash
exists. Ledger/batch counts were 0/0 before import, 5,886/59 afterward, and
unchanged at 5,886/59 after replay. Replay therefore created no ledger entries
or batch records.

### Approval and schema evidence

- Approved manifest SHA-256:
  `59cbda7c57dccaffcff5e0dfc712fa71f9cc4f2163171b9a2250132ba95cbbb8`
- Reviewed preflight SHA-256:
  `a3d6fe1f3e476ce34f1246f831788e555619c5d34ccbd47af5df21c13e240fa9`
- Required historical migration file SHA-256:
  `be84310f81cce98e1518c2d97b6de22ff1d9f687c9a2c731488bf4a76567c4b4`
- **No migration was applied or remains required for this import.** Live
  import/reversal function bodies matched the historical migration exactly;
  the validator matched the subsequent
  `20261119_auditable_cpd_points_corrections.sql` migration. Required columns,
  source-uniqueness indexes, enabled protection/validation triggers and
  service-only RPC privileges were checked. No matching migration-history
  entry was found; this conclusion rests on installed definitions, not a
  claimed migration-history record. Do not rerun the original migration over
  these installed objects.
- All 25 isolated importer/SQL checks passed, including concurrent retries,
  source conflicts, replay, tenant isolation and native award/reversal behavior.

Detailed reports, per-entry exclusions, authorization, schema evidence, approval,
apply/replay results and count snapshots are retained outside the checkout in
`/home/runner/private-import-evidence/bnms-cpd-59cbda7c57dc/`
(directory mode 0700, files 0600). These contain personal data; do not publish
them. Further imports of the 18 excluded rows require separate evidence review
and approval. The quiet-window checks are complete; operators may resume the
paused activity.

## Original source-only reconciliation (superseded by live outcome above)

**At the time of the original offline report, no database was accessed, no migration applied and no import performed.**
Member matching and target migration status are **not checked**. Do not interpret source
approval status as authorization to write to an iConnect tenant.

Pinned source: `attached_assets/CPD_points_post_2021_to_import_1789892302196.xlsx`.

| Offline evidence | Result |
| --- | --- |
| SHA-256 | `9b1354284acec1acb5196b61de203e4738a31f0ff6379d864c04f0a1bf13b9ca` |
| Worksheet | Sheet1 |
| Source rows / distinct member UUIDs | 5,904 / 2,580 |
| Exact credits total | 55,284 |
| Entry date range | 2021-05-18 through 2026-09-15 |
| Unique Entry IDs | 5,904 |
| Member/date/code/credits duplicate-looking groups | 7 |
| Repeated member/code groups | 9 (may overlap the preceding groups) |
| Locked=false | 63 |
| Status / credit type | All approved / CPD |
| Expires / Score | All blank |
| Ordered source identity/hash digest | `e69c9f6a83812bc22855ddc91b0ffb6c3c856157e7bd21e92225ef8b79ae6677` |
| Accepted / skipped / blocked / applied | Not determined until target preflight; applied not attempted |

This committed summary contains no member names, UUIDs or individual Entry IDs.
Detailed reports, decision files, approvals and original workbooks contain personal
data: keep generated artifacts outside the repository in a restricted directory,
retain per your data policy and do not attach them to public tickets.

## Prerequisites and approvals

1. Independently confirm the intended Supabase project URL and tenant UUID. Neither
   generic `SUPABASE_*` variables nor runtime/source aliases select this import's target.
2. Obtain explicit approval separately for applying the historical-ledger migration.
   Required schema: immutable historical award support and
   `import_historical_cpd_points_batch(p_tenant_id uuid,p_batch_key text,p_manifest jsonb,p_rows jsonb,p_actor text)`.
   Existing native CPD migration `20261012_event_cpd_points_awards.sql` alone is insufficient.
   New required migration: `supabase/migrations/20261020_historical_cpd_points_import.sql`.
   Before the live execution above, it had been exercised only in isolated test
   databases and live installation status was unknown.
   Record its checksum and verified target migration
   history in the rollout ticket. For any new target, verify installed definitions
   and migration history independently. The importer does not run migrations.
3. Use a controlled operator shell with a service-role key authorized for that project.
   Set `HISTORICAL_CPD_SUPABASE_URL` to the exact approved URL and
   `HISTORICAL_CPD_SERVICE_KEY` through a secret manager, not command-line arguments,
   scripts, reports or shell history. Do not print environment variables or connection errors.
4. Arrange a quiet import window: pause concurrent CPD native award changes and member
   tenant changes. Client revalidation is not a serializable snapshot across all reads;
   the RPC must enforce current member ownership, source uniqueness/content conflicts
   and atomic max-100-row batches. A newly arriving native award between preflight and
   transaction cannot be prevented by this client-only overlap check.

## Commands

Examples use shell variables `TARGET`, `TENANT`, `PRIVATE_DIR` and `ACTOR`, populated
only after approval. `TARGET` is the canonical HTTPS Supabase project origin, with
no trailing slash, credentials, path or query. Create the private directory first,
outside the checkout. Every output filename must be new; artifacts are never overwritten.

### 1. Offline audit (default; no credentials or network)

```sh
node scripts/import-historical-cpd-points.mjs --out="$PRIVATE_DIR/source-audit.json"
node --test scripts/import-historical-cpd-points.test.mjs
```

The parser uses raw XLSX values, not formatted display strings. Original strings
(including whitespace), source cells and exact XML numeric lexemes are retained in
immutable provenance. Credits are decimal strings reconciled with bigint millionths.
Entry Date becomes an ISO calendar date; source fractional Excel time remains in
metadata and is not assigned an invented timezone. Certification Code is an activity
label, not a certificate ID. Details becomes the unchanged activity description.
Legacy Member ID and names are provenance only: UUID-only lookup, no member creation
or name/email fallback. Locked does not authorize mutation. Blank expiry/score does
not invent expiry, grading or attendance policy. Different bytes fail the pinned hash
and require a reviewed source-pin change; there is no CLI bypass.

### 2. Explicit read-only target preflight

```sh
node scripts/import-historical-cpd-points.mjs --preflight \
  --target="$TARGET" --tenant="$TENANT" --out="$PRIVATE_DIR/preflight-1.json"
```

This mode only reads. It reports matching/missing/cross-tenant UUIDs, both duplicate
group kinds, existing identical/conflicting source entries and native award IDs.
**Every native event award for a source member is a potential overlap**, deliberately
overinclusive: ledger insertion time is not reliable historical event time. Review
the real event/attendance records separately. Reversed native awards also remain
visible to this conservative check.

Prepare a private JSON decisions object keyed by exact source Entry ID:

```json
{
  "ENTRY_ID_FROM_REPORT": {
    "action": "keep",
    "reason": "Recorded reviewer rationale and evidence reference",
    "native_overlap_reviewed": true
  },
  "ANOTHER_ENTRY_ID_FROM_REPORT": {
    "action": "skip",
    "reason": "Recorded exclusion rationale"
  }
}
```

Use actual IDs, not these illustrative keys. Every row in either duplicate group
needs its own explicit keep/skip decision. A keep cannot override missing ownership
or source-content conflict. Explicit skip excludes a row, while retaining its
ownership/conflict findings in the report. No automatic duplicate deletion.
Native overlap requires `native_overlap_reviewed: true` when keeping the row.
Decisions require a nonblank reason; unknown IDs and malformed decisions fail.

```sh
node scripts/import-historical-cpd-points.mjs --preflight \
  --target="$TARGET" --tenant="$TENANT" --decisions="$PRIVATE_DIR/decisions.json" \
  --out="$PRIVATE_DIR/preflight-reviewed.json"
```

Verify accepted + skipped + blocked rows and decimal points equal the source totals.
Resolve every blocked row before approval. Record reviewers, exclusions, duplicate
decisions, native overlap evidence, target identity and report hash in the approval ticket.

### 3. Seal approval offline

```sh
node scripts/import-historical-cpd-points.mjs --approve \
  --target="$TARGET" --tenant="$TENANT" --actor="$ACTOR" \
  --report="$PRIVATE_DIR/preflight-reviewed.json" --out="$PRIVATE_DIR/approval.json"
```

This is an offline artifact operation, not a database write. The approval SHA-256
binds workbook, target, tenant, full report, decisions, accepted row identities/hashes,
review actor and exact row/points totals. Have the authorized approver independently
review this artifact and explicitly approve its printed hash. This hash is a content
integrity seal, not a cryptographic signature or substitute for organizational approval.

### 4. Explicit apply — only after migration and import authorization

```sh
node scripts/import-historical-cpd-points.mjs --apply --confirm-write \
  --target="$TARGET" --tenant="$TENANT" --actor="$ACTOR" \
  --approval="$PRIVATE_DIR/approval.json" --approval-sha256="$APPROVED_SHA256" \
  --out="$PRIVATE_DIR/apply-result-1.json"
```

Apply requires all flags; approval and credentials must match the exact target.
Live state is re-read before applying, before each chunk and after completion.
Only absent-to-identical source transitions are accepted on resume; changed ownership,
new/removed native overlap evidence or existing source content conflicts stop execution
for a new preflight/review. Each chunk is at most 100 rows, uses a deterministic
approval-hash/chunk-index batch key and transacts through the dedicated RPC, never
generic entity writes.

RPC manifest fields: `workbook_sha256`, `approval_sha256`, `source_system`, `target`,
`row_count`, `points_total` (the latter two are chunk totals). Row fields:
`source_entry_id`, `member_id`, `points_value` (decimal string), `activity_date`,
`activity_title`, `activity_description`, `source_metadata`, `row_hash`.
RPC returns `applied_count`, `skipped_count`, `applied_points`, `skipped_points`
(points must be decimal strings). The importer verifies both exact count and points
reconciliation, then confirms every accepted source hash exists.

### 5. Interrupted execution, replay and corrections

There is no automatic network retry or rollback of previously committed chunks.
On timeout/error, inspect durable ledger/batch state and rerun **the same approval,
hash and target** with a new output filename. Already committed identical source
entries are skipped. Durable server source uniqueness and row-hash comparison
are the authority, not a local progress file. Full replay should write nothing,
including no new batch record (RPC lazy batch creation). Test concurrent RPC retries
in an approved isolated database before rollout; offline tests only simulate state.

Final reconciliation distinguishes explicitly excluded rows from RPC already-present
skips: accepted = newly applied + already present, each with exact credits; source =
accepted + explicit exclusions + blocked (blocked must be zero to apply).
If reconciliation fails, stop and inspect durable state, never assume zero writes.
Keep the final report with the approved manifest and deployment evidence.

Never overwrite/delete imported ledger rows or alter source Entry IDs to evade
conflicts. Corrections require separately approved append-only action. A historical
award can be reversed using the dedicated admin/service RPC
`reverse_historical_cpd_points_award(p_tenant_id,p_ledger_entry_id,p_reason,p_actor)`;
this importer does not call it. A linked reversal does not erase original source
identity; replay must not resurrect an imported award.

## Offline test scope

Tests cover pinned workbook totals, original-string/decimal preservation, invalid
source shapes, UUID ownership, duplicates and overlaps, approval tampering, source
conflicts, live-state drift, chunk bounds, interrupted/resumed/replayed batches and
RPC reconciliation failures. They use in-memory adapters only, not live credentials.
SQL integrity/native reversal/concurrent transaction tests are separate rollout gates;
do not claim them or production matching/import completion from these unit tests.