# Partner submission rejection: investigation and approved configuration repair

## Production evidence (2026-09-28)

Read-only inspection used the documented DEST Supabase project
`lvmzliemqnieeoruhkik`, scoped to form
`a47f37f1-b14a-4aea-8aee-cd0ebf7d9a8b`.

- The saved form was public (`require_authentication=false`) with a null
  `mutation_access_policy`.
- Its primary organisation pipeline has real updates: invoicing email,
  invoicing address, logo, and five custom mappings, including the static
  application status. It is not a reference-only selector.
- No applicant continuation grants existed for this form.
- Two drafts were present. The September 22 draft remained unexpired; the March
  draft had expired. Neither had an applicant grant association. A draft is
  answer-recovery evidence, not organisation-write authority.
- The only retained submission was actioned on September 3, with organisation
  and member linkage and email state `sent`. Its newer processing checkpoint
  was absent; this alone does not prove an incomplete historical submission.
- No retained failed submission identifies the reported attempt. Its session,
  new-versus-resumed status, exact selected organisation, and partial effects
  remain unverified. Do not infer absence of effects from absence of a row.

## Approved change applied

The user explicitly approved setting this form's policy to:

```json
{"version":1,"mode":"applicant_continuation"}
```

Applied to DEST only using the existing destination connection validator,
verified provider TLS, a row lock, and a null-policy precondition. Before commit,
all other fields except automatic update timestamps were compared; mappings and
other business settings were unchanged. An independent read confirmed the policy.
The MCP read-only connection rejected the update; the documented DEST pooler
performed the approved change in a transaction.

No migration was required or applied. No schema change remains outstanding for
this configuration repair. No links were issued, submissions replayed, emails
sent, or deployments initiated. SOURCE was untouched.

## Verification and limits

Workspace base revision: `cd16a5cf1`. The reported production `40fdfc8` and preview
`c6c809e` have no relevant differences in the organisation guard, processor, or
applicant preflight. This comparison is not independent deployment verification.
The Vercel deployment-list request returned HTTP 403; current serving revision
and historical runtime logs remain unavailable through that credential.

- Isolated compatibility tests: 96 passed, including a new incident-policy test
  rejecting bare organisation IDs and unbound legacy drafts before persistence.
  Existing fixture tests exercise authorised organisation/contact mappings,
  bound draft resume, retry, and hostile capability/tenant/configuration cases.
- Isolated `npm run test:form-processing`: 264 passed.
- The initial null-policy public-handler fixture returned 201 rather than the
  screenshot's 403. It therefore does **not** reproduce the precise reported
  request path. Do not claim that the screenshot's cause or side effects are
  conclusively established by these tests.

## Remaining incident work / recovery boundary

The policy change alone does not grant existing applicants access. A trusted
administrator must issue scoped links for verified applicant organisations.
Existing bare-ID links and unbound drafts cannot be silently promoted. Issuance
and delivery were not approved in this work.

Obtain the failing request's approximate timestamp, whether it was resumed,
and the deployed processor revision/log evidence (without bearer URLs or raw
personal answers). Correlate organisation/contact/application/relationship
history before recommending any recovery. Do not replay the old actioned
submission, resend its email, or treat linkage columns as creation provenance.
Any bounded repair needs separate approval.

The form configuration change is already live in DEST and affects deployments
using it. No runtime-code deployment was made. The incident is not yet verified
resolved end to end, and no new production attempt was made.

## User follow-up and tenant audit

On September 28 the user confirmed the change works and they could update the
form, then requested a read-only tenant-wide audit. That is user confirmation,
not an independently reproduced anonymous submission. The follow-up read found
a new September 28 submission; its authentication path was not inspected.
Historical request-path and recovery limitations above remain.
See `gfi-form-access-audit.md` for the 40-form audit and prioritised risks.