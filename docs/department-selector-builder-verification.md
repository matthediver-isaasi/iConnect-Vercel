# Department selector builder verification

## Change and authority

FormBuilder still loads its editable form through the generic Form list. That
response does not contain the public endpoint's derived `current_set_enabled`.
The editor now separately reads `/api/forms/:formId/editor-metadata`.

The read requires an authenticated tenant administrator, checks the requested
form in that tenant, and derives the boolean from the persisted configuration
only for the pinned Department form and tenant. Ordinary Department relationship
dropdowns cannot enable it. The response contains only the form ID and boolean,
never reconciliation or respondent mappings.

Absent configuration returns false. Failed lookups, malformed configuration,
and a missing legacy configuration table return a retryable 503 rather than
false. Metadata errors block editing with a Retry action. These reads do not
write configuration, change assignments, or authorize respondent access.

The capability stays outside editable form state. Editor save normalization and
both generic Form write boundaries discard derived capability/configuration
properties. Placement continues to use ordinary field anchors; the virtual
selector is not saved as an answer field.

## Verified locally on 2026-11-20

Workspace source baseline: `af96927d0`, with this task's working-tree changes.
The reported affected build was `57a3d0b`; it was not treated as evidence of a
corrected deployed build. No production build number has been verified.

- `npm run test:department-current-set`: passed, 216 API/shared/helper tests and
  25 client/route tests.
- `node scripts/run-isolated-tests.mjs node --test client/src/lib/formEditorSave.test.mjs client/src/lib/departmentSelectorPlacement.test.mjs`:
  passed, 10 tests.
- `npx playwright test --config=tests/department-selector-builder.config.mjs`:
  six initial rendered-builder scenarios passed; the additional position
  save/reopen scenario also passed when run with `--grep='moving the virtual'`.
  Covers empty standard/paginated forms, card-swipe, a saved first-page anchor,
  ordinary Department dropdown exclusion, retry recovery, keyboard drag,
  field-anchor-only save, and reopen.
- `npx playwright test --config=tests/department-current-set-picker.config.mjs --grep='FormView picker|embed form|retains saved selector' --output=generated-artifacts/department-selector-surfaces`:
  five checks passed, including saved placement after introductory fields on
  standalone, embedded, and actual Canvas iframe surfaces.
- `npx playwright test --config=tests/form-width.config.mjs --grep='FormBuilder saves and reopens' --output=generated-artifacts/department-form-width`:
  passed; ordinary form editing/save/reopen remains compatible.
- `git diff --check`: passed.

API integration tests begin with the generic-list row lacking the flag, call
the actual metadata handler against tenant-filter-aware in-memory configuration,
pass its HTTP-shaped response through the client metadata loader, and then
exercise selector construction/save/reopen. Browser builder fixtures use the
real SPA and the same metadata handler with in-memory configuration. The
protected-form save browser test uses a synthetic password only against its
intercepted in-memory PATCH; it does not validate or bypass real protection.

The existing JSDOM setup required a Node 24-compatible navigator definition.
The standalone/embed smoke fixture also needed isolated SPA navigation and an
authoritative synthetic role, avoiding tenant SSR and missing-role rejection.
These are test setup corrections, not production access changes.

## Not verified

No authenticated deployed builder session was available. The unmodified local
preview did not reach the signed-in tenant builder, so its screenshot does not
prove selector visibility. Live persisted configuration was not queried or
changed, and this fork was not deployed. No migration, import, respondent
assignment, live form save, or access-rule change was performed.
