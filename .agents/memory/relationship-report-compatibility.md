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

Treat a relationship designation as evidence on the final relationship occurrence, not on the shared endpoint record.

**Why:** The Department survey-responder designation describes the Department–Member link; a shared Member can be designated for one Department but not another. It is not survey-submission evidence.

**How to apply:** Combine a related-record filter's conditions against one endpoint and final edge together. None-match includes empty parents; never combine independently matching siblings or infer a submission from a designation.

The user says deleted members are rarely wanted on reports. The approved change
is to exclude them from Department members and Organisation department summary,
including member counts, while retaining historical relationship records.

**Why:** Deleted members were appearing as report rows and inflating Department
member counts. The user explicitly scoped this change to the two Department reports.

**How to apply:** Preserve this exclusion when changing these reports. Do not
interpret the preference as permission to rewrite every existing report or
delete historical relationships; wider default changes need separate scope.

Batching report projections must retain each traversal's original root and
paginate the combined relationship result.

**Why:** Per-Department related-organisation requests made a 50-row report need
98 database calls. Combining them without root provenance mixes shared member
occurrences; combining them without paging can newly hit the provider row cap.

**How to apply:** Cache only within the current execution, partition traversals
by root, preserve each grain's root order, and test multi-root fanout beyond
one provider page alongside sibling isolation.