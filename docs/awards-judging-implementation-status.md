# Awards and Judging — staged implementation status

This is an implementation record, **not a release-completion declaration**.
The approved scope remains the complete brief and acceptance scenarios A–F.
The policy contract is in `awards-judging-integration-contract.md`.

## Environment and release boundary

- No awards migration has been applied to a live database.
- No actual invitation, outcome message or certificate has been sent.
- Local PostgreSQL tests use disposable schemas and fixture identities.
- Provider tests inject a delivery adapter; they are not delivery evidence.
- The ordinary workspace preview still targets the legacy SOURCE configuration.
  Its tenant lookup currently fails because `public.tenant` is unavailable.
  The `/judging` screenshot therefore does not verify a signed-in tenant UI.
- DEST ownership/schema checks were read-only. Do not point the ordinary preview
  at production to make tests pass. Do not deploy from the task fork.
- After approval to use the existing DEV configuration, a no-write target check
  found that its Supabase REST URL identifies the production destination.
  Its SQL target did not match the existing independently verifiable project-ID
  rules. No connection settings were changed and no test writes were attempted.
  The owner subsequently reaffirmed use of DEST as documented in `replit.md`.
  Use that destination workflow, not a new-database prerequisite: read-only
  checks and rollback rehearsals, isolated fixtures for destructive/provider
  tests, and separately documented authorised application. This does not
  authorise test emails, payments or changes to customer records.

## Implemented portions

### Current implementation and acceptance evidence (migrations 001–070)

- Approved applicant-choice policy implemented: application links grant no new
  directory access. Supported root choices use existing form access; protected
  or unsupported linked controls remain read-only. Amendments update review
  evidence without rerunning form actions.
- Recorded labels are immutable review evidence. Identified survey amendments
  use the published survey definition rather than an unpublished draft.
- Administrative moderators/approvers can read assignment-bound current or
  submitted historical evidence. Each attachment chunk rechecks authority.
- Parent award locks now prevent finalisation racing assessment changes.
  Domain version conflicts return `PT409`: native HTTP testing exposed repeated
  PostgREST retries when stale business revisions used SQLSTATE `40001`.
- Intake flags potential same-award duplicates by member or normalized
  non-empty submission email. Both entries are flagged; eligibility, canonical
  submissions and retained answers are not merged, deleted or automatically
  rejected. Finalisation serializes on the parent award.
- Added a native PostgreSQL/PostgREST API journey covering three independent
  judges, drafts/submission locking, moderation, shortlisting, outcome approval,
  cross-login-mode self-approval denial, publication/retraction, advancement to
  another round, external invitation redemption, attachment reads, revocation,
  event-specific publication, separately released winner notification and real
  PDF preview/issuance. Normal-session identity and provider/storage delivery
  adapters are explicit isolated fixtures, not live authentication/provider proof.
- `node scripts/test-awards-judging.mjs` passed **81 focused checks and 69
  browser fixtures**. The registered workflow is separate from ordinary Run.
  Form compatibility passed **279** checks; selected existing certificate,
  event-policy and mail regressions passed **77**; safety boundaries passed
  **17**. The production build passed.
- A broader exploratory selection returned **82 passing / 41 failing** checks.
  Failures included event-payment fixture imports/dependencies, the invoice
  address assertion's newly returned fields, and a transactional-preference
  data-URL fixture failing to resolve a relative import. These checks are not
  represented as passing and remain to be triaged.
  The invoice-address assertion and transactional-preference import fixture have
  since been repaired; their **15 tests pass**. The older event-payment handler
  suite is still not green and requires separate fixture/contract investigation.
- DEST rollback rehearsal passed for **70 migrations / 36 protected tables**,
  digest `15f1bafde44a1aeb5e5fe2ee613d2ba2a81ca078b87f3a97b3029b6cab273428`.
  No customer writes, external sends or deployment occurred.
- Application restart was clean. The `/judging` preview still returns
  **Tenant not found**. The ordinary signed-in portal has not been visually
  verified; the native browser harness below does not change that fact.

#### Native acceptance journey

