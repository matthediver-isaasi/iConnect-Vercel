# GSF map member reconciliation — 24–25 August 2026

> **25 August hardening update:** The 24 August investigation below is retained
> as the pre-fix finding. The distributable class now matches stable IDs across
> every registered WordPress status, chooses a published-first/lowest-ID
> canonical post, reports every extra match, and serializes fetch, cleanup, and
> upsert with an expiring, renewed, compare-and-swap token lease. The final section contains the
> required before/dry-run/apply/after procedure for the five reviewed pairs.

## Finding

The current iConnect selection code is **not emitting five extra records and is
not dropping five dashboard records**. At the time of this audit, the dashboard
population and the locally built iConnect feed both contain **232 records with
232 unique stable feed IDs**.

The reported WordPress total of 237 is no longer present on the public site.
WordPress currently exposes **210 published `gsf_member` posts**, all with unique
nonblank `zoho_id` values. Those 210 IDs are exactly the supplied legacy Zoho
snapshot; the current workspace iConnect set is that same 210 plus 22 newer
eligible organisations.

The historical arithmetic difference `237 - 232 = 5` therefore cannot safely be
described as five named records. It was a **net difference between inventories
captured at different sync states**. The current row-level difference is 22 feed
records missing from WordPress, not five unexpected API records. The 237-post
inventory was not supplied and is no longer publicly queryable, so naming five
records from it would be guesswork.

## Counts captured

Evidence captured at **2026-08-24 05:14–05:16 UTC**:

| Stage | Raw records | Unique stable IDs | Notes |
| --- | ---: | ---: | --- |
| “Total GSF Members” dashboard population | 232 | 232 | `org_status=Active`; all 232 currently have nonblank `org_type` and are ESO/SO |
| Authenticated local iConnect members endpoint | 232 | 232 | No blank IDs and no duplicate IDs; independently reproduced by the builder against destination Supabase |
| WordPress public REST, published `gsf_member` posts | 210 | 210 | No blank IDs, duplicate IDs, or feed-stale IDs |
| Supplied legacy Zoho member snapshot | 210 | 210 | Exact ID match with current WordPress published posts |
| WordPress non-published statuses | Not publicly readable | Not publicly readable | Use the included WP-CLI diagnostic on the WordPress host |

The dashboard widget inspected was `Total GSF Members`
(`42bb5856-4982-4dd0-8995-21d55bf49e95`). It counts organisations filtered by
the GSF Status preference field (`077f1aa6-abdc-4bdc-a6ca-34b93c8726fd`) equal
to `Active`; its count measure references Organisation type
(`7af40750-1543-44e8-8022-0e0e27bc2c5c`) but does not add a type filter. All
232 current dashboard rows have a nonblank ESO/SO type. The map feed additionally rejects
sample rows and non-active core organisation rows and requires type `ESO` or
`SO`. On the capture date those checks remove no dashboard rows, so both sets
are identical.

The repeatable diagnostic reads that deployed `dashboard_widget` row by ID and
evaluates its current filters; it does not infer this total from
`seed-gsf-membership-widgets.mjs`. That seed creates three other ESO/SO-filtered
widgets and is not the definition of the existing “Total GSF Members” widget.
The diagnostic fails closed if the total widget changes to an unsupported
source, measure, field kind, or operator.

## The current row-level difference

These 22 records from the authenticated workspace endpoint have no published
WordPress post in the captured public inventory. Their draft and other-status
state is unverified until the WP-CLI inventory is run.

