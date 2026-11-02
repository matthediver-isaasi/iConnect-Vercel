# Generic member affiliation editing — implementation status

This feature is **not enabled or ready for member testing**. Existing forms,
submission behaviour and live member records have not been changed.

## Prepared and tested

- Pure current-set planner with explicit clear versus hidden/unanswered
  semantics, tenant/member scoping, version checks and retained-edge preservation.
- Protected transactional migrations for primary organisation and member
  relationship changes, secondary assignment creation/archival, immutable
  snapshot context and idempotent submission recovery.
- Standalone FormBuilder configuration component and member-prefill hook.
  They are intentionally **not mounted** in FormBuilder or FormView.
- Real isolated PostgreSQL tests cover atomic rollback (including a failure
  after secondary-record creation), successful application, replay, archival
  history, stale versions and browser-role permission denial.
- A separate authenticated submission-binding function must be called before
  apply/defer. Retries cannot use a snapshot bound to another submission;
  review requests cannot silently become applied changes.
- Run the prepared-component and real PostgreSQL tests with
  `node scripts/run-regression-suite.mjs form-member-affiliations`.

## Not done

Review will use the existing Due Diligence interface, per owner direction,
rather than a separate review screen. The opt-in stage/ownership contract and
exclusive dispatcher are wired into the stage runner. Ordinary configurations
return unhandled without any review queries and retain their existing actions.
Opted-in cases never fall back to join actions on lookup or execution failure.

This is not yet an operational end-to-end Due Diligence integration. The
dispatcher expects protected review-case linkage and the
`decide_form_member_affiliation_review` decision RPC, neither of which is
implemented yet. No configuration is enabled. The config query uses `select('*')`
so ordinary deployments do not fail on a missing opt-in column. Before enabling,
implement the dedicated case creation/linkage, resolved-record approval UI,
decision transaction and configuration storage. Do not confuse a stage transition
or RPC acknowledgement with successful affiliation application.

The SQL is prepared, not deployed. The owner approved applying the migrations
after implementation and testing; that condition is not yet satisfied for the
end-to-end feature. Do not deploy or enable these procedures based solely on
the transaction-fixture tests.

Missing application boundaries:

1. Authenticated, tenant-scoped configuration and snapshot endpoints with
   complete server-side validation of configured fields and relationship
   definitions. The standalone components describe the intended endpoints;
   those endpoints do not yet exist.
2. Authoritative mapping of visible answers to proposed primary organisation,
   secondary organisations and department sets. Validate final eligibility
   across retained secondary affiliations and explicit removals.
3. Wire the protected binding function to the submission endpoint using its
   server-resolved actor. Never treat a submitted member ID, email match or
   arbitrary mutable created-member checkpoint as proof of the signed-in actor.
4. Integrate once with submission processing and retries, disabling conflicting
   old organisation pipelines, additional-site creation and add-only relation
   actions for configured affiliation forms. Existing forms must stay unchanged.
5. Connect the prepared frontend only once these endpoints and save boundaries
   exist; verify loading, errors, draft restore, hidden rules and resubmission.
6. Test actual schema/graph triggers, access policy, expired tokens, concurrent
   profile edits, payment return and recovery paths. The isolated database
   fixture intentionally does not substitute for these integration checks.
7. Apply and verify approved migrations, then configure an inactive renewal
   duplicate without changing the original join form.

## Configuration contract prepared by the frontend

`version`, `enabled`, `primaryOrganizationFieldIds`,
`primaryDepartmentsFieldId`, `memberDepartmentDefinitionId`,
`additionalSitesFieldId`, `secondaryOrganizationFieldId`,
`secondaryDepartmentsFieldId`, `secondaryObjectId`,
`secondaryMemberDefinitionId`, `secondaryOrganizationDefinitionId`,
`secondaryLabelFieldId`.

`secondaryLabelFieldId` identifies a field on the secondary-assignment custom
object, not a repeatable answer field. Definition direction must be validated;
the database supports either member endpoint direction.

## Safety constraints

- Generic configuration only: no tenant, object, field or membership schedule
  IDs hardcoded in shared logic.
- Selecting an existing organisation is a reference, not authority to change
  its shared record.
- A partial discovery result must never become an authoritative empty set.
- New assignment objects must satisfy the configured object's complete
  required-field and data validation rules, not just its label field.
- Retained departments must be valid for the final affiliations. SQL insertion
  triggers alone do not revalidate retained relationships.
- An absent/hidden answer must never imply deletion.
- The owner confirmed Not-listed organisations/departments go to administrator
  review. Keep existing affiliations unchanged and let renewal continue under
  its normal eligibility/payment checks. Do not automatically create shared
  organisation/department records or partly apply the proposed affiliation set.
- Review collection and protected storage are prepared and tested, but still
  require integration with authoritative submission parsing and an admin review
  surface. A persisted review must not be confused with an approved change.
