# Global Schools Forum: form configuration audit

**Date: 2026-09-29. Read-only production DEST audit and approval-dependent proposal.**

## Scope and evidence

Production project `lvmzliemqnieeoruhkik` independently returned tenant
`21296ad6-1350-483a-a90c-1b06ece70501`, name and slug `gsf`. A separate public
tenant-branding lookup on `https://gsf.iconn.app` corroborated name/slug `gsf`.
See [deployment evidence](gsf-form-deployment-evidence.md).
The workspace runtime's legacy SOURCE database was not used as production evidence.

The exact UTC snapshot time, tenant identity, per-form configuration digests,
settings and aggregate activity are in [machine-readable evidence](gsf-form-access-evidence.json).
The runner, `scripts/gsf-form-access-audit.mjs`, uses a destination-pinned,
verified-TLS connection, `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`,
tenant-scoped ID-keyset pagination (10 rows/page), and `ROLLBACK`.
**14 rows in two pages reconcile with the tenant-scoped count of 14:
14 active, zero inactive.** No active-only filter was used.

Classification, policy assessment and unchanged/changed save validation use the
current `shared/formMutationContract.js`. This is a mutation-access audit, not
certification of every field type, role, payment, workflow or side effect.
Active denotes the saved flag, not verified availability under every runtime gate.
The GFI audit and member-signup rollout are references, not copied GSF findings.

## Findings at a glance

**Five forms lack the explicit mutation policy needed for changed active saves.**
All five retain narrow unchanged-legacy save compatibility. Thus neither “all
legacy forms are broken” nor “all saves fail” is supported.

All 14 currently have `require_authentication=false`, `access_policy=null`,
and `mutation_access_policy=null`. Across the inventory there are no structured
actions, additional-member creations, implicit field bindings or top-level explicit mappings. The five
mutation forms use modern pipelines. Legacy defaults (`entity_action=create`,
member/organisation actions `none`, `auto_create_entity=false`) are not evidence
that a modern pipeline is create-only; pipeline configuration takes precedence.

### Complete per-form register

`M` = member mutation; `O` = organisation mutation; `N` = neither target classified
as an existing-record mutation. Prefill is recorded separately: organisation
prefill alone is not authority and not proof of an organisation write.
Submission counts cover **2026-09-01 00:00 UTC through the snapshot**, not all time.
All rows below are active/public with the absent policies described above.

| Form / slug | Form ID | Class; prefill | Retained submissions | Unexpired drafts | Recommended action |
|---|---|---|---:|---:|---|
| Reference Request / `reference-request` | `36a9549f-7e34-4ccf-964b-1588d1c3d050` | N; none | 32 | 2 | No mutation-policy correction indicated |
| Initial enquiry / `enquiry` | `3c4124e1-05c6-4423-88e1-a5f91045152b` | O; none | 39 | 0 | Priority 1: decide fresh-enquiry versus existing-applicant route |
| Membership agreement / `membership-agreement` | `3f993b8a-b8e1-4fc8-8a28-4499646b8adf` | N; none | 42 | 6 | No mutation-policy correction indicated |
| Individual / `individual-join` | `498caad5-cfc7-4319-a107-52c27dcfe9b4` | M; organisation | 0 | 0 | Priority 2: public member signup candidate |
| SO Long form fees / `so-application-fees` | `4c030808-8f38-4587-9a98-df9e6686ae0c` | N; organisation | 0 | 0 | No mutation-policy correction indicated |
| SO fees renewal / `so-renewal` | `7b3646f2-a958-41f5-a4bc-c707bb6e246b` | O; organisation | 0 | 0 | Priority 2: scoped continuation or verified-owner renewal |
| ESO Long form fees / `eso-application-fees` | `9f954871-0ac8-4a3b-b976-3575de2bd8be` | N; organisation | 0 | 0 | No mutation-policy correction indicated |
| Newsletter / `newsletter` | `a115f8da-e97f-49e6-aaa0-d4cab030e418` | N; none | 9 | 0 | No mutation-policy correction indicated |
| Partner Long form / `partner-application` | `a224da72-fc6e-4d64-9b3c-5b08ea6d79d9` | N; organisation | 2 | 0 | No mutation-policy correction indicated |
| ESO Long form / `eso-application` | `a9ec1559-495a-4705-9da9-d51517be7bb6` | N; organisation | 11 | 6 | No mutation-policy correction indicated |
| Snapshot / `snapshot` | `ae758d8e-be3e-4f85-a108-9136f2f1ccd3` | M; organisation | 2 | 0 | Priority 2: confirm public signup intent; otherwise owner-only |
| Contact us / `contact-us` | `b174eddc-0935-4ad1-8666-401121a97eab` | N; none | 1 | 0 | No mutation-policy correction indicated |
| SO Long form / `so-application` | `dd04a19b-019b-4cb2-9a7f-3a77027e9857` | N; organisation | 14 | 20 | No mutation-policy correction indicated |
| ESO fees renewal / `eso-renewal` | `ea04df36-1ba6-4d2c-a9ad-2738795ca774` | O; organisation | 0 | 0 | Priority 2: scoped continuation or verified-owner renewal |
| **Total** | **14 distinct forms** | **5 affected / 9 not flagged** | **152** | **34** | **No inactive forms to remediate** |

