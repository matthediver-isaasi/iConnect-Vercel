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

“Has survey responder” is a display-only existence indicator, independent of
both optional row filters and the total linked-member count.

**Why:** The requested department report must retain departments with no
organisation or members, and count every eligible linked member, not only
designated responders. A failed or incomplete traversal is unknown, not False.

**How to apply:** Keep indicator predicates out of row-selection and count
calculations. Preserve explicit failure at traversal safety limits; increasing
capacity must not introduce truncated negative answers or change saved versions.

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

Responder identity columns must preserve blank slots and repeated names, sorted
by matching endpoint identity rather than field value.

**Why:** Independently deduplicating or dropping empty first/last/email values
misassociates people across columns. Responder selection is column-local and must
not narrow the independent count of all eligible Department members.

**How to apply:** Use identical row-relative paths and final-edge designation
conditions for each identity column; retain legacy joins on their old semantics.

Custom Object report sharing must keep permission to view a report separate
from permission to download its CSV.

**Why:** The user requested password-protected links for people outside the
system, with a separate choice of whether the linked report permits CSV downloads.

**How to apply:** A valid password or view link must not implicitly authorize an
export. Preserve saved multi-column sorting in both the displayed result and any
explicitly permitted CSV download.

Internal saved-report access is granted separately for each report and role;
it uses normal sign-in, not the external-sharing password.

**Why:** The owner confirmed external sharing works and approved per-report
internal roles so report links can be used in navigation without exposing the
Data Studio builder or wider CRM. This applies to both website navigation and
the portal menu; report View access must not require a separate builder grant.

**How to apply:** Keep internal and external sharing independent. Treat navigation
visibility as presentation only; direct reads, paging and exports need the same
server-side report authorization.

Viewer searches and field filters narrow the published report output only and
must also constrain any permitted CSV download.

**Why:** The owner requested search-as-you-type and field filters on both
internal and external report views. Allowing criteria against hidden source
fields would reveal information outside the report's approved projection.

**How to apply:** Keep viewer criteria separate from saved report definitions
and permissions. Search only displayed cells, preserve saved ordering, and
count/page the complete matching result rather than filtering one visible page.