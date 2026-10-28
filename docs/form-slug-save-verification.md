# Form slug save verification

## Read-only diagnosis

The reported form was inspected through the pinned DEST database connection in
a `BEGIN READ ONLY` transaction. No live form, access setting, submission or slug
was changed.

The saved form is active, public and has a null mutation access policy. Its
member pipeline is classified as an existing-record mutation, and a Structured
Record organisation-group upsert is incompatible with applicant continuation.
This is an unchanged legacy contract, not an invalid explicit policy.

Executing the builder's actual hydration and save normalization against that row
changed these keys before the fix:

- `fields`
- `auto_create_entity`
- `create_entity_type`
- `entity_action`
- `member_entity_action`
- `organization_entity_action`
- `additional_member_creations`
- `structured_actions`

That candidate fails with the Structured Record authenticated-owner requirement.
Restoring unchanged persisted values leaves zero mutation-key differences and
passes the existing server/client validator with `legacyCompatibility: true`.
The desired slug (without its trailing `-v3`) had zero same-tenant collisions at
inspection time. This is not a reservation or proof of a future successful write.

## Save behavior

The editor captures the raw row separately from its hydrated, save-normalized
baseline. Unchanged mutation/access keys are restored and then omitted from the
PATCH, preserving null/absent values, avoiding server action re-normalization and
leaving newer server-side access settings intact. Client validation merges that
patch with its saved baseline; server validation merges it with the actual row.

Background refetches do not hydrate over edits. Form navigation remounts the
editor. Acknowledgements advance the baseline using the submitted snapshot,
without treating edits made during the request as already saved.

New forms, reactivation, changed mutation configuration and invalid explicit
policies continue through the existing validator. Submission processing and
authenticated-owner requirements are unchanged. Any future change to this
form's mutation configuration must satisfy those requirements; a slug save does
not authorize its public Structured Record upsert.

## Verification

- Actual builder hydration unit regressions, including generated pipeline IDs,
  action arrays, option cleanup, absence/null, explicit policies and activation.
- Real generic PATCH handler with isolated database/auth/service fixtures:
  persistence/readback, invalid-policy rejection, tenant isolation and database
  slug-conflict propagation.
- Existing mutation-contract, processing tenant-order and CRM replay
  authorization tests.
- Isolated Playwright builder: edit slug, save, reload, save again; original
  mutation configuration retained. Existing width save/reopen test also passes.
- Ordinary unauthenticated preview capture cannot verify the signed-in builder
  (workspace tenant lookup fails); builder interaction was verified with isolated
  browser fixtures instead, with real writes blocked.