There are **zero continuation-grant rows** for these tenant forms in the snapshot,
not merely zero unexpired grants. All 34 unexpired drafts belong to forms not
flagged for this mutation-policy issue. The five flagged forms account for 41
recent retained submissions and no unexpired drafts.
Stored statuses total 143 `new` and 9 `submitted`; neither proves completion of
entity processing, email, payment or other side effects. Rejected attempts may
leave no submission, and zero counts do not prove zero demand or zero failures.
No respondent answers, identities, processing-note contents or bearer tokens
were needed for these aggregates.

## Builder restrictions versus submission risk

For each of the five flagged forms the confirmed configuration failure is
`UNSAFE_EXISTING_RECORD_MUTATION_CONTRACT` when an active save changes a
mutation-config key, including `fields`. Metadata-only/no-op saves with unchanged
mutation configuration and absent policy are grandfathered. A copy/new active
form is not grandfathered. Inactive saving can carry a warning, but activation
must pass the strict gate; none of the current GSF rows is inactive.
An invalid policy version/mode would fail even inactive saves, but no such
invalid policy is saved here.

The following runtime findings describe **current source behavior and conditional
risks**, not observed failed production requests:

| Affected form | Preserved configured writes | New-record path | Existing-record / verified-owner path | Candidate and unresolved choice |
|---|---|---|---|---|
| Initial enquiry | Organisation name identity; 9 mappings: 1 core, 8 custom, including 1 static write | With no resolved organisation match, ordinary creation can proceed; a newly supplied name is not proof of a new record | Name collision can resolve an existing organisation; changed core/custom values require verified authority. A login must actually authorize the target, not just exist | Missing `mutation_access_policy`. Organisation continuation is structurally eligible, but requiring a grant on every request would obstruct fresh enquiries. Decide admission/routing first; no blanket policy-only change recommended |
| Individual | Email identity; 7 member mappings: 5 core, 2 custom; role assignment and login enabled | Candidate public signup preserves anonymous new-member creation | Email collision requires sign-in as that member; another signed-in member or selected ID is not authority. Organisation prefill does not itself configure an organisation mutation | Set only `mutation_access_policy={"version":1,"mode":"public_member_signup"}` after approval and compatibility verification; keep public admission and all mappings |
| Snapshot | Email identity; 6 member mappings: 5 core, 1 custom; role assignment and login enabled | Public signup candidate supports genuinely new identities | Same existing-member ownership boundary as Individual; this is not organisation applicant continuation | Same policy candidate as Individual **if** intended for public signup. If only existing members should update, explicitly approve `authenticated_owner` plus login instead |
| SO fees renewal | Organisation name identity; 24 mappings: 4 core, 20 custom; 2 invoicing targets and 1 date write | No-match creation is a possible legacy path, but confirm whether renewal should ever create an organisation | Existing organisation finance/custom updates need verified organisation scope. Ordinary email/name/ID/draft matches do not grant it | Missing policy. Candidate `{"version":1,"mode":"applicant_continuation"}` for invitation-based renewal, or `authenticated_owner` with `require_authentication=true` for portal renewal |
| ESO fees renewal | Organisation name identity; 24 mappings: 3 core, 21 custom; 2 invoicing targets and 1 date write | Same renewal decision as SO | Same scoped existing-organisation boundary as SO | Same two alternatives as SO; choose and approve the real renewal journey before changing settings |

Mapping metrics overlap: invoice and date counts are subsets, not additional
mappings. Preserve exact custom-field destinations, static/date semantics, role
settings, identity matching and intended updates. Do not remove mappings to make
an unauthorised collision appear successful.

