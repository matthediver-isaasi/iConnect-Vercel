# Organisation name corruption investigation

## Conclusion

The available evidence points to a **subsequent overwrite**, not the original application's name answer being wrong.

The specified original submission saved `Testing Uni` in a plain text Organisation field. A second submission, made the next morning to a different form, saved this organisation's UUID in another plain text Organisation field. That second form maps the field directly to `organization.name`, with no transformation. Its processing interval contains the organisation's latest update timestamp. An isolated test of the current processor reproduces precisely this overwrite, including the applicant-continuation authorization used by the second submission.

**Confidence boundary:** the stored UUID answer, mapping, association, processing timestamps and grant are confirmed; the current-code overwrite is reproduced. There is no retained before/after name audit in the inspected records, submission-time form snapshot, or verified historical deployment build. Therefore the historical UPDATE payload and the original inserted name cannot be independently proved. Nor can we establish how the second form's text answer first became a UUID. Do not describe the dropdown-ID bug hypothesis as the proven cause.

## Read-only evidence

Inspection date: 2026-09-24. All queries were SELECTs through Supabase against the documented production destination `lvmzliemqnieeoruhkik`. No production writes, configuration changes, schema changes, submissions, workflow executions or provider calls were made.

The original form, original submission and organisation were joined by their exact IDs before inspecting answers; all belong to tenant `fd82da65-aab7-4a5c-85b8-b2febeb2003d`. The directly related second form, submission and grant were also filtered to this tenant. Unrelated personal answers are deliberately omitted.

| Evidence | Observed value |
| --- | --- |
| Original form | `aab59808-5522-48e1-b644-03d0b2fb0f77` |
| Original submission | `63bc1f53-3635-4c53-8f13-a26768fa51fe` |
| Original submission created | 2026-09-23 19:52:31.321 UTC |
| Original name answer | `field_1765442024867 = "Testing Uni"` |
| Original field/current mapping | `type: text`; mapping `mapping_1765477399254`, source above → organisation core `name`, transformation `none` |
| Original primary pipeline | `org_primary_1765926589816`, primary, uniqueness key `name`; organisation action `create` |
| Organisation | `5f985e4c-3708-4840-bed7-2a9655de0d96` |
| Organisation created | 2026-09-23 19:52:35.993 UTC |
| Original pipeline link recorded | 2026-09-23 19:52:38.726315 UTC |
| Original processing completed | 2026-09-23 19:52:38.910 UTC |
| Second form | `57b94fc2-359d-434c-acd6-794865797ade` |
| Second submission | `9dcefe7a-5d2f-4d98-bcf7-ada08b55fcee` |
| Second submission created | 2026-09-24 09:13:57.419 UTC |
| Second name answer | `field_1765610636257 = "5f985e4c-3708-4840-bed7-2a9655de0d96"` |
| Second field/current configuration | `type: text`, label Organisation, `locked: true`, `prefill_field: org:name` |
| Second primary organisation mapping | `mapping_1765927645960`, source above → organisation core `name`, transformation `none`, pipeline `org_primary_1765927484259` |
| Second organisation action | `update`; prefill source `organization` |
| Second grant | Same tenant, organisation, second form and second submission; issued 2026-09-23 19:57:53.341489 UTC, bound 2026-09-24 09:13:57.605788 UTC, expires 2026-10-23 19:57:53.275 UTC, not revoked |
| Organisation latest update | 2026-09-24 09:14:02.203061 UTC |
| Second processing completed | 2026-09-24 09:14:04.651 UTC |
| Current organisation name | Its own UUID |

Both submissions record this organisation as `organization_id` and `created_organization_id`. The latter is not proof of creation: the processor uses this output slot for resolved existing organisations too.

### Other scoped records

- Original `processing_notes` is null; second submission notes are also null.
- Original submission has one organisation pipeline-entity link and no entity-creation provenance rows or structured-action ledger rows. Empty provenance is not evidence that creation did not happen; it is not a universal insert journal.
- Both current forms have empty structured-action lists.
- Neither saved submission has a Not-listed companion entry for these names; both sources are text, not organisation dropdowns.
- Current visibility rules do not assign the Organisation field in either form. The first form copies postcode/country answers; the second copies contact/finance answers.
- The only inspected workflow log for the organisation/original submission is a successful `send_email` at 2026-09-23 19:57:54.294824 UTC. It has no before/after row snapshot and no name-changing action.
- No directly scoped Zoho sync log or Custom Object audit event was found for this organisation.
- Searching submissions linked through `organization_id` or `created_organization_id` returned the two submissions above.
- Schema discovery found no general organisation row-history audit or normal form-version table. These observations do not rule out uninspected infrastructure logs, deleted history or another concurrent writer.

## Current-code sequence and protections

References are to the checked-out source, not proof of the deployed build on either date.