| Stable feed ID | Organisation |
| --- | --- |
| `815132000012356002` | Africa School Assistance Project |
| `815132000012549002` | Amis de l\`Afrique Francophone-Benin (AMAF-BENIN NGO) |
| `3e87c7da-d6d2-4662-82cc-3f38c4af60cf` | ANGLO-SAXON NURSERY AND PRIMARY SCHOOL OF INNOVATION, CREATIVITY AND ENTREPRENEURSHIP(CREATIVE PASSION) — feed currently uses the organisation UUID because Zoho ID is blank |
| `815132000012656008` | Azahir |
| `815132000012683019` | Camara Education |
| `815132000012679058` | Center for Communities Development Actions (CeCoDA) |
| `815132000012542002` | Community Centred Conservation - C3 Madagascar |
| `815132000012552001` | Elshaddai Ministries Trust |
| `815132000013012010` | Girl Move Academy |
| `815132000012569001` | Hope for Youth - Uganda |
| `815132000012565001` | iDreamCareer |
| `815132000012649009` | Kach-up Learning Hub |
| `815132000012552021` | Light Up Hope Africa |
| `815132000012672022` | Partnership for Change |
| `815132000012585001` | Plato Cultural |
| `815132000012578013` | Pratham Education Foundation |
| `815132000012358016` | Pratham International, Inc. |
| `815132000012647006` | Premier DLC (Beaconhouse Group) |
| `815132000012580001` | Safisha Africa Welfare Foundation |
| `815132000012645016` | Ssaku Senior Secondary School |
| `815132000012649019` | Teach the World Foundation |
| `815132000012387002` | The Kilgoris Project |

Relative to the authenticated workspace endpoint, there are no published
WordPress-only IDs and no duplicate published WordPress IDs. The one UUID
fallback is valid and unique today, but assigning a Zoho ID later will
intentionally change its feed identity and should be followed by a sync.

## Why the legacy WordPress sync retained divergent records

The iConnect payload builder emits one row per eligible organisation. Its current
identity fallback (`zoho_crm_id || organization.id`) yields 232 unique IDs, so no
API identity collision is present.

The pre-hardening WordPress sync had two independent retention gaps:

1. Upsert looks up only one post for a `zoho_id`
   (`posts_per_page => 1`). If duplicate posts already exist, one is updated and
   the other remains because both IDs are still current.
2. Stale/orphan cleanup does not set `post_status`, so WordPress defaults that
   cleanup query to published posts. Stale drafts are retained. Upsert also
   preserves an existing draft's status.

Those gaps explain how an older WordPress inventory can diverge, but the captured
public inventory contains neither published duplicates nor published stale
rows. The all-status WP-CLI report is required to classify any retained drafts
or trash rows.

## Hardened five-pair reconciliation procedure — 25 August 2026

The five reviewed stable identities are:

| Organisation | Stable feed ID |
| --- | --- |
| Abaarso Network | `815132000006866401` |
| Rangeet | `815132000006866292` |
| Sabre Education | `815132000006866295` |
| Learning Equality | `815132000006929885` |
| Plato Cultural | `815132000012585001` |

The cleanup tool is hard-limited to these IDs. Titles are used only to make the
inventory easy to review; cleanup identity is always the stable feed ID plus
exact WordPress post IDs.

### 1. Deploy the hardened class and capture the before report

Do not run a sync or cleanup before this inventory:

```bash
wp eval-file /path/to/wp-gsf-map-reconcile.php \
  > /tmp/gsf-wordpress-before-2026-08-25.json
```

For each named finding, review both post IDs, statuses, creation/modification
times, per-record `last_sync`, canonical selection, and the global
`wordpress.global_last_sync`. The report labels same-ID rows as confirmed
evidence and labels status/concurrency explanations as likely causes unless
request logs prove them.

Stop if any name has multiple stable IDs: matching by title is out of scope and
must never merge those records.

### 2. Build and review the exact-ID cleanup plan

```bash
jq '{
  source_generated_at: .generated_at,
  pairs: [
    .wordpress.named_duplicate_findings[]
    | select(.classification == "confirmed_duplicate")
    | .cleanup_plan_example
  ]
}' /tmp/gsf-wordpress-before-2026-08-25.json \
  > /tmp/gsf-reviewed-duplicate-plan.json

jq '.pairs | length' /tmp/gsf-reviewed-duplicate-plan.json
cat /tmp/gsf-reviewed-duplicate-plan.json
```

The count must be exactly five, each survivor must be the intended published
post, and every noncanonical ID must be one of the reviewed copies. The generated
action is `delete` because trash remains an all-status duplicate. Change an
action to `trash` only when archival retention is required and accept that the
strict final gate will remain false.

### 3. Run the mandatory dry run

```bash
wp eval-file /path/to/wp-gsf-map-cleanup.php \
  dry-run /tmp/gsf-reviewed-duplicate-plan.json \
  > /tmp/gsf-wordpress-cleanup-dry-run.json
```

Confirm `"applied": false`, no `error`, and the exact survivor/noncanonical rows
for all five pairs. The tool refuses changed identity sets, a noncanonical
survivor, a non-published survivor, unknown IDs, duplicate plan entries, or an
active sync lock.

### 4. Apply only the reviewed plan

```bash
wp eval-file /path/to/wp-gsf-map-cleanup.php \
  apply /tmp/gsf-reviewed-duplicate-plan.json \
  > /tmp/gsf-wordpress-cleanup-applied.json
