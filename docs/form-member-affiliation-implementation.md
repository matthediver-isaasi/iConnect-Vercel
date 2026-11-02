# Generic renewal affiliation editing

## Delivery state — 2 November 2026

The configuration UI, authenticated snapshots, submission processing, recovery,
and Due Diligence review UI are integrated. The four additive migrations have
been applied to live DEST and their service-only execution permissions verified.
Existing Due Diligence configurations were compared before/after migration and
were unchanged. No member records were modified and no messages were sent.

Code still requires deployment. Signed-in live submission and real payment
return testing have not been performed; isolated tests are not that evidence.

## Inactive renewal copy

- Name: **Full member renewal — organisation and department review**
- Form: `643ee195-0542-46a9-9464-018dd38b3019`
- Slug: `full-member-renewal-affiliations`
- Dedicated review form: `eb894ac3-9d8f-4ff1-8619-6a18ea996761`
- Original join form `6880a70a-8643-4fcc-a5b9-0af603f00b40` is unchanged.

The copy requires member sign-in and authenticated-owner access. Its ordinary
Payment field was converted to Membership Payment. The five source member-class
values are explicitly mapped to their current effective member schedules.
The original organisation upsert, add-only links, structured creation actions,
join role/login overrides and static communication subscriptions were removed
from this copy. Original member field-answer mappings were retained.
Source-form emails are disabled on this inactive draft pending content review.

## Member behaviour

The form loads a protected snapshot of the member's primary organisation,
departments and secondary affiliations. Loading/errors block submission and
payment initiation; drafts and user edits are preserved.

Listed choices apply together after form submission. Hidden or unanswered
fields preserve existing affiliations; explicit clears are distinct from missing
answers. Removed links are archived rather than deleted.

Not-listed names create one linked Due Diligence case. The entire affiliation
change stays unapplied pending review. Renewal retains its normal eligibility
and payment rules; this review does not hold or approve payment.

Membership Payment can initiate checkout before final form submission.
Payment setup alone does not apply affiliation edits: the completed form
submission is the affiliation boundary.

## Administrator behaviour

Configure **Member affiliation updates** in FormBuilder on a saved,
authenticated-owner form. Choose primary organisation fields, department
relationships, and optional repeatable secondary-assignment mappings.
Incompatible join/creation pipelines must be removed from the renewal copy;
the feature does not silently alter another form's configuration.

Enabling provisions a separate, inactive affiliation-review form with explicit
Review, Approved and Rejected stages. In the existing Due Diligence submission
screen, resolve the complete organisation/department selection and save it
before approval. Approval applies the saved set atomically. Rejection leaves
affiliations unchanged. Shared organisations/departments are not automatically
created; administrators may create them through their normal management tools
and then select them in the review.

## Protection and recovery

- All runtime mappings are generic and tenant-scoped, not hardcoded to BNMS.
- Member identity comes from the verified session, never a submitted ID/email.
- Snapshot binding, configuration and graph comparisons prevent stale writes.
- Department eligibility is checked against the final organisation set.
- Repeat submissions reuse the committed result; later profile edits are not
  restored to an earlier organisation by replay.
- Dedicated review workflows cannot acquire join actions, timers or webhooks.
- Ordinary forms and Due Diligence workflows do not opt in automatically.
- Incomplete discovery fails explicitly rather than becoming an empty set.
- Assignment objects with unsupported additional required fields are rejected.

## Verification

Run `node scripts/run-regression-suite.mjs form-member-affiliations` and
`node scripts/run-regression-suite.mjs form-member-affiliation-runtime`.
Coverage includes real isolated PostgreSQL approval/rejection, stale graph
rollback, case idempotency, resolution versioning and browser-role denial,
plus mounted frontend and real submission-boundary checks.

After deployment, review/activate the inactive copy for controlled member tests:
unchanged affiliations, changed organisation/departments, retained secondary
sites, Not-listed review/approval/rejection, payment return, draft restore and
retry after a saved submission. Do not use real charges merely to test linkage.