For existing organisation writes the processor compares values: unchanged core
or custom values may need no write, so not every collision necessarily fails.
Public signup adds early collision checks; a legacy missing-policy form can
instead encounter the ownership guard during processing. Persisting a submission
therefore does not establish completion. Verified-owner paths still must satisfy
tenant, target, admission and other business validation.

The nine unflagged forms have no member/organisation mutation pipeline under
this audit. Their organisation-prefill settings do not convert them into mutation
forms. Do not add applicant-continuation policy simply because a form is called
“Long form”. Pure reference selection is distinct from writes; an untrusted ID
must not activate a disabled processing action.

## Drafts, continuation and authority

No draft, submitted email, organisation name, selected record ID or historical
link proves ownership. Normal draft restoration and final submission authorization
are separate. For member-signup candidates, a new identity may continue normally;
an existing identity requires the verified matching member session. A draft for
another member stays unauthorised after someone else signs in. Expired drafts
remain expired.

Organisation continuation requires independently verified issuance scoped to
tenant, form and organisation, with any existing contact-member scope captured
and revalidated by the server. Setting the policy alone does not issue authority.
All three organisation candidates lack grant history in this snapshot. Previously
sent bare-ID links must not be upgraded silently. Adding continuation would
require a separately approved issuance/admission plan, including a deliberate
fresh-enquiry path for Initial enquiry. Existing drafts must not be rewritten,
invalidated or converted into grants as part of a policy correction.

Source boundaries: `shared/formMutationContract.js`,
`api/_lib/formApplicantPreflight.js`, `api/_lib/formProcessingPolicy.js`,
`api/_lib/formOrgResolution.js`, `api/_lib/formApplicantContinuation.js`,
`api/forms/process-application.js`, the Form POST/PATCH entity handlers,
`api/public/form/[slug].js`, `FormBuilder.jsx` and `FormView.jsx`.

## Verification and limits

See [isolated checks](gsf-form-isolated-checks.md) for reproducible commands,
sanitized GSF fixture coverage, results and test-double boundaries. These exercise
the current local contract, not live production saves/submissions.
The GFI browser fixtures in `tests/task-4831-member-signup.spec.mjs` are reference
coverage only, not GSF browser or real-login evidence.

Public GETs verified the GSF tenant and served frontend markers for signup in
both form view and builder. They do **not** establish the deployed backend
revision or prove a submitted application works. No authenticated browser,
production builder save, live signup, renewal, owner login, draft restoration,
email or payment was tested. No app runtime was changed for this document-only
audit.

## Approval-dependent correction and rollback checklist

1. Confirm intent: Individual public signup; Snapshot signup versus member-only
   update; renewal portal login versus organisation invitations; Initial enquiry
   first-contact versus continuation routing. These choices are not implied by
   form titles or historical submissions.
2. Verify deployed backend and frontend support for the selected policies before
   enabling them. Current public asset evidence is necessary but insufficient.
3. Re-read all candidate configurations tenant-scoped. Compare the recorded
   mutation/configuration digests; stop for intervening changes. The sanitized
   evidence is not a restorable configuration backup.
4. Capture exact full before-state securely at rollout time, including absent/null
   policies, login, mappings and pipeline settings. Obtain approval for an exact
   per-form diff; use validated save boundaries, never a blanket SQL backfill.
5. Preserve all unrelated settings and data. For public member signup keep login
   false. For owner-only routes explicitly approve login true. For continuation,
   obtain separate approval for any link issuance; setting a policy is not a link.
6. Read back saved settings and verify expected policy acceptance, unchanged
   mappings and correct public/login admission. Separately approve controlled
   end-to-end tests of fresh identity, owner collision, wrong-owner refusal,
   scoped organisation access and draft return before any business side effects.
7. If rollback is needed, restore the captured exact configuration through an
   approved path after checking for newer edits. Restoring a missing legacy policy
   may itself be rejected by the current active save gate; review that explicitly,
   not by bypassing ownership checks. Rollback cannot undo emails/payments or
   confer authority on drafts/grants. This audit created none of those effects.

**Migration status:** no schema migration is required for this audit or the
proposed existing-column policy settings. `mutation_access_policy` was readable
in production DEST. **No migrations were applied to DEST, SOURCE or any other
database; none are pending for this audit.** No live forms, submissions, drafts,
grants, members or organisations were changed. No deployment or recovery replay
was performed.