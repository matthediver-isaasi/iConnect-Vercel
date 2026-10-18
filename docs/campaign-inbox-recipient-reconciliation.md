# Campaign inbox recipient-history reconciliation

## Decision

Read-only investigation of DEST `lvmzliemqnieeoruhkik`, captured on
2026-10-18 between 15:54:54 and 15:57:48 UTC.

**Exact changed rows, changed fields and their previous values remain unresolved.**
The accessible evidence establishes trigger exposure and subsequent recipient
writes, not an exact migration diff. Do not treat a current value consistent with
the delivery guard as proof that the value was different before migration.

The original rollout exception remains open; sending must remain frozen.
No repair is proposed for execution. Any repair requires independently reviewed
row/field evidence and explicit approval. No database migrations were needed or
applied in this investigation. The previously applied
`20261018_campaign_inbox_delivery_mode.sql` remains committed on DEST; it is not
pending and must not be replayed as a repair. SOURCE was neither queried nor changed.

## Evidence boundary and collection

- Destination identity was pinned using the existing destination-target helper.
  SQL used the existing DEST connection with verified Supabase CA and hostname,
  `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, local statement/lock
  timeouts, and `ROLLBACK`. Each capture is a separate snapshot.
- No sender, event synchronizer, webhook, backup-run or restore endpoint was
  invoked. Provider calls were GET-only. No triggers, campaigns, schedules,
  recipient records or credentials were changed.
- Original rollout observations/checksums were retained. New captures were
  written with exclusive creation (`wx`), rather than replacing older evidence.
- Working evidence is in the already Git/deployment-ignored directory
  `generated-artifacts/campaign-inbox-reconciliation/`. Row identifiers and
  hashed address/message identities remain there, not in this report.
  These ignored local files are **not** a durable off-workspace evidence archive;
  retain them in approved private evidence storage before discarding the workspace.
- A reproducible, read-only query reference is provided in
  [queries/campaign-inbox-recipient-reconciliation.sql](queries/campaign-inbox-recipient-reconciliation.sql).
  Re-executing it produces a new observation, not the historical snapshot.

## What is proven

### 1. The original preservation check failed

The recorded recipient checksum excluding only `delivery_is_test` changed from
`447ee1d2d8af56558d75dc4982a88fe0` to
`c13de4aca453c9caac49e82109814c3f`.
The rollout record says full-row campaign and inbox-state fingerprints matched
the immediate baseline and all counts were retained at 15:47:48 UTC.

These are recorded observations, not newly reconstructed before-images. Neither
the exact checksum SQL/serialization nor an exact immediate-baseline timestamp
is in the inspected rollout record. The earlier 15:19:48 baseline is explicitly
a different, pre-freeze observation. Do not substitute it for the immediate
pre-apply snapshot.

Fresh counts at 15:55:25 UTC:

| Relation / property | Count |
| --- | ---: |
| Campaigns | 145 |
| Recipients | 219,580 |
| Inbox-state rows | 1,404 |
| Non-NULL recipient provider identifiers | 217,858 |
| Non-NULL recipient sent timestamps | 217,858 |
| Test / live / unclassified | 15,732 / 202,132 / 1,716 |
| Sending / preparing / scheduled campaigns | 0 / 0 / 0 |

Retained counts do not prove that individual values or identities were preserved.
Zero active campaign statuses do not independently verify an infrastructure freeze.

### 2. Actual trigger exposure is identifiable, changed-value counts are not

Live catalog definitions confirm the migration's UPDATE fires
`guard_email_delivery_status` on every updated recipient. The other recipient
triggers are the immutable-mode guard and `guard_iconnect_click_counts`.
The click guard assigns OLD click count/time back to NEW for a top-level UPDATE;
the backfill does not request changes to those fields.

The inbox view's catalog row and 217,863 current recipient versions have
`xmin = 28592758`. This links those versions to the transaction that installed
the view. PostgreSQL commit timestamp tracking is off: `xmin` identifies the
creating transaction, not a wall-clock timestamp or a previous value.

Of these 217,863 recipient versions, 149,984 have a delivery outcome:

| Guard branch | Rows reaching assignments | Fields assigned |
| --- | ---: | --- |
| Delivered | 146,497 | `status`, `delivered_at`, `bounced_at`, `error_message` |
| Hard bounce | 3,324 | `status`, `bounced_at`, `error_message` |
| Delivery failed | 156 | `status`, `bounced_at`, `error_message` |
| Soft bounce | 0 | `status`, `bounced_at`, `error_message` |
| Unsubscribed, early return | 7 | No delivery-branch assignment |

Thus **149,977** retained migration versions reached a delivery assignment branch.
These assignments may have written the same values already present. They are
not 149,977 proven changes. The remaining 67,879 versions have no delivery
outcome and do not enter an outcome assignment branch.

All classified rows currently satisfy the applicable guard output, excluding
the explicit complained/unsubscribed/cancelled early-return states. This proves
current consistency, not preservation or correctness of historical evidence.

One additional classified recipient has `xmin = 28593638`, rather than the
migration transaction; its exact ID is retained in `timeline-result.json` under
`classified_nonmigration_rows`. A stored open event for that same recipient,
with matching message/address/campaign/tenant, has event time 15:55:15.311 UTC,
ingestion time 15:55:16.154 UTC and event `xmin = 28593636`. This is evidence of a
later recipient version and a closely associated event, not proof of which
values the later UPDATE changed. Its observed status is unsubscribed and open
count is 2; neither value should be reversed or inferred backwards.

### 3. Event writes were not quiescent throughout the broader rollout

Stored `email_event` rows in the fixed 15:00–15:56 UTC interval:

| Ingestion time (UTC) | Stored event | Recipient correlation |
| --- | --- | --- |
| 15:19:30.022 | Open | Message/address/campaign/tenant match |
| 15:24:09.302 | Open | Match |
| 15:24:23.423 | Open | Match |
| 15:27:48.037 | Open | Match |
| 15:28:08.847 | Open | Match; same recipient as 15:24:09 |
| 15:32:57.020 | Delivered | Address/campaign/tenant match, **message differs** |
| 15:33:04.584 | Open | Same mismatched message/recipient pair |
| 15:33:07.064 | Click | No linked recipient or campaign |
| 15:33:46.100 | Click | No linked recipient or campaign |
| 15:55:16.154 | Open | Match; later recipient version described above |

All ten stored rows have provider event IDs, but their retained
`_iconnect_verified_provider` marker is `false`. They establish database event
records, **not independently authenticated provider events**. Independent
Mailgun verification was unsuccessful (see access limits below).

No retained `email_event` ingestion timestamps occur between 15:33:46.100 and
the documented 15:47:48 verification endpoint. This does not exclude direct
recipient updates, delayed ingestion, sync writes, failed/missing logging or
transactions committing later than their creation timestamp. Without the exact
immediate-baseline/migration window, the earlier events cannot be attributed to
the interval between the two original checksums.

The delivered event with the mismatched message cannot pass the live
`record_email_delivery_event` trigger's message-identity check. Do not use it as
authoritative delivery-outcome evidence for that recipient. Application webhook
code also has an email-only fallback and separate recipient updates, so this
does not prove no application-level update occurred. No provider sync was run
to “fill in” the evidence.

There are zero `email_counted_link_click` rows in this fixed interval. This
does not prove all possible writers were stopped or establish historical click
values. Provider click evidence and counted iConnect requests remain distinct.

## Backup, audit and provider evidence availability

| Source examined | Result | Limitation / required next evidence |
| --- | --- | --- |
| Immediate baseline | Checksums and counts in rollout notes | No recoverable recipient before-images |
| Workspace backup/export discovery | No matching recipient snapshot located among inspected backup/dump/recipient/campaign exports | Not proof that an external backup does not exist |
| Live recipient triggers and catalog audit/history table discovery | No recipient before-image audit trigger or general recipient history table found | Application/out-of-band logs may exist elsewhere |
| PostgreSQL settings | `log_statement=ddl`, `pgaudit.log=none`, `track_commit_timestamp=off` | No row-before-image source established; current settings do not prove historical settings |
| R2 database backups | Existing runner writes `database-dumps/<stamp>/public.email_campaign_recipient.csv.gz` and `_manifest.json`; runtime R2 client and bucket are unconfigured here | Cannot list/download backups; obtain existing object and metadata through approved private access, not a new backup run |
| Supabase SQL/log integration | Permission denied for read-only SQL and bounded log requests | SQL investigation succeeded through existing pinned DEST connection; provider log/PITR inventory remains unavailable |
| Mailgun Events API | GETs for all three campaign tenant domains, 15:00–15:56 UTC, returned HTTP 401 | Unavailable evidence, **not empty results**; obtain authorized read-only access or a trusted export |

The R2 runner copies tables separately and can resume across invocations. A
run folder timestamp alone therefore does not establish the recipient table's
snapshot time or cross-table consistency. A recovered file needs object
version/hash, actual capture timing, completeness and source-project evidence.
Do not trigger backups that could replace cursor/manifest evidence. Do not
restore anything into DEST or SOURCE.

## Preserved post-migration evidence

The 15:57:48 UTC row manifest contains **219,580 distinct recipient IDs**, selected
in ID order. It records current status/timestamps/counts, row transaction,
delivery mode/outcome, hashes of error/reason text, and an MD5 of every complete
legacy row excluding only `delivery_is_test`. No plaintext addresses, names or
provider message IDs are exported in this manifest.

Its canonical aggregate is `f821b25e900b03c8736a4c3ab58d92ef`:
MD5 of concatenated, ID-ordered per-row MD5s of
`(to_jsonb(r) - 'delivery_is_test')::text`, without a separator.
The same canonical aggregate was observed at 15:55:25 UTC. **Do not compare this
to the original fingerprint without recovering the original algorithm.**
This is a later post-migration manifest, not a substitute for a before-image;
hashed error/reason values cannot reconstruct plaintext.

SHA-256 file identities for the private working captures:

| File | SHA-256 |
| --- | --- |
| `discovery-result.json` | `7aa3049fa7e415072eeb7d551f74939cd4d71604f3420fbf3cfe7b2013a9f6d9` |
| `state-result.json` | `96e9782a1155519320b09c5aded8c44924edac4ecce6f91d7c310589d3bc2a4a` |
| `timeline-result.json` | `80f3e90f740489e90cf3c744620827140ca8b8ba9f2406eb4ec188d7454c9328` |
| `provider-match-result.json` | `52a7648a1b7b058b6ac5a83ddfeb3755a2c0b69a04f4073aebb781c8ca9c666a` |
| `provider-result.json` | `a81201859524c04a39f08001f97ebdd91ea83a76b002cfb7947793fac10ce01d` |
| `row-manifest-result.json` | `0968825a39b0bcbfda3b439ba26977a6ad4f2d0ed91b172d1ae9564c7c7e9df2` |

## Required evidence before a repair decision

1. Retain existing evidence privately. Obtain a verified pre-migration recipient
   backup/audit snapshot, plus the exact baseline checksum query, timezone,
   capture time and migration transaction timing. If only an older backup
   exists, reconstruct intervening legitimate updates from complete evidence;
   an older backup is not automatically the correct restoration state.
2. Compare IDs and every legacy field, excluding only the new provenance field.
   Classify each difference as proven migration assignment, proven independent
   update, or unresolved. Correlate provider ID, message, recipient, campaign,
   tenant and event/ingestion times; email-only matches are insufficient.
3. Obtain independent provider/log evidence for the actual critical interval.
   Account for webhook, sync, click and other recipient writers separately from
   outbound sender coordination. Current lack of logged events is not proof of
   absence.
4. Present a narrowly scoped, expected-current-value-guarded repair proposal only
   for proven erroneous changes, preserving later legitimate activity. Review
   trigger effects and rollback evidence separately; **do not disable triggers,
   rerun the backfill or guess old values**. Execution needs explicit approval.
5. If before-images cannot be recovered, explicitly retain the unresolved
   exception for operator decision. Do not claim reconciliation succeeded.
   Matching production/worker release and signed-in inbox checks remain required
   before a separately authorized sender resume.

No UI or runtime code was changed. This investigation does not verify signed-in
inbox rendering, deployed-code parity, provider authenticity or sender quiescence.
