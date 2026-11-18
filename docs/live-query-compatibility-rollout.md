# Live query compatibility and rollout boundary

## Read-only evidence

On 2026-11-18, catalog queries against the documented production DEST project
`lvmzliemqnieeoruhkik` confirmed:

| Query family | Live contract | Correction |
| --- | --- | --- |
| Resources | No `slug` or `created_at`; IDs, release dates and SEO fields exist | ID lookup and ID canonical links; unsupported slug-shaped paths return not found without SQL. Crawler resource lists use release-date ordering with ID tie-breaks. |
| File repository | No `updated_at` or `created_at` | PDF indexing selects actual identity fields, retaining dependency-generation checks and the second identity read. File listing APIs and their ID pagination are unchanged. |
| Attendance target | Neutral provider identity exists; Teams connection/organiser columns are absent | Probe Teams binding readiness before requesting Teams-only columns; do not fabricate a provider identity. |
| Complex event | Parent attendance policy exists, but no meeting-provider columns | Check meeting fields on event, complex-event session and agenda item, as declared in the Teams migration, never on the parent complex event. |

The Teams binding relation is absent. Meeting columns already exist on the
three meeting-owning tables; that alone is **not** proof that Teams attendance
is installed. The binding and target fields are declared together in
`supabase/migrations/20260830_teams_attendance.sql`. No resource-slug migration
was found. Adding a slug or fabricated timestamps would not repair the actual
contract.

Zero-row SQL reads of the corrected resource, file and neutral attendance
projections succeeded against DEST. No customer records were retrieved for
these checks and no database changes were made.

## Deployment prerequisites

These corrections are code-only and require **no database migration**.
Release the matching API code after merge through the existing deployment
process. This task branch did not deploy anything. SOURCE was untouched.

Teams remains unavailable with the existing setup warning until its complete
binding migration is separately reviewed and explicitly approved. Do not apply
that migration, unrelated pending migrations, or isolated column additions as
part of this rollout. Known missing-table/column probe results mean unavailable;
permission and infrastructure failures remain visible errors rather than
being disguised as missing migrations.

Resource targets retain the public API's locked-resource behavior. Group,
event-gated, future and category-restricted resources are excluded before
metadata/crawler projection. Slug-shaped resource requests cannot resolve:
there is no saved resource slug authority. Existing UUID routes and
`/Resources?resourceId=<id>` links remain canonical. No resource records or
visibility settings were changed.

Attendance snapshot writes and provider selection are unchanged.

## Verification

Run:

```sh
node --test api/_lib/liveQueryContracts.test.mjs api/_lib/eventCpdAttendanceCapabilities.test.mjs api/public/resource/single-public.test.mjs api/_lib/memberContentPdf.test.mjs
```

Coverage includes ID and unsupported slug paths; tenant/status constraints;
public and locked resource previews; group/event/release exclusions; schemas
with and without Teams bindings; correct meeting owners; infrastructure errors;
and real public/private PDF extraction using dependency-generation provenance,
without timestamp columns.

The local application starts on port 5000. The browser preview reports
“Tenant not found” against the workspace's legacy SOURCE configuration.
It is not successful visual or authenticated production verification.

## Fixed post-rollout observation (not yet performed)

The supplied baseline is a fixed 24-hour investigation:

| Signature | Baseline count |
| --- | ---: |
| `resource.slug` missing | 2,331 |
| `file_repository.updated_at` missing | 175 |
| `attendance_target.provider_connection_id` missing | 68 |
| `complex_event.online_provider` missing | 68 |

The assignment does not provide the baseline's exact start/end timestamps;
recover those from the original investigation rather than inventing them.
Record the actual successful deployment ID and UTC release time. Choose
`T0` after that release has replaced old instances and `T1 = T0 + 24 hours`.
Once T1 has elapsed, query production PostgreSQL logs over **that exact window**
and group missing-column errors by the four signatures above. Record the
window, deployed revision, counts and residual request/query sources.
Also report traffic/call volume: no calls is not proof that a path works.

Exercise public resource IDs and unsupported slugs, resource metadata/crawler
responses, file listing and PDF reads, and both CPD rules screens with the
correct tenant. Verify Teams is unavailable rather than falsely enabled.
Investigate any residual signature for old deployments or additional callers.
Missing Teams-binding readiness warnings must not be reported as successful
Teams attendance support.

There is **no post-rollout count or claim of live resolution yet**. This
observation requires a later authorized rollout and a completed 24-hour window.