`tests/awards-native.browser.test.mjs` connects real browser components to the
real API handlers, Supabase query builders, PostgREST and disposable PostgreSQL.
It does not substitute successful scoring/moderation/publication/issuance replies.
The browser runs over temporary local HTTPS so external cookies retain their
actual `Secure`, `HttpOnly` and `__Host-` protections. Requests cross a narrow,
assignment/round/event/outcome-bound test bridge; the isolated database process
still denies remote networking and provider calls. Existing ordinary login
identity remains an explicit fixture boundary. External session authority,
cookie transport, CSRF verification and revocation use the real implementation.

| Brief scenario | Evidence |
| --- | --- |
| A — Simple award | Create/bind/open/intake/eligibility/allocation through native commands and handlers; three browser judges save, reload and submit; exact average, shortlist, approval and publication assertions. |
| B — External judge | Real invitation worker with isolated delivery adapter; single-use redemption; real restricted session cookie and CSRF in Chromium; assigned evidence/file reads; draft reload and locked submission; no member creation. |
| C — Moderation | Browser proposal and separate-approver confirmation against native records; discussion, self-approval denial, moderated-score precedence and unchanged original assessments. |
| D — Event | Native event association and public endpoint; actual event component hides approved but unpublished results and displays explicitly published results; separate notification release, durable delivered state and duplicate-send denial; browser PDF preview/download/approval and native immutable issuance/replay. |
| E — Multiple rounds | Confirmed shortlist advances to a second round with different criteria and an external panel; final moderation and outcome selection preserve the first round's scores and decisions. |
| F — Security | Native policy/grant and API cases cover tenant ownership, other-judge writes, unrelated assignments, ordinary-judge approval/publication denial, session replay/expiry/revocation, immutable scores and confidential public projections. Parent finalisation races and stale REST conflicts are also exercised. |

The browser portion includes desktop and narrow layouts and now adds one native
journey to the 69 existing browser fixtures (**70 browser tests total**).
The latest focused suite passed all **81** checks. Source/provider-specific
amendment cases remain covered by focused tests plus the existing browser
fixtures, not by a production FormBuilder submission.

#### Release boundaries

The implementation includes the initial moderation, multiple-round, event,
communications, certificate and reporting surfaces; these are not deferred MVP
features. Advanced aggregation algorithms remain outside the enabled defaults.
Retention is explicit tenant configuration before intake; archiving retains
history. No automatic destruction, inferred legal-hold expiry or unauthorised
historical conversion has been introduced.

This fork has **not** applied live migrations, sent real mail, created customer
test accounts or deployed. Committed schema rollout and deployed/provider
verification must be recorded separately after the permitted main-app release.
The workspace's legacy SOURCE preview must not be mistaken for DEST evidence.

- Current stage also includes member applicant status/withdrawal, retained private
  attachment bytes and assignment-bound proxy downloads, published survey-version
  capture, safe repeatable-child projection, immutable reusable scoring templates,
  round/award lifecycle controls, assignment conflict/inclusion and availability
  controls, round advancement UI, and audit/reporting CSV/Excel/PDF interfaces.
- Award certificate templates reuse the CPD PDF renderer without changing CPD
  documents. Explicit generation, private immutable issuance, recipient-release
  checks and scoped external certificate links are implemented. Existing private
  upload routes now support the award-template namespace.
- Communications use existing tenant Email Templates, canonical recipients,
  explicit scheduled requests, encrypted certificate credentials, claim leases
  and send-time authority checks. Outcome and shortlist recipient releases are
  independent. Shortlist public-projection services exist, but their administration
  and event display controls still need completion.

- DEST rollback rehearsal passed for the first sixteen migrations: 26 protected
  relations, no committed changes, no customer writes and no provider calls.
  Later migrations still require their own destination rehearsal.
- Added exact-score shortlist previews, reasoned tie/manual overrides,
  recommendation-before-confirmation, source-fenced commits and immutable history.
  Added outcome categories and provisional/recommended/approved/reopened decisions,
  separate approvers, explicit public/member publication and retraction, safe
  projections, and a separate recipient-delivery authorisation gate.
- Added existing standard/complex event association controls and public/member
  display components. Publication remains separate from linking an event.
  Added confirmed-shortlist advancement and later-round assignment fencing.
  These are implemented stages, not acceptance of the complete module.

- Additive relational competition/programme, review evidence, reusable assessment,
  moderation, outcome/publication/delivery/certificate foundation; service-only
  commands, tenant ownership checks, immutable evidence and generic-API guards.
- `/awards` programme/competition configuration, safe configuration duplication,
  form binding with explicit review allowlist, rounds and versioned criteria.