```

This is the explicit destructive step. Keep the before report and dry-run output
as the archive of removed rows. The tool acquires the same lock as normal sync
and changes only the listed noncanonical post IDs.

### 5. Capture and verify the after report

```bash
wp eval-file /path/to/wp-gsf-map-reconcile.php \
  > /tmp/gsf-wordpress-after-2026-08-25.json

jq '.acceptance' /tmp/gsf-wordpress-after-2026-08-25.json
```

Every acceptance value, including
`strict_post_cleanup_reconciliation_passed`, must be `true`: feed 232 raw/232
unique, WordPress 232 published/232 unique, and zero duplicate, blank, stale,
orphan, or missing IDs.

Then compare the captured configured feed with iConnect/dashboard data:

```bash
node scripts/reconcile-gsf-map.mjs \
  --wordpress-inventory=/tmp/gsf-wordpress-after-2026-08-25.json \
  --format=markdown
```

If checking a separately deployed endpoint, also pass `--api-base` with
`GSF_MAP_API_SECRET` in the environment and require
`Endpoint exactly matches the WordPress-export feed IDs: YES`.

## Historical safe-action notes from 24 August

Do **not** change GSF eligibility rules and do not delete WordPress rows based on
the old 237 count.

1. On the WordPress host, run:

   ```bash
   wp eval-file /path/to/wp-gsf-map-reconcile.php \
     > /tmp/gsf-wordpress-inventory.json
   ```

   Review `counts_by_status`, `duplicate_feed_ids`,
   `duplicate_sync_match_feed_ids`, `orphan_posts`, `stale_posts`,
   `feed_ids_missing_from_published`, and `feed_ids_missing_from_sync_match`.
   This is read-only, captures every registered WordPress post status, and
   embeds the exact configured feed IDs used for that comparison.

2. Immediately before considering a sync, compare the authenticated
   **deployed** iConnect endpoint with the feed snapshot embedded by the WP-CLI
   export:

   ```bash
   GSF_MAP_API_SECRET=... node scripts/reconcile-gsf-map.mjs \
     --api-base=https://the-configured-iconnect-host \
     --wordpress-inventory=/tmp/gsf-wordpress-inventory.json \
     --format=markdown
   ```

   Continue only when the endpoint is 232 raw/232 unique with no blank or
   duplicate IDs **and** the output says
   `Endpoint exactly matches the WordPress-export feed IDs: YES`. Equal totals
   without exact ID-set equality are not sufficient. The Replit workspace has
   no active deployment metadata, so this audit could validate the current
   builder and authenticated workspace endpoint but could not independently
   authenticate to the externally configured production endpoint.

3. With the hardened class, a normal sync treats an ID in any registered status
   as existing and preserves that canonical post's status. Review non-published
   records deliberately; the sync will not silently publish them. A concurrent
   request now returns a clear busy result instead of entering the insertion
   window.

4. Re-run both diagnostics. A clean result is dashboard 232, API 232 raw/232
   unique, WordPress 232 published/232 unique, with zero duplicates, stale,
   orphan, and missing IDs. Review any draft/trash result before a site owner
   performs a targeted cleanup.

## Repeatable diagnostics

From this repository:

```bash
# Dashboard + current builder, read-only
node scripts/reconcile-gsf-map.mjs --format=markdown

# Add the public WordPress published inventory (does not invoke member-search
# AJAX and therefore does not trigger a sync)
node scripts/reconcile-gsf-map.mjs \
  --wordpress-url=https://www.globalschoolsforum.org \
  --format=markdown

# Compare an authenticated all-status WordPress export. The Node diagnostic
# consumes the configured feed snapshot embedded in the export, so both sides
# come from the same moment and source.
node scripts/reconcile-gsf-map.mjs \
  --wordpress-inventory=/tmp/gsf-wordpress-inventory.json \
  --include-records --format=markdown

# Compare the deployed endpoint; keep the secret in the environment
GSF_MAP_API_SECRET=... node scripts/reconcile-gsf-map.mjs \
  --api-base=https://the-configured-iconnect-host \
  --wordpress-inventory=/tmp/gsf-wordpress-inventory.json \
  --format=markdown
```

Use `--include-records` with JSON output to capture every canonical organisation
UUID, Zoho ID, emitted feed ID, core status, sample flag, GSF status, and
organisation type.