1. `api/forms/process-application.js:1125,1188` derives effective answers from the persisted submission. Applicant continuation sets target/authorization separately at `1268–1290`; it does not replace the text answer with the grant's UUID.
2. Pipeline-over-legacy precedence at `2319–2362` prevents the original duplicate top-level name mapping from automatically being a second writer.
3. The primary organisation pipeline is mapped at `3057–3080`. Its plain-text core assignment is at `2837–2859`; `assignOrganizationCore` at `2103–2108` assigns the supplied value. Transformation `none` leaves the UUID unchanged.
4. The dropdown protection uses the **source field type**, not the shape of the answer. `shared/formNotListedChoice.js:117–135` only treats `organisation_dropdown` values as record references; `api/_lib/formPrimaryOrganizationPipeline.js:34–46` normalizes target aliases before calling it. A text field returns no dropdown resolution and follows ordinary name assignment.
5. The target is resolved separately using the trusted prefill or persisted organisation association (`process-application.js:3116–3157`; `api/_lib/formOrgResolution.js:36–67`). In the second submission, the continuation grant establishes this exact organisation as the authorized target.
6. For update/upsert, `process-application.js:3170–3237` includes changed `name`, checks authorization and applies a tenant-scoped UPDATE. The UUID differs from a correct name, so the no-op filter does not prevent corruption. Creation instead inserts `orgData.name` at `3346–3379`.
7. The second form also maps the same text field into member `organization_id` (`mapping_1771503256407`). This is a conflicting label/reference use of one field, but the processor consumes it; it does not convert the shared answer into an ID. It is not evidence of a server-side answer rewrite.

`shared/formMutationContract.js:64–97` classifies reference/mutation authority, not semantic name validity. A valid continuation grant makes the UPDATE authorized; it does not make a UUID a valid organisation name.

### Where did the second saved UUID originate?

Not established. Normal current `FormView.jsx:1131–1191` assigns UUIDs to organisation dropdowns, but `org:name` on a text field reads the organisation name. Draft restoration (`1038–1055`) can preserve a previously saved value; normal entity prefill (`1194–1206`) does not replace nonblank values. Conditional copying (`2056–2256`) can overwrite fields, but no current rule targets this Organisation field.

The public submission endpoint passes submitted answers separately from grant-controlled target metadata (`api/public/form-submission.js:128–130,243–250`; `api/_lib/publicFormProcessingPayload.js:10–25`). No demonstrated grant-to-text-answer rewrite was found.

Possible historical configuration, an already-corrupted prefill source, a restored draft, or a different deployed implementation remain possibilities, **not findings**. Required evidence to distinguish them: the request/draft's value before submission, the historical form configuration, the deployed build identifier, and a name before/after audit or historical request logs around the two processing windows. Do not replay the live submission to obtain this evidence.

### Prior fixes

Git history includes `3caa1bffd` (runtime organisation name resolution), `6496fe215` (safe public organisation selection), `f4ea6b6db` (no-op prefill writes), and `8fb2bb2b2` (mutation authorization/validation). These explain the existing dropdown and authorization protections but do not validate UUID-valued text names. Their presence in source does not establish rollout timing.

## Isolated reproduction

`api/forms/organizationNameIncident.characterization.test.mjs` uses synthetic IDs, synthetic names, in-memory Supabase mocks and stubbed workflow/notification/payment dependencies:

- A text name with organisation action `create` inserts the expected text.
- A separate, continuation-authorized submission with a persisted UUID text answer and action `update` writes that UUID into the existing organisation's name.
- A dropdown-source control with the same UUID does not write the name.

This is a characterization of the current faulty path, not an application fix and not a historical replay. The original insert fixture uses administrative authorization for isolation, not a claim about historical authentication. The later fixture uses a synthetic, valid submission-bound continuation grant. Unrelated form mappings are intentionally omitted.

Run: `node scripts/run-isolated-tests.mjs node --test api/forms/organizationNameIncident.characterization.test.mjs`

The imported harness also registers its existing tests; the run contains 61 tests, including these three.

## Smallest preventive change — recommendation only

Add a name-specific semantic guard at the resolved organisation write boundary: reject a proposed name equal to the resolved organisation's own ID before UPDATE, regardless of source field type. Return an explicit validation error and safe diagnostic rather than silently accepting or dropping the rename. Apply equivalent protection to create paths where the ID is preallocated. This is narrower than banning every UUID-shaped legitimate name or weakening mutation authorization.

Convert the overwrite characterization into a rejection regression when implementing the fix. Retain tests for ordinary text names, legitimate renames, listed dropdown selection, Not-listed creation, and continuation-authorized updates. Review the second form's shared name/member-ID mapping separately: use distinct label and reference sources or explicit resolved organisation output; never change the text name field into an ID source as a workaround.

This bounds recurrence of the observed own-ID corruption. It does not explain or fix an as-yet-unproven browser/draft origin. **No database migration is needed for this guard.**

## Single-record repair — separate approval required

Propose restoring only organisation `5f985e4c-3708-4840-bed7-2a9655de0d96` to `Testing Uni`, supported by the original saved answer. Before applying:

1. Obtain approval for the exact name and row; deploy the preventive guard or otherwise prevent the known later mapping from repeating the corruption.
2. In a destination-only transaction, recheck tenant, ID, current name equal to that ID, and the freshly reviewed `updated_at`; confirm the original submission/form/tenant association and saved intended name still match this report.
3. Inspect enabled DB triggers before choosing the repair mechanism, to avoid unintended side effects. Preserve a minimal authorized before/after audit.
4. Perform a compare-and-set update of **name only**, requiring exactly one affected row and aborting on drift. Do not edit submissions, grants, members, mappings or relationships, replay processing, send notifications, or manually dispatch workflows/payments.
5. Read the row back and confirm no other business fields changed (normal update timestamp behavior may apply).

**No repair was executed. No migrations were needed or applied to DEST, SOURCE or any other database. Neither the proposed code guard nor the single-row data correction requires a schema migration.**