- Canonical member/contact lookup and appointment administration, allocation
  preview/confirmation, invitation queue/revocation, start-judging controls.
- Explicit `award_id` in FormView submission context; original intake capture,
  later retryable application registration and immutable initial review version.
- Restricted invitation redemption, hashed credentials, session-bound CSRF,
  rate limiting, session-generation revocation, own-assignment reads/writes.
- `/judging` dashboard, desktop/mobile assessment editor, draft retries, locked
  submissions and conflict declarations. Reopening preserves earlier revisions.
- Exact rational scoring/normalisation, completion policies, equal-weight
  aggregates, discrepancy and shortlist recommendation helpers.
- Admin moderation discussion/proposals/separate approval/reopening, immutable
  history and official-score precedence tied to the original assessment set.
- Encrypted queued invitation credentials and lease-based invitation delivery
  adapter. Unknown provider outcomes require attention rather than automatic
  replay. The new delivery route is not yet added to a production cron schedule.

## Verification so far

- Latest checkpoint: 38 migrations rehearsed and rolled back on verified DEST,
  53 focused tests passed and the build passed. No retained DEST changes or sends.
  Evidence-only amendments now have database barriers against due-diligence
  initialization and original-email claims. Shared canonical answer validators
  are available without importing business-action execution.
- Explicit round/application snapshot adoption now has API and administration UI.
  The database checks the full assignment-version map, reopens affected assessments
  without copying answers, preserves revision-level evidence provenance and
  blocks adoption while downstream decisions remain active. Applicant amendment
  intake, remaining business-action entry-point guards and attachment reuse are
  still not integrated; do not expose a save flow until those are complete.
- The canonical entity-processing endpoint and submitter-copy sender now reject
  amendment submissions using persisted context. Exact missing-column
  compatibility preserves pre-installation ordinary forms; other lookup errors
  fail closed. The 279 form regression checks and 77 mail/copy checks passed.

- Subsequent amendment checkpoint: 35 migrations / 34 protected tables passed
  the DEST rollback rehearsal. Amendment provenance/ownership/idempotency and
  retained originals passed the isolated database suite; 39 focused tests and
  279 form regression tests passed. Build passed after shortlist controls.
- Evidence-only amendment persistence is not an enabled applicant flow yet:
  canonical validation and automatic-processing suppression must be integrated
  before exposing submission. In particular, canonical form submissions can
  enter due-diligence initialization and email recovery outside the initial POST.
  Administrator adoption and external applicant amendments remain mandatory.
- Shortlist publication/release administration and safe event shortlist rendering
  have now been added. Their authenticated end-to-end tests remain open.

- Current checkpoint: all 34 migrations rehearsed successfully on verified DEST
  and rolled back; 33 protected relations checked, no retained schema changes,
  customer writes or provider calls. This is not an applied deployment.
- Latest build completed both Vite and server bundling. The shell observation
  lost its process handle, but the saved build log contains both successful
  completion messages. The application workflow restarted cleanly on port 5000.
- Latest targeted command passed 51 tests; five browser component fixtures and
  all 279 form-submission-compatibility tests passed. These do not replace A–F.
- The current preview screenshot still shows “Tenant not found” against the
  legacy SOURCE configuration. Signed-in UI and full real-provider journeys
  remain unverified; no authentication bypass or runtime target switch was used.

- Production frontend/server build passed after the latest admin UI batch.
- Focused scoring, access/credential, intake, projection, evidence and provider
  adapter tests passed.
- Disposable PostgreSQL tests apply the additive migrations and exercise tenant
  denial, direct-write grants, immutable snapshots, invitation replay/revocation,
  assessment submission/reopening, moderation history, safe duplication, and
  cancellation of a queued invitation before provider delivery.
- Five isolated browser cases passed for desktop/mobile configuration and
  assessment editing, failed-save retention, same-request retries and locking.
  These are component fixtures, not complete acceptance-scenario evidence.
- `form-submission-compatibility`: 279 tests passed after intake integration.

## Earlier implementation checkpoints

### Latest verified implementation checkpoint

- Member amendments create separate canonical evidence-only submissions. Database
  guards exclude their stock, invoice, membership and email side effects. The
  original submission remains intact; judges adopt a new review version explicitly.
