---
name: Recipient history evidence boundaries
description: Sender freezes and aggregate checksums cannot establish field-level preservation during metadata migrations.
---

Treat outbound sender coordination separately from recipient-history writers.
Keep pre-change before-images or independently recoverable snapshots when a
metadata migration promises to preserve history; aggregate checksums alone can
detect drift but cannot identify or restore changed values.

**Why:** A provenance-only backfill fired an existing delivery guard while
provider event records continued to arrive around the rollout. The baseline
retained only checksums, leaving exact field changes unresolved despite retained
row counts and current values consistent with the guard.

**How to apply:** Review all UPDATE triggers before metadata backfills, and
account separately for webhook, synchronization and click writers. A trigger
assignment count is not a changed-value count; `xmin` is not a timestamp or an
old row. Retain exact checksum SQL and snapshot times. Do not derive repairs
from current delivery outcomes or from unverified/email-only event matches.
Require independently reviewed before/after evidence and explicit approval for
repairs; never replay a backfill to investigate it.
