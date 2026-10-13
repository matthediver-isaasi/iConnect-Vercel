# Department responder details

## Live read-only findings

Verified DEST (`lvmzliemqnieeoruhkik`) using pinned target validation,
provider CA and hostname verification, inside `BEGIN READ ONLY`.
No settings, relationships, designations or report definitions were written.

The saved **Department member count with survey responder** report:

- Is already V2, Department-root, grain `[]`, include_empty false.
- Projects Organisation name through direct relationship
  `30ad9dde-4b4e-4991-a7a4-8ef2b6b5138e`, source side.
- Includes Department name and Survey last updated.
- Counts Members → Member organisation assignments, **not Members**.
- Includes a boolean responder indicator, but no responder detail fields.

Of 325 active Departments, 2 have no active direct link to a same-tenant
Organisation. There are 76 Organisations with multiple linked Departments.
Repeated organisation cells are not suppressed by the renderer. Missing links
must be investigated separately, not guessed from member affiliations or repaired
automatically. These aggregates establish data/configuration facts, not a live
execution of the new application or proof about any particular reported cell.
The original saved report remains preserved in DEST.

## Proposed separate report (approval required to save in production)

Create a new report named **Department responder details**:

1. Starting entity: Department
   (`cd1ebfd3-3e16-4091-be5a-99992d926f2f`); one row per Department;
   grain path `[]`; version 2; no row filters.
2. Department name: ordinary field, path `[]`, field ID
   `35e4f2dd-6f22-4875-8d2f-4ffb05b1980f`.
3. Organisation: ordinary related field `name`, one source-side hop through
   `30ad9dde-4b4e-4991-a7a4-8ef2b6b5138e`.
   Set **Empty label** to `No linked Organisation`.
4. Optional Survey last updated: ordinary field, path `[]`, field ID
   `c5dcd16c-e63e-49f2-b72f-b0caaa7c5903`.
5. Related record count: **Members**, one source-side hop through
   `0fdede92-efa2-4d84-9b16-df1a88069486`. Stop here: do not continue
   to Member organisation assignments.
6. Add three **Related field · matching records only** columns on that same
   direct Members path: First name, Last name, Email. For **each** column,
   Edit matching conditions → relationship **Survey respondent** → Equals Yes.
   Relationship field ID: `edf1fbf8-76f7-4455-a7e2-f0f45db57b43`.
7. Preview and save as a separately named report only after approval.

Exact responder column contract (repeat with `last_name` and `email`):

```json
{
  "kind": "matching_field",
  "field": "first_name",
  "label": "Responder first name",
  "path": [{
    "relationship_definition_id": "0fdede92-efa2-4d84-9b16-df1a88069486",
    "from_side": "source"
  }],
  "conditions": [{
    "kind": "relationship_field",
    "relationship_field_id": "edf1fbf8-76f7-4455-a7e2-f0f45db57b43",
    "op": "equals",
    "value": true
  }]
}
```

## Generic contract and verification

`matching_field` is opt-in V2 only; its path starts from the row endpoint.
Conditions reuse the authorised row-filter/indicator contract, ANDed against
one endpoint/final-edge occurrence. It does not select rows or change counts.
At least one relationship hop is required. Invalid, inaccessible or malformed
conditions fail closed. Existing field joins and saved versions are unchanged.

Traversal is batched per path across row identities, with the existing paged
provider reads and explicit cell/page expansion failures. Eligible matching
endpoint IDs are deduplicated and sorted lexically, independently of field
content. Scalar blanks and repeated names remain in the semicolon-separated
sequence. Use identical paths/conditions across identity columns to align them.
Zero matches renders an empty string. No survey submission evidence is used.

Isolated backend and mounted-builder tests cover existing report compatibility,
shared-member designations, zero/multiple responders, blank/repeated names,
repeated Organisation values, missing links, deleted members, pagination,
complete export and save/reopen. These fixtures are not signed-in live UI tests.
The new application has not been publicly deployed and the production report
has not been overwritten.

**Migrations:** none needed, none applied to DEST, SOURCE or any other database,
and none outstanding for this change.
