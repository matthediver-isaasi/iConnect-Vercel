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