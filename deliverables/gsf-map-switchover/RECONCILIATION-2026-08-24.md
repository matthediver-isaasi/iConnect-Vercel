# GSF map member reconciliation — 24 August 2026

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

## Why WordPress can retain divergent records

The iConnect payload builder emits one row per eligible organisation. Its current
identity fallback (`zoho_crm_id || organization.id`) yields 232 unique IDs, so no
API identity collision is present.

The WordPress sync has two independent retention gaps:

1. Upsert looks up only one post for a `zoho_id`
   (`posts_per_page => 1`). If duplicate posts already exist, one is updated and
   the other remains because both IDs are still current.
2. Stale/orphan cleanup does not set `post_status`, so WordPress defaults that
   cleanup query to published posts. Stale drafts are retained. Upsert also
   preserves an existing draft's status.

Those gaps explain how an older WordPress inventory can diverge, but the current
public inventory contains neither published duplicates nor published stale
rows. The all-status WP-CLI report is required to classify any retained drafts
or trash rows.

## Safe next action

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

3. Run a normal WordPress manual sync only if the exact endpoint/export ID-set
   gate passes **and** the WP-CLI report confirms the expected 22 IDs are absent
   from both `publish` and `draft`, with no duplicate/conflicting statuses.
   Wait out the documented five-minute CDN cache first. If an ID already exists
   as a draft, review that draft rather than expecting the upsert to publish it.
   If it exists only as trash/private/pending/future, resolve that post
   deliberately before sync because the current upsert will create another
   published post.

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
