# GSF form access: isolated checks

**2026-09-29.** These are local, no-network, no-database-write configuration
and mocked authorization checks. They do not constitute a production builder
save, applicant login, draft restoration, submission, browser test or successful
business processing.

## Commands and results

From the repository root:

```sh
node scripts/run-isolated-tests.mjs node --test scripts/gsf-form-access-audit.test.mjs shared/formMutationContract.test.mjs api/_lib/formApplicantPreflight.test.mjs api/_lib/formApplicantContinuation.test.mjs api/public/form-draft.applicant.test.mjs scripts/form-compatibility-inventory.test.mjs
```

**55 tests passed; 0 failed, 0 skipped** (six new GSF test cases plus 49
existing node:test cases, including nested draft subtests). `node --check
scripts/gsf-form-access-audit.test.mjs` also passed. An earlier isolated run
of the four pre-existing contract/preflight/continuation/inventory suites alone
passed **43 tests, 0 failures**:

```sh
node scripts/run-isolated-tests.mjs node --test shared/formMutationContract.test.mjs api/_lib/formApplicantPreflight.test.mjs api/_lib/formApplicantContinuation.test.mjs scripts/form-compatibility-inventory.test.mjs
```

These are Node's `node:test` files; no Vitest invocation was used. The isolation
runner blocks network, TCP/HTTP and child processes and reports blocked
attempts, including attempts caught by tests. The successful run reported no
blocked attempts. No production connection was opened.

Additional existing mocked public-submission and persisted-processing regressions:

```sh
node scripts/run-isolated-tests.mjs node --test api/forms/processApplicationOrganizationName.test.mjs api/public/form-submission.repeatable.test.mjs
```

**113 tests passed; 0 failed, 0 skipped.** Together with the 55 above, this audit
ran 168 passing isolated tests (the earlier 43-test subset is not added again).
These handler suites use their existing synthetic fixtures, not live GSF
submissions; they extend coverage of public-signup and organisation ownership
boundaries without proving completion of a real GSF application.

## Pinned assertions and what they mean

`scripts/gsf-form-access-audit.test.mjs` loads **every one of the 14**
sanitized GSF form structures in `tests/fixtures/gsf-form-access.json`,
replaying the **real shared** classifier, assessment and save validator. It
asserts the independently named expected groups, not just agreement with
the inventory summary: **three organisation mutation forms** (`enquiry`,
`so-renewal`, `eso-renewal`), **two member mutation forms**
(`individual-join`, `snapshot`), and **nine unflagged forms**. All 14 are
active in this snapshot; inactive-save and reactivation cases are candidate
state transitions, not claims that an inactive GSF form exists. The five
affected forms permit unchanged legacy saves and metadata-only edits, but
reject changed active configuration and new/copy-active saves without policy.
Inactive drafts allow a warning without gaining submission authority;
reactivation re-enables the strict gate. A malformed policy fails even inactive
saves. In particular, the unaffected Partner/SO/ESO long forms are not
relabelled as mutation flows because of their titles or organisation prefill.

In-memory policy candidates retain the original pipeline mapping JSON:
member-only public signup for Individual and Snapshot passes; member-only
applicant continuation and owner policy without login fail; explicit owner
policy **with** login passes. Organisation continuation or owner-with-login
passes for the three organisation forms, while public member signup fails.
Tests pin 24 mappings and current-date writes on each renewal and a static
write on Initial enquiry; they do not strip custom/core destinations to force
acceptance. Passing a candidate save contract **does not** approve that
business journey or issue a continuation grant.

Read-only, in-memory DB doubles exercise **actual sanitized Individual and
Snapshot member pipelines** against the real public-signup preflight:
new identity is accepted, existing email with no verified owner or a wrong
owner fails, correct tenant-scoped verified owner passes, and an injected
primary member ID or unverified draft-token argument does not establish
ownership in this preflight. These injected arguments are test-double
scenarios, not proof that a browser request can supply a server-side ID.
A same-email member in another tenant does not collide because
lookups include tenant ID. Real sanitized enquiry and renewal forms are
passed to the applicant preflight with server-supplied grant organisation ID:
a matching tenant-scoped ID passes, absent/foreign-tenant IDs fail, and a
respondent's different organisation name does not override the server grant.
The double only implements select/eq/ilike/limit; no inserts, updates or
business executor run.

Existing continuation tests cover expired, revoked, detached, cross-tenant
and changed-config grants, immutable/contact-member scope and replay. Existing
draft tests cover hashed resume capability, ordinary restoration, forged
grant ID, changed configuration and detached/revoked grant refusal. **An
expired GSF draft was not independently restored/tested here.** The member
preflight ignores a draft token, but this is not a test of the entire draft
route. The mocked organisation preflight assumes the grant has already been
verified by the server; it does not authenticate a bearer or test issuance.
The previously run inventory unit tests check pagination mechanics, but this
file does not test the new DEST inventory runner against a mocked DB; tenant
identity, pagination reconciliation and snapshot counts are documented
separately in the read-only inventory evidence.

There is **no new GSF browser or live production proof** here. Static
configuration classification cannot establish whether a record will match,
whether unchanged mapped values require writes, whether a persisted
submission completed processing, or whether deployed frontend/backend
revisions support these modes. No migrations, configuration changes, live
submissions, grants, draft writes, emails or payments were performed.