- Round-appointed moderation, conflict declaration/review, separate approval,
  permitted submitted peer views, rubric corrections and judge assignment decline
  now have administration/judging interfaces and service-only transactional commands.
  Rubric corrections retain old assessments and reopen empty revisions for every
  affected assignment. Proposed or approved moderation can be explicitly reopened.
- Conflict-invalid moderation no longer supplies the official moderated score.
  Publication, new recipient release and certificate generation recheck approved
  evidence. Credential revocation alone does not silently exclude completed scores.
- Fifty-three migrations rehearsed successfully against verified DEST and rolled
  back: 35 protected tables, no customer writes and no provider calls. Digest:
  `cd3f15c80dadfad386fbf54eaa5ccfa148892d4b2618851ef57eb959a595e565`.
- Staff-only linked-event progress, version-fenced certificate-link revocation,
  configured invitation templates, explicit automatic message policies and
  delivery recovery controls are implemented. Automatic policies default off
  and only consider records created after activation; they do not backfill.
  Existing queued times remain snapshots, while changed underlying deadlines
  invalidate stale automatic reminders. Outcome/certificate sends still require
  separate release. Uncertain provider outcomes cannot be retried.
- Added an authenticated minute cron configuration (not deployed). Its bounded
  scheduler rotates enabled configurations by persisted last-scan time and
  creates deterministic, duplicate-safe queue entries before existing workers.
  Disposable PostgreSQL tests verified no backfill, repeat-run deduplication,
  stale revocation sets and preservation of uncertain outcomes after cancellation.
  Worker tests cover denied authentication and explicit scheduling failure.
- The production build and five existing isolated desktop/mobile browser cases
  passed. Expanded disposable PostgreSQL tests covered appointed moderation,
  same-person approval denial, conflict invalidation, rubric revision provenance,
  stale versions, scoped decline and retained assessment history. Seven focused
  panel/decline/evidence tests also passed. New panel/amendment browser journeys
  and complete scenarios A–F remain unverified.
- Restarted preview serves successfully but `/judging` still displays “Tenant not
  found” under its existing SOURCE configuration. Signed-in UI was not verified.
  No runtime target switch, authentication bypass or deployment was performed.

### Current checkpoint: migrations 001–066

- External applicants now have scoped status, withdrawal, evidence-only amendments,
  released-certificate retrieval and revocable access links. Grants do not create
  members or authorize ordinary form actions.
- Composite amendments support address, signature, grouped and safe static
  repeatable controls. Repeated files retain row/child provenance; changing a
  sibling answer preserves the original retained file without downloading its
  mutable source again.
- Applicants, assigned judges and appointed panels can read immutable permitted
  evidence. Attachment downloads reauthorize every bounded chunk and verify the
  complete checksum before download. Revocation discards partial bytes.
- Managed relationship/organisation display labels are captured from canonical
  services into immutable review versions; unchanged references preserve prior
  display evidence. Private choice browsing remains unresolved, not implicitly
  authorized by an applicant link.
- Added event-scoped outcome publication controls, finalised-award review reopening,
  submitted-assessment history and workload reporting. Historical submissions stay
  separate from current official scoring and no draft answers enter reports.
- Competition permissions inherit the existing administrative boundary, preserving
  ordinary members' parent-level exclusions. Outcome approval now checks canonical
  actor identity across login modes and declared conflicts.
- Verification: production build passed; 76 focused checks passed, including
  disposable native PostgreSQL and actual PostgREST/handler reads. PostgREST uses
  an explicitly opted-in, owned UNIX socket; remote databases and TCP stay blocked.
  Role hierarchy and isolation/startup checks passed. The form compatibility suite
  passed 279 tests. Browser fixtures passed 34 amendment/evidence cases, plus the
  existing five configuration/judging fixtures.
- DEST rehearsal: 66 migrations, 36 protected tables; digest
  `3aca09e20ac7de329b91de92e10a578ad1c139ecf4d404a97efa834e5e851ae0`.
  Everything rolled back; no customer writes, provider sends or deployment.
- Preview restarted cleanly, but `/judging` still shows the existing “Tenant not
  found” response. Authenticated UI and full native/browser scenarios A–F have
  **not** been verified. Fixture checks are not deployed evidence.

The earlier counts and limitations above are historical checkpoints. Use the
current acceptance matrix and release boundaries at the top for the latest
evidence. In particular, local fixtures are not deployed delivery evidence, and
the ordinary signed-in portal preview remains unverified.
