# Public form category investigation

## Live read-only evidence — 2026-09-29

Inspected the verified production destination `lvmzliemqnieeoruhkik` using
read-only SQL, then fetched the tenant's configured domain without a session.
No submissions, subscriptions, configuration updates, or database migrations
were made.

- Form `a47f37f1-b14a-4aea-8aee-cd0ebf7d9a8b` currently resolves to
  `partner-application` in tenant GFI.
- Its persisted fields contain no `communication_preferences` field, including
  nested fields. Consequently there is no current field category allowlist or
  default-selection configuration to reproduce from this form.
- `auto_create_entity=false`, `member_entity_action=none`,
  `default_member_role_id=null`, and `additional_member_creations=[]`.
- The form-level `communication_category_id` references Graduate Futures
  Newsletter. This is not a renderer field or an instruction to expose a
  private category.
- All three tenant categories (News updates, Event updates, Graduate Futures
  Newsletter) are active, member-enabled, role-scoped, and **not public**.
- Anonymous GET `https://graduatefutures.org/api/public/communication-categories`
  (following the domain redirect) returns HTTP 200 and `[]`.
- Anonymous GET `https://graduatefutures.org/api/public/form/partner-application`
  returns HTTP 200, the same form ID, 16 fields, and no communication-preferences
  field.

The supplied screenshot shows the shared renderer's empty-state text, but does
not match the current saved form. The current empty category response is caused
by private audience configuration, not a failed request. Restoring public
visibility for these particular categories would require explicit approval to
change audience settings; this fix does not do that.

## Independent code defect confirmed before implementation

The shared renderer previously rejected every category with `role_ids` when no
effective member role existed. This incorrectly rejected genuinely public
categories for external respondents. It also pruned saved selections without
waiting for eligibility readiness or distinguishing query failure from an empty
result.

The code fix addresses that generic regression while retaining private-category
exclusion, member audience/role restrictions, field allowlists, conditional
options, and server-side subscription enforcement. Fixture tests demonstrate
these cases; they do not establish that the live form has changed or that a
deployment has occurred.

## Verification

- 40 helper/source regressions and 4 mounted renderer tests passed through the
  isolated test runner, covering anonymous role-scoped visibility, member
  boundaries, conditional filters, defaults, retained values, and retry.
- 12 endpoint/subscription RBAC tests and 7 shared membership eligibility tests
  passed. These use isolated fixtures, not production writes.
- Edited JSX syntax transforms passed and the application workflow restarted
  successfully on port 5000.
- The development preview screenshot timed out. The workspace uses the legacy
  database and its preview host has tenant-resolution errors, so no successful
  live browser verification of the corrected field is claimed.
- No migrations are required, applied, or awaiting application. No production
  configuration, submissions, or subscriptions were changed.

## Freelancer membership form: separate read-only check — 2026-09-30

This is a **different form** from the `partner-application` above. A bounded
`BEGIN READ ONLY` / `ROLLBACK` query used the existing project-pinned DEST SQL
connection (`lvmzliemqnieeoruhkik`, verified TLS). Anonymous GETs to the
tenant's configured `graduatefutures.org` domain supplied the deployed public
API comparison. No member impersonation, form submission, consent change,
subscription write, configuration update, or migration was performed.

- Form `568c559b-90fa-49b9-b7cb-016a75a31660` belongs to GFI tenant
  `fd82da65-aab7-4a5c-85b8-b2febeb2003d`. It is active, slug
  `freelancer-membership`, and has 18 top-level fields. Both DEST and the
  anonymous deployed form GET show one `communication_preferences` field,
  `field_1772545139956`, labelled “Please confirm you wish to receive our
  newsletter.” It is required, allows the three category IDs below, and
  defaults **Graduate Futures Newsletter** to selected.
- All three allowed categories are active, `member_enabled=true`, and
  `is_public=false`. Graduate Futures Newsletter is allowed for the primary
  member pipeline's configured role
  `39ed3e82-cf1b-4764-a059-42ba71bdf4b3`; News updates and Event updates
  are **not** assigned to that role. The form maps the newsletter field's
  newsletter category to a member communication selection. These facts
  describe the configured role, not the eligibility of a particular person.
- The form has `prefill_source=member`, `require_authentication=false`, no
  `access_policy`, and the persisted
  `mutation_access_policy={"version":1,"mode":"legacy_public_application"}`.
  The latter is the reviewed legacy form mutation contract; it does not grant
  anonymous callers ownership of arbitrary member records. Any member-aware
  preference read or write still requires verified, tenant-scoped authority
  and server-side member/category eligibility checks.
- Anonymous deployed GET
  `https://graduatefutures.org/api/public/form/freelancer-membership`
  returned HTTP 200 with the same form ID, field allowlist, defaults, and
  legacy mutation mode. Anonymous deployed GET
  `https://graduatefutures.org/api/public/communication-categories` returned
  HTTP 200 with `[]`. The public endpoint filters for `is_public=true` before
  returning categories. An empty anonymous response is therefore expected for
  these three member-only categories, **not** proof of missing saved choices or
  permission to make them public. A default category ID alone cannot populate
  an option absent from the returned audience.

No unambiguous reported member identifier was present in the investigation
materials available for this check. We therefore did **not** inspect a
particular member's role, existing `member_communication_preference` rows, or
whether their prior selections should be restored. A form's configured
creation role is not evidence of the current role of a returning member.
Authorized member-specific confirmation requires the exact reported member ID
and a tenant-scoped, read-only lookup. These production GETs describe the
currently deployed anonymous API only; local code changes and isolated tests
are **not** evidence that a member-aware fix has been deployed or that a
member-authenticated browser flow works.

## Implemented form-scoped discovery — 2026-09-30

The user clarified that this form must also display preferences while creating
a new member. The implementation therefore covers both authorized existing
members and public new-member creation through a persisted primary member
pipeline. New-member role eligibility is resolved on the server using the same
role assignment rules as submission; browser-supplied roles or configuration
are not authority. The general anonymous categories endpoint remains unchanged.
No standard checkbox/mapping workaround or audience configuration change is
needed for this form.

Isolated endpoint tests cover existing-member authority, explicit legacy
admission, secure forms, tenant boundaries, field allowlists, category audience
and role eligibility, failures, new-member fixed/dynamic/roleless assignment,
and subscription-persistence consistency. Mounted renderer tests cover private
category defaults, retry without losing answers, conditional role answer
changes, and cache/context changes. Existing public endpoint, subscription,
membership eligibility and API route regressions also pass.

Embedded forms now receive the same discovery context in both card and page
layouts, including repeatable children. Six additional mounted EmbedForm
regressions cover private choices and defaults, existing-member identity,
repeatable propagation, changing conditional eligibility, and retry.

The development workflow starts on port 5000. Its browser preview reaches the
application but returns “Tenant not found” against the workspace's legacy
database; this is not a successful visual verification of the production
form. The new implementation has not been deployed or submitted against live
data as part of this work.

No database migrations were needed or applied to DEST, SOURCE, or any other
database, and none remain outstanding. Production submissions, consent,
category configuration and emails were not changed.