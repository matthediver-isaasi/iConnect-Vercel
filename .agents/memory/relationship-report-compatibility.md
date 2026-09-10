---
name: Relationship report compatibility
description: Why inclusive reporting is opt-in and how to keep row-relative counts and scalable cursors correct.
---

Keep existing report definitions on their original semantics; new-report defaults must not be applied when loading saved definitions.

**Why:** Legacy entity-grain reports can collapse endpoints reached from several parents, whereas inclusive summaries preserve parent occurrences. Implicit upgrades change both row counts and meaning. Unknown saved versions need repair, not inferred defaults.

**How to apply:** Separate creation from saved-definition loading. Resolve aggregate paths from each actual row record, not by restarting from its Organisation or owning object. A missing-parent label replaces a missing endpoint only, never a real record's blank field.

Use native root/edge ordering and indexed prefix seeks for durable occurrence cursors, and load related counts set-wise.

**Why:** A LIMIT on concatenated occurrence strings can still sort the entire graph on every page. One count request per row can exhaust serverless time even when row paging is bounded. Nullable left-join branches also need a final strict cursor check so a filtered-out child does not become an invented empty row.

**How to apply:** Verify query plans with large fanout and a midpoint cursor, not just first-page timing. Test empty intermediates and cursor exhaustion alongside ordinary rows.