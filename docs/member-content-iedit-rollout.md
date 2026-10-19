# iEdit knowledge indexing: verification and rollout

## Merge-readiness boundary

The owner has requested completion of implementation validation and submission
as Ready so this branch can merge and be deployed. Provider-backed backfill,
deployed member-session acceptance and signed-in UI verification remain
post-deployment work; they are not represented by the passing local fixtures.
No production deployment was performed from this task.

## Implementation contract

`iedit_page` is distinct from `canvas_page`; `ai_static` remains excluded.
The ordered canonical page/element snapshot is read after its generation claim.
Every renderer has an explicit extraction policy; see
[`member-content-iedit-extraction-coverage.md`](member-content-iedit-extraction-coverage.md).
Unknown renderers, unstable pagination, missing columns, provider errors and
oversized sources fail the whole page instead of publishing partial evidence.

Public and authenticated sections are separate. Page publication is never
authorization for a restricted linked resource, gallery, event or form.
Before model context, final answers and signed/history citations, the current
page is resolved again with the current viewer. Compact per-section proofs bind
the exact readable text, element order and selected source identities; current
parent generation is checked again after resolution. No conversation-aware
query rewriting, model policy or tone changes are included.

Database hooks invalidate both old/new page parents and tenants. Dynamic source
changes conservatively invalidate the tenant's iEdit pages, including newly
eligible automatic-list entries. This deliberately prioritizes correctness over
minimal reindex work. Service-only operation ownership and atomic generation
publication remain in use; the authored-repair publisher is not broadened.

New defaults include iEdit. Existing saved source lists are **not expanded**;
operators must explicitly enable iEdit where a saved list excludes it.

## Evidence boundaries

- Static extraction completeness is tested against the actual 28-type renderer map.
- Dynamic resolver tests exercise selection, audience gates, pagination and
  failure behavior. Schema projections were compiled read-only against verified
  DEST; this is not proof of a deployed index.
- Isolated PostgreSQL tests use real pgvector and PostgREST for RPC publication,
  stale claims, scope and migration compatibility. They do not write production.
- Request/answer fixtures use controlled model results. They are **not**
  real-model evidence or a signed-in deployed-member test.
- The original reported exchange is “Who is the CEO of Graduate Futures”
  followed by “Who else is on the board?”. Regression fixtures must preserve
  that literal follow-up rather than claiming context-aware rewriting.
- Read-only GFI extraction resolves the published People page and its current
  eligible board roster, preserving team/board section context and `/our-people`.
  This checks source completeness, not vector retrieval quality or model answers.

### Verification recorded

The focused application suites pass **235 tests**, and the real disposable
PostgreSQL/pgvector/PostgREST suites pass **3 tests**, with no skips. The Vite
production build passed (existing bundle-size/import warnings remain).

Completion review identified a missing fetched-card resolver. It is now
implemented, with positive tests through real generation/publication and live
access revalidation. Card selection/order/limits, display toggles, dependency
proofs, tenant/active-state filtering and failed loads are covered. Every
declared dynamic policy now also runs against the real resolver; an unsupported
dynamic type throws rather than publishing wrapper-only content. The already
applied migration includes the card-deck invalidation trigger; no extra
migration is required. Pages with card decks must be included in the pending
post-deployment backfill.

```sh
node scripts/run-isolated-tests.mjs --shell 'node --test api/_lib/memberContent*.test.mjs api/_lib/memberAiAnswer.test.mjs api/_lib/memberAiRetrieval.test.mjs api/admin/member-ai-settings.test.mjs api/platform/member-content-reindex.test.mjs client/src/components/admin/MemberAiAssistantSettings.sources.test.mjs scripts/recover-member-content-index.test.mjs'
env -i PATH="$PATH" HOME=/tmp LANG=C.UTF-8 node --test supabase/migrations/ieditMemberContent.test.mjs
npx vite build --outDir /tmp/iedit-final-build
```

The generic JavaScript test boundary rejected the native PostgREST process;
that invocation failed. The native fixture was then run with an empty inherited
environment (only PATH/HOME/locale supplied), a temporary Unix-socket database
and a loopback-only REST listener, and passed. No production credentials were
available to that fixture.

The app restarted and the platform route displayed the platform login gate.
The signed-in settings/rebuild controls were **not visually verified**. Preview
logs still report unrelated default-tenant branding/lookup failures against
the legacy workspace setup.

The post-application read-only GFI inspection produced 35 guest chunks and
confirmed `/our-people`. GFI's persisted source list now includes `iedit_page`
following explicit owner approval; every previous source choice was preserved.

## Database and backfill status

Applied migration: `supabase/migrations/202612310007_iedit_member_content.sql`.
**Applied to verified DEST on 2026-10-19 with explicit owner approval.
SOURCE was not modified. No task migrations remain unapplied.**
DEST is the verified external project `lvmzliemqnieeoruhkik`.
The applied SHA-256 is
`07d6a0b82bb7e26eb145f93a9899b5593d772c6bc388a87471d57f9ea1a93aee`.
Application used `scripts/apply-iedit-member-content.mjs` with the reviewed
hash and `--enable-gfi`. Migration and opt-in committed together after checking
the patched function contracts, service-only authority and all 33 installed
dependency/page triggers. The opt-in appended only `iedit_page` to GFI's
locked, existing source list; other tenant settings were not changed.
The migration uses exact inspected function-definition guards and aborts on
unexpected contract drift; it must not be replaced by replaying foundational
member-content migrations.

Read-only preflight:

```sh
node scripts/preflight-iedit-member-content.mjs --apply-dry-run
node scripts/inspect-iedit-knowledge.mjs \
  --tenant=fd82da65-aab7-4a5c-85b8-b2febeb2003d \
  --page=b1012823-fe46-4cc2-98a7-2e40e3c9ce89
```

Both commands are read-only. `--apply-dry-run` is **not** an apply mode.
The separate apply runner requires `--apply --review-sha256=<exact hash>`;
its optional `--enable-gfi` is specifically pinned to the approved tenant.
No production deployment or index backfill has been performed.

After release of the matching application:

1. Confirm the tenant's saved knowledge sources include `iedit_page`; do not
   silently overwrite deliberate exclusions.
2. Use the protected platform reindex operation scoped to GFI and `iedit_page`.
   Choose an explicit embedding allowance sufficient for a complete page
   (up to 100 chunks per slice); the default 20 may pause on this page. Keep the
   returned run identity, cursor and fixed scope/allowance together when resuming.
   A paused run needs a new explicit operation; allowance is per slice, not a
   lifetime provider-spend ledger.
3. Inspect per-source chunk counts, coverage/exclusions and failures. A failed
   or paused slice is not a successful completed backfill.
4. Verify direct board retrieval and the original two-turn exchange in an
   authorized deployed member session. Check current names/roles and the
   `/our-people` citation. Revalidate after a source/access change.
5. Only then run wider resumable reconciliation with an explicit allowance.
   Retain provider failures and remaining work rather than reporting success.

The workspace has no OpenAI embedding key; source inspection and isolated
fixtures cannot substitute for the deployed provider-backed checks above.
