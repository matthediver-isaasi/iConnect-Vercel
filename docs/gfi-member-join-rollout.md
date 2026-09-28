# GFI member join forms: approval-gated rollout

## Scope

This implementation follows the configuration findings in
`docs/gfi-form-access-audit.md`. It does not change production settings, issue
links, send mail, submit applications, replay submissions, or edit drafts.

The seven candidate forms are:

| Form | Slug | Draft consideration |
|---|---|---|
| AHECS join | `ahecs-join` | No unexpired drafts in the audit |
| Freelance enquiry | `freelance-enquiry` | No unexpired drafts in the audit |
| Freelancer membership | `freelancer-membership` | Six unexpired drafts in the audit |
| HoS Join | `hos-join` | No unexpired drafts in the audit |
| Individual | `individual-join` | No unexpired drafts in the audit |
| Partner Individual Join | `partner-individual-join` | No unexpired drafts in the audit |
| PoC Join | `poc-join` | No unexpired drafts in the audit |

Counts are the September 28, 2026 audit snapshot, not a fresh inventory.

## Intended contract

The explicit policy is:

```json
{"version":1,"mode":"public_member_signup"}
```

Keep public admission (`require_authentication` false) and preserve the existing
member pipelines, mappings, static/date writes, and other business settings.
Do not replace this with organisation applicant continuation or remove configured
updates to make a collision succeed.

A genuinely new member may submit anonymously. Updating an existing member
requires a server-verified session owning that member. Submitted email, member
ID, organisation selection, draft token, or client ownership flags are not
ownership. A signed-in person cannot use this policy to update someone else.
The server checks ownership before submission side effects and checks again
during application processing.

The builder can save this policy for eligible public member-only contracts.
Unsupported organisation/structured mutation contracts must use their own
appropriate access policy. Unchanged legacy forms keep the existing narrow
save compatibility; changing mutation configuration must pass the contract gate.

## Existing drafts

Do not invalidate, rewrite, or silently authorize the six Freelancer membership
drafts. Normal unexpired draft access can restore answers and allow continued
editing/saving. When submitting:

- A new identity may proceed through ordinary new-member signup.
- An existing member must sign in as the matched member.
- A draft for another member must not authorize updates, even after someone
  else signs in.
- An expired draft remains expired. It must not be upgraded to a capability.

The sign-in link preserves the current same-site form/draft return location.
Users with unsaved answers should save a draft before leaving to sign in.
No automatic draft migration or grant issuance is needed or permitted.

## Approval and deployment checklist

1. Obtain approval before publishing or changing any live form.
2. Deploy the compatible application code before enabling the new policy.
   Confirm the served frontend and backend both support it.
3. Re-read the seven tenant-scoped configurations. Confirm each still has only
   the eligible member mutation scope; the historical audit is not authority
   to overwrite intervening changes.
4. Capture the existing configurations for rollback and obtain approval for
   the exact policy-only changes. Apply through the validated save boundary,
   preserving all unrelated settings and answers.
5. Re-read each saved configuration. Verify public new-member admission remains
   enabled and the policy, mappings, and pipelines match the approved changes.
6. Any live submission, payment, email, or owner-login acceptance test needs
   separate explicit approval. Isolated test evidence is not production proof.

No new database schema migration is required by this policy: it uses the existing
JSONB mutation policy column. No migration or live configuration change was
applied by this work. Production policy enablement remains approval-gated.

## Isolated verification

- Shared contract, public submission, persisted processing and client helper
  suites: 134 passing tests, run under `scripts/run-isolated-tests.mjs`.
  Coverage includes seven synthetic slug cases, fresh identities, verified
  owners, forged identities, hidden fields, retries and six legacy draft cases.
  Synthetic cases are not copies of all seven current production configurations.
- Browser fixture: four passing cases in
  `tests/task-4831-member-signup.spec.mjs`, covering anonymous signup,
  existing-member refusal, draft-preserving sign-in navigation and signed-in
  owner submission. API responses are mocked; this is not real login or
  production submission evidence.
- The ordinary workspace preview reports tenant-not-found against its current
  database configuration. No database target or tenant setting was changed
  to work around that; the browser checks use isolated tenant fixtures.