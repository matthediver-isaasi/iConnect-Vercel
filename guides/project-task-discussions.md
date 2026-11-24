# Project Task Discussions

**Author:** Replit Agent  
**Last Updated:** November 2026  
**Module:** Projects and Sales

## Table of Contents
1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Thread ordering and deletion](#thread-ordering-and-deletion)
4. [Rich content and references](#rich-content-and-references)
5. [Code paths and frontend](#code-paths-and-frontend)
6. [Database tables](#database-tables)
7. [Safeguards and error handling](#safeguards-and-error-handling)
8. [Rollout requirements](#rollout-requirements)
9. [Verification and troubleshooting](#verification-and-troubleshooting)

## Overview

Projects and Sales share the task-detail modal and discussion controls. Roots are
newest first; replies remain oldest first beneath their root. A reply to a reply
joins that root and keeps an optional target reference for context. Legacy posts
stay top-level and retain literal plain text; angle brackets never activate HTML.

Only current writing members can reply or react. Only a post's author, with
current writing access, can edit or delete it. Administrators cannot edit other
authors' posts. Explicit mentions retain the existing inbox delivery mechanism;
replies alone, reactions and edits do not create notifications.

## Architecture

| File | Purpose |
|---|---|
| `supabase/migrations/202701260001_project_discussions.sql` | Focused schema, transactions, ordering, service grants |
| `api/_lib/projectDiscussionContent.js` | Versioned JSON allowlist, URL validation, readable projection |
| `api/_lib/projectDiscussion.js` | Complete discussion read contract |
| `api/projects/cards/[cardId]/comments.js` | Authenticated discussion operations |
| `api/projects/cards/[cardId].js` | Task detail, using the same discussion reader |
| `client/src/components/projects/ActivityComposer.jsx` | Isolated create/reply/edit drafts and upload preparation |
| `client/src/components/projects/DiscussionEditor.jsx` | Dedicated TipTap editor, without changing other rich-text consumers |
| `client/src/components/projects/DiscussionRenderer.jsx` | Safe React rendering, literal legacy text |
| `client/src/components/projects/DiscussionThread.jsx` | Threads, author controls and reactions |
| `client/src/components/sales/ProjectCardDetailModal.jsx` | Shared Projects/Sales integration |
| `client/src/lib/projectBoardCache.js` | Confirmed snapshot publication and counts |
| `client/src/hooks/useProjectBoardRealtime.js` | Existing authorized card refresh signal |

Design principles:
1. Serialize writes on the task row, so promotion and reply creation cannot lose posts.
2. Treat rich JSON as explicit versioned content, never infer HTML from old text.
3. Reference attachments rather than files or signed URLs, preserving private access.
4. Return complete transaction snapshots, so completion feedback ends with visible state.
5. Keep reaction rows service-only; refresh through the existing authorized task API.

## Thread ordering and deletion

The reader aggregates all comments without PostgREST row limits. Its order is:

```text
root.created_at DESC, root.id DESC
  root first
  replies.created_at ASC, replies.id ASC
```

Replies never bump a root. On root deletion, the writer locks the task, selects
the earliest reply using timestamp plus ID, clears that reply's parent, then
reparents every remaining reply before deleting exactly the original row.
Reply-target references to the deleted row become null. No survivor's author,
posting time, document, images, reactions or mention rows are rewritten.

Deleting a reply leaves its thread intact. Deleting the only post removes only
that row. Comment counts always count rows, including replies but not reactions.

## Rich content and references

```json
{
  "version": 1,
  "doc": {
    "type": "doc",
    "content": [{
      "type": "paragraph",
      "content": [{ "type": "text", "text": "An update", "marks": [{ "type": "bold" }] }]
    }]
  }
}
```

Allowed blocks: paragraphs, headings 1–3, ordered/bullet lists, list items and
quotes. Inline content: text, hard breaks, board mentions and attachment-backed
images. Marks: bold, italic, underline, strike and safe links. Code, embeds,
HTML nodes, scripts and arbitrary attributes are not persisted.

The server derives `content` from the validated document; this projection powers
search and inbox previews. A `mention` stores `{id,label}` and must match a current
board identity. `commentImage` stores only `{attachmentId}`. Creating a post
requires the actor's uploaded image on this task; edits can also retain existing
linked images. Removing a reference never deletes the attachment, storage object
or cover. Image-only posts are valid; empty formatting alone is not.

Links permit absolute HTTP, HTTPS and mailto URLs, not script/data protocols,
credentials or control characters. Rendering uses React elements, not stored HTML.
Payloads are bounded to 20,000 projected characters, 100,000 JSON characters,
3,000 nodes, depth 20, ten images and fifty distinct mentions.

## Code paths and frontend

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/projects/cards/:cardId` | Task plus complete discussion |
| GET | `/api/projects/cards/:cardId/comments` | Same discussion snapshot |
| POST | same comments endpoint | Create root or reply |
| PATCH | same comments endpoint | Author edit |
| DELETE | same comments endpoint | Author delete, promoting if needed |
| PUT | same comments endpoint | Explicitly set one emoji or remove with null |

```text
Session + board membership + Sales-linked guard
  → normalize rich document, derive projection and mentions
    → service-only transaction locks task, board and membership
      → mutate and increment discussion_version
        → complete ordered snapshot with viewer permissions and reactions
          → cancel stale reads, publish snapshot/counts, refresh search/inbox
```

POST takes `content`, optional `richContent`, `attachmentIds`,
`mentionIdentityIds`, `requestId` and `replyToCommentId`. Rich posts, image posts
and replies require a UUID request ID. PATCH takes `commentId`, content and image
fields. DELETE takes `commentId`. PUT takes `commentId` and `emoji` (or null).
Actor IDs always come from the session, never the body.

The composer isolates drafts by task, operation and target. Uploads use the
existing attachment flow and are reusable on retry. Save failures keep the draft.
The thread view offers promotion-aware confirmation and separate inline emoji
insertion versus posted reactions. Existing task-field drafts are unaffected.

Snapshots contain `discussionVersion`; lower-version responses cannot overwrite
newer confirmed discussions. Counts are published into task detail and board
summaries. Search and existing board/main inbox caches are invalidated after
confirmed writes. The existing card-update realtime signal refreshes open details;
no browser subscription or grant is added to the reaction table.

## Database tables

| Table | Added fields / purpose |
|---|---|
| `project_card` | `discussion_version bigint`, monotonic snapshot revision |
| `project_card_comment` | `parent_comment_id uuid`, root FK; `reply_to_comment_id uuid`, optional target FK; `rich_content jsonb`, nullable legacy distinction; existing `edited_at` retained |
| `project_comment_reaction` | `comment_id uuid`, `identity_id uuid`, `emoji text`; composite primary key permits one reaction per identity/post |
| `project_comment_request` | Task/actor/request composite key, immutable `payload jsonb`, nullable `comment_id`; deleted requests remain tombstoned |
| `project_comment_image` | Existing attachment links, deleted only with their own comment/reference |
| `project_mention_inbox` | Existing transactional mention rows; deletion cascades only for deleted comments |

Tenant identity keys remain compatible with varchar identity storage via explicit
UUID-to-text comparison. Reactions and submission evidence have RLS enabled with
no anonymous/authenticated access. The mutation/read RPCs are service-role-only.

## Safeguards and error handling

- The task row is the shared write lock, including compatibility wrappers for old
  mention/image RPC signatures. Board and membership locks revalidate current
  write permission inside the transaction.
- Single-level parent guards reject cycles, cross-task parents and nested storage.
- Request evidence binds initial text, rich document, images, mentions and exact
  reply target; retries cannot substitute a target after promotion or editing.
- Deleted submission IDs return conflict rather than recreating a comment.
- Explicit set/remove reactions are retry-idempotent; changing emoji replaces the
  prior value without adding rows, comment activity or notifications.
- Edits refresh retained mention previews and remove no-longer-mentioned rows but
  never create new mention delivery.
- Expected validation, access, missing-target and conflict errors return
  400/403/404/409. Other failures are explicit; a failed read never becomes an
  apparently empty discussion.

## Rollout requirements

**DEST installation completed on 2026-11-24 with explicit owner approval.**
The focused source migration was installed through the managed connection as
deployment version `20261124170540`. See
[schema rollout evidence](../docs/project-discussions-schema-rollout.md) for
the source hash, PITR confirmation, rollback rehearsal and read-only verification.
Do not replay it. Customer actions and application deployment were not performed;
the exact originally reported board request remains uncaptured.

For any separately approved future environment, the installation requirements are:

1. Back up the destination schema and inspect installed migration contracts.
2. Confirm the existing project management tables, mention inbox migration
   `202610090002`, identity correction `202610090004`, and comment images
   `202701250001` are installed. Do not replay historical migrations.
3. Review and separately approve the single focused discussion migration.
4. Apply only `supabase/migrations/202701260001_project_discussions.sql` against
   the explicitly approved destination using the established migration process.
   It is transactional and deliberately not an automatic startup operation.
5. Deploy application readers/writers only with that schema available. New code
   fails explicitly against missing RPCs; there is no downgrade that silently
   drops reply relationships or rich content.
6. Verify service grants/RLS, representative legacy rows and complete reads in a
   non-customer fixture first. Production smoke checks require separate approval.

There are no new configuration options, providers, email subscriptions or secrets.
The existing private upload and explicit mention systems remain authoritative.

## Verification and troubleshooting

Run isolated database/API/content/cache tests:

```sh
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test --test-concurrency=1 \
  api/_lib/projectDiscussion.postgres.test.mjs \
  api/_lib/projectDiscussionContent.test.mjs \
  api/_lib/projectDiscussionReads.test.mjs \
  api/_lib/projectCommentImagesApi.test.mjs \
  api/_lib/projectBoardSearch.test.mjs \
  client/src/lib/projectBoardCache.test.mjs
```

Browser lifecycle coverage runs against an isolated component server with every
API request intercepted:

```sh
node --test tests/project-discussions.browser.test.mjs
node --test tests/project-card-modal.browser.test.mjs
```

The database test creates a temporary UNIX-socket cluster, applies only fixture
prerequisites, tests real competing transactions, and removes the cluster. It
does not use configured customer database URLs or provider sends.

### Missing discussion function
**Symptom:** Task details fail after a code rollout.  
**Cause:** The separately approved migration has not been installed.  
**Fix:** Confirm the destination and approvals, then install only the focused
migration. Do not bypass the new API or flatten stored threads.

### Reply target disappeared
**Symptom:** A saved draft cannot submit after another author deletes its target.  
**Cause:** The target was deleted before the create transaction acquired its lock.  
**Fix:** Keep the draft and explicitly select a surviving reply target; use a new
submission ID for the changed target. Do not silently attach it elsewhere.

### Image attachment removed
**Symptom:** A historical reference displays an unavailable-image message.  
**Cause:** Its task attachment was explicitly removed through the attachment flow.  
**Fix:** Reattach through the existing authorized upload path if appropriate;
never substitute an external or stale signed URL into the rich document.
