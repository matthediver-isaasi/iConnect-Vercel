# BNMS deployed renewal acceptance — 5 October 2026

## Decision: local acceptance passed; hold live rollout

The updated application is deployed and the BNMS tenant form resolves correctly.
The current 83 assignments remain evidence-ready. This is **not** authenticated
browser acceptance or approval to enable renewal payments.

The operator subsequently selected a disposable local acceptance environment,
acknowledging that it cannot prove production sign-in or provider acceptance,
and requested release afterwards. Local acceptance is now complete under that
revised scope. No production release/gate change was performed: the remaining
live acceptance requirements below have not been waived by the tests.

## Deployment and public browser evidence

- Vercel production deployment `dpl_6q5WgFGUJvLp2fVQvLrc34ZCav5i` is READY,
  commit `fb56670cb1c4a97e9355688b1ce51778aa6a936f`.
- Vercel reports both `www.bnms.org.uk` and `bnms.org.uk` as aliases of that
  deployment. The prior deployment was missing the expiry-only implementation.
- GET `https://www.bnms.org.uk/FormView?slug=membership-renewal` now serves
  `/assets/index-nU1XnW2r.js`. That actual downloaded bundle contains
  `operator_attested_expiry_only` and the complete administrator-attestation text:
  “Existing membership is recorded as paid by administrator attestation, not
  verified provider settlement. Historical commencement remains unknown.”
- The tenant-branding endpoint responds successfully. A public browser capture
  of the real FormView route displays BNMS branding and “Membership renewal”,
  not “Tenant not found”.
- The browser is not signed in. The payment element instead says member
  information is required and asks for a member_id parameter. No member ID was
  injected, no session was impersonated, and neither Submit nor Save & Continue
  Later was used. This does not establish the signed-in member journey.

## Fresh read-only DEST audit

Command: `node scripts/audit-bnms-renewal-readiness.mjs --read-only-dest`.

Observation: **2026-10-05T05:03:43.624Z**, repeatable-read transaction with
`transaction_read_only=on`.

Final recheck after local browser acceptance: **2026-10-05T05:20:32.441Z**.
All counts, both disabled gates and both hashes below remain unchanged.

| Check | Result |
|---|---|
| BNMS rollout / global rollout | false / false |
| Expiry-only capability | true |
| Assignments / members / histories | 83 / 83 / 83 |
| Valid provenance, SQL policy and application policy | 83 each |
| Eligible evidence assessment | 83 |
| Offline gate-open context reaches pricing boundary | 83; pricing not run |
| Pauses, conflicts, unavailable owners | 0 |
| Agreements, elections, quotes | 0 |

Snapshot SHA-256:
`be5c5c15fcfaa4a5ff70278613940f7f50bd5468276fe160924a5bde9798ab29`.
Inspected functions SHA-256:
`e2d54493f3c71915c0bb31e57bce593ce5050f935e46e23eb6912a603e74dd87`.
Both match the previous readiness report. Row-level results remain in the
git-ignored private audit file, not this report.

## Isolated verification, not browser acceptance

All 35 Node tests passed across:

- `scripts/audit-bnms-renewal-readiness.test.mjs`
- `api/_lib/formMembershipRenewalEvidence.test.mjs`
- `api/_lib/formExpiryOnlyRenewal.test.mjs`
- `api/_lib/formMembershipRenewalContext.test.mjs`

All four `MembershipPaymentField.test.jsx` component tests passed using
`node scripts/run-isolated-tests.mjs node --import tsx --test
client/src/components/forms/MembershipPaymentField.test.jsx`.

These verify evidence admission, assigned-policy handling, date boundaries,
inclusive windows, disabled-gate context and component attestation rendering.
The audit's gate-open adapter is memory-only and stops before pricing.
Neither it nor the component fixtures constitutes a gate-open acceptance
environment or proof that the real authenticated FormView preserves those values.

## Disposable local FormView browser acceptance

Run `node scripts/run-bnms-renewal-acceptance.mjs`.

Six Playwright/Chromium tests passed against the **actual application FormView**
route and Membership Payment component:

- Synthetic signed-in member automatically supplies the fee-request identity,
  without a member ID in the browser URL.
- The real context loader selects the exact assigned configuration ID and
  requests pricing at the original expiry plus one day.
- Grace-period entry on 5 October retains expiry 25 September 2026 and successor
  26 September 2026–25 September 2027. The browser displays the original expiry,
  successor dates, and explicit administrator-attestation/unknown-start wording.
- Inclusive 90/90 boundaries: 26 June closed, 27 June open, 24 December open,
  25 December closed. Every browser case retains the original successor boundary.
- With the gate closed, the actual context loader returns `joining`,
  `renewalChoicesUnavailable: true`, and no renewal pricing request. The browser
  renders the ordinary membership card without the renewal summary.

**Important disabled-gate distinction:** the application intentionally preserves
legacy joining behavior. The GET handler falls back to its ordinary simulator
when renewal context says `joining`; the component does not treat
`renewalChoicesUnavailable` as a payment prohibition. Do not describe rollout-off
as blocking all membership purchases. This test records that behavior; it does
not attempt a live joining payment or establish that such payment would succeed.

### Isolation and limits

- The runner creates a credential-stripped process; dotenv is disabled.
- A loopback-only Vite server serves the real application. No application API
  server or database is started. Server closes after the suite.
- Browser auth and fee HTTP responses are synthetic. The shared renewal-context
  loader runs against an in-memory read-only adapter; pricing is an explicit
  £120 stub with assertions on assigned configuration and start date.
- All external browser requests are aborted. All mutations are rejected,
  including the shell's expected last-activity PATCH. Unexpected mutations fail
  the tests. No provider, form-submit, quote, reservation or financial operation
  is allowed.
- These are full-page UI fixtures, **not** end-to-end server authentication,
  payment-handler integration, real pricing acceptance, database election races
  or GoCardless sandbox evidence. The provider options are deliberately absent.
- The synthetic assignment table is unchanged after context evaluation.
  Screenshots are temporary local files, not retained production evidence.

## Remaining live release requirements

1. Use an explicitly authorized BNMS test-member login to exercise the deployed
   FormView path with the live gate disabled. Verify the actual rendered state
   and network response, including whether the disabled response falls through
   to ordinary joining UI. Do not create a quote or submit payment.
2. The operator-selected disposable local substitute above passes. If a
   production-equivalent authenticated staging acceptance is required for
   release, it still needs an authorized test account and isolated backend.
   The local browser's synthetic session is not a credential for a live member.
3. Reuse existing Direct Debit sandbox work (task 3134), rather than creating
   another provider run. Its evidence must cover actual bank-day scheduling and
   payment-method switching as required by the guide. The existing
   `scripts/gocardless-sandbox-proof.mjs` creates provider objects and was
   deliberately **not run** under this read-only authorization.
4. Once these requirements pass, rerun the readiness audit and request explicit
   **BNMS-only** rollout approval. Do not enable the global gate.

No production authenticated test session was supplied. No new Direct Debit
sandbox task was created or provider run duplicated. This report is the handoff
to the existing sandbox work, not a claim its outstanding checks passed.
No rollout approval is requested solely on the public or synthetic browser checks.

## Changes and migration status

Only the local test harness and this report were added. No application code,
membership histories, assignments, gate settings, provider
objects or financial records were changed. No migrations were needed or applied
to any database in this review. The required DEST expiry-only capability is
already present. No additional migration is indicated by these checks.
