# Project discussion schema rollout

## Installed destination and approval

On 2026-11-24 the owner explicitly approved the focused DEST rollout and then
confirmed that Supabase PITR provides recovery to two minutes, accepting that
coverage without another backup operation. This is owner-reported recovery
coverage, not an independently verified recovery timestamp or restore test.

Only `supabase/migrations/202701260001_project_discussions.sql` was installed.

- Target: `lvmzliemqnieeoruhkik`, verified through the managed project lookup as
  `iconn-multi-tenant`, `ACTIVE_HEALTHY`.
- Reviewed source SHA-256:
  `27b07b45a5f6f9c2dab193f4fade22681a6ad72f9bcfd3172a6d6830ca45ca7a`.
- Managed migration name: `project_discussions`.
- Recorded deployment version: `20261124170540`.
- Post-install verification time: `2026-11-24T17:06:04Z`.

**Do not replay the source file or the migrations directory.** The managed
deployment version is different from the source filename version. No database
inspection or migration was directed at SOURCE, and SOURCE was not modified.
No application deployment occurred.

## Prerequisite review

Read-only inspection confirmed the actual installed contracts rather than
relying on original source version numbers, which were absent from migration
history:

- Project card, board, membership, comment, attachment and activity tables.
- Mention inbox columns, board-recipient membership FK, comment-recipient
  uniqueness, and service-only existing mention function.
- The installed mention function compares UUID actor/recipient parameters to
  `tenant_identity.id` through explicit UUID-to-text conversion. Identity IDs
  are varchar; board-member/comment identity IDs are UUID.
- Existing image function signature, service-only execution, attachment
  ownership/type/size checks and retry semantics.
- Image-link composite key, attachment/comment cascade FKs, comment
  `client_request_id` and its partial unique index.
- Service-role privileges on all eight existing tables used by the migration
  and discussion transactions.
- Absence of the new discussion functions, tables, columns and legacy rename
  before installation.

No prerequisite migration was replayed.

## Transactional rehearsal and installation

The managed migration connection ran a single guarded PostgreSQL `DO` statement.
The focused file's outer `BEGIN` / `COMMIT` were removed from the executed body
so that they could not commit independently of the guards. The source file was
not edited.

Both rehearsal and installation used the same migration body and checks:

1. Set a five-second lock timeout and lock the eight existing project tables
   against concurrent writes for the short migration transaction.
2. Reject an already-installed or partially installed discussion schema.
3. Verify prerequisite mention/image signatures.
4. Capture count and ordered whole-row fingerprints of `project_card`,
   `project_card_comment`, `project_card_activity`, `project_card_attachment`,
   `project_comment_image`, `project_mention_inbox`, `project_board` and
   `project_board_member`.
5. Execute only the reviewed discussion migration.
6. Verify all seven function signatures and service-only execution, RLS and
   restricted access on both new tables, initial legacy shape, exact request
   backfill payloads and absence of initial reactions.
7. Compare all existing-row fingerprints, excluding only newly added fields.

The rehearsal deliberately raised
`DISCUSSION_REHEARSAL_PASSED_ROLLED_BACK` after every check passed. The expected
exception was observed. An independent read confirmed no new discussion
objects, columns, legacy rename or rehearsal history row remained.

Installation removed only that deliberate terminal exception. The managed
connection returned success and recorded the deployment version above.

## Verification results

- Seven expected signatures installed, including the renamed legacy helper
  and both compatibility wrappers.
- Every function is security-invoker with `search_path=public, pg_temp`.
- Service role can execute all seven; PUBLIC, anon and authenticated cannot.
- Both new tables have RLS enabled and zero policies. Separate checks of
  SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER privileges
  confirmed every privilege is granted to service role and none to anon or
  authenticated.
- All 94 existing comments retained their original fields and literal legacy
  shape. Their ordered original-field fingerprint remained
  `bfa265b78afc9e8a45b5f4cfe79bc3e8` before rehearsal, after rollback and after
  installation.
- The installation transaction also preserved whole-row fingerprints for the
  other seven existing tables listed above.
- Exactly 71 existing submission IDs were backfilled into the new request
  ledger; zero reactions were created.
- A service-authenticated **GET** of DEST's PostgREST OpenAPI document returned
  HTTP 200 and exposed `project_discussion_access`, `read_project_discussion`,
  `write_project_discussion`, `create_project_comment_with_mentions` and
  `create_project_comment_with_images`. No mutation RPC was invoked.

The following isolated command passed all 25 tests, including real PostgreSQL
lifecycle/concurrency checks against a disposable local cluster:

```sh
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test --test-concurrency=1 \
  api/_lib/projectDiscussion.postgres.test.mjs \
  api/_lib/projectDiscussionContent.test.mjs \
  api/_lib/projectDiscussionReads.test.mjs \
  api/_lib/projectCommentImagesApi.test.mjs \
  api/_lib/projectBoardSearch.test.mjs \
  client/src/lib/projectBoardCache.test.mjs
```

## Evidence boundaries

This resolves the verified missing-schema dependency. The prior RPC 404 /
PGRST202 evidence was broad service-role evidence, **not** a capture of the
originally reported board request.

The exact board browser request and signed-in UI remain unverified. Discovery
does not prove a successful authenticated task-detail request. No customer
comment, reply, edit, deletion, reaction, upload, inbox delivery, payment,
provider operation or application deployment was performed. Such live actions
require separate permission.

The anonymous local preview rendered `Public API Error (404): Tenant not found`.
Its browser logs identify the legacy SOURCE configuration, not the verified
DEST database. That preview capture does not verify or invalidate the DEST
schema installation and was not used as evidence of a working discussion UI.
