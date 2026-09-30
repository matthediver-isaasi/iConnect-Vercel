# Direct Debit dry-run capability coverage

## Security boundary

`POST /api/admin/gocardless-dd` with `action: "dry_run"` requires tenant admin access and, for role-based sessions, both Direct Debit and finance feature access. The request cannot select an execution mode, supply an evaluation time, or execute recorded operations.

The route installs `readonlyTenantDatabase` before loading the selected plan. Console eligibility excludes foreign tenants, missing/deleted/conflicting owners, non-GoCardless plans, and agreements whose GoCardless ownership is unproven. Console filtering is not added to historical cron selection.

The database capability exposes only allowlisted query methods, attaches an independent tenant predicate to ordinary reads, denies unselected execution, and exposes no RPC, mutation, storage, auth, schema, fetch, headers or raw query/client handles. All RPCs are denied rather than assuming a read-looking name is safe.

Two preference-value tables have no `tenant_id` column: `member_preference_value` and `organization_preference_value`. They receive an independent equality filter for the canonical owner ID established by the authorized route. Without that validated owner, access is denied; a caller-supplied foreign owner filter cannot replace the scope. The legacy VAT cache is another narrowly scoped exception: exactly `system_settings.setting_key = xero_vat_rates_<authorized tenant>` is allowed to use its tenant-specific key even where historical rows have no `tenant_id`. All other setting reads are tenant-scoped. Tests use tenantless fixture schemas and verify cross-owner/key isolation rather than inventing missing tenant columns.

Provider clients are resolved using production `gocardlessForTenant`, including the same credential lookup, environment/token validation and provider error handling. The resolver receives the guarded database. Only explicitly allowlisted resource reads and non-secret credential identity are exposed to shared orchestration. There is no provider client cache across previews. Successful and failed resource reads record evidence timestamps. Provider failures do not become empty data or permission to collect.

Recording effects append a serializable operation and throw `DryRunEffectBoundary`. They never return claim tokens, provider acceptances or fabricated persistence success. Internal dispatch payloads are removed from the HTTP response. The UI receives intended operation descriptions and amount/currency/date information supplied by the shared pipeline, not a live execution capability.

The renewal envelope is explicitly reported separately from per-owner applicability. Read-only tenant settings provide the configured UTC hour (the migration's parsing/default semantics), and current config/history rows provide discovery evidence. This is not a substitute for the discovery RPC or durable worker state. Migration `20260922_membership_renewal_cron_state.sql` revokes direct state-table access even from `service_role`; the state is returned only after acquiring the live lease. Preview therefore does not attempt to read/claim it. A billing opportunity must be registered and unfinished at the appropriate stage/cursor. New opportunities register after the scheduled hour; unfinished opportunities can resume before it; today's completed opportunity does not rerun. The trace explicitly distinguishes pause restart and expiry passes from this billing-hour/done gate. Actual global eligibility remains unknown, not merely batch placement.

Read failures and denied database capabilities are tracked outside the pipeline's exception handlers. If legacy helper code catches such a failure and falls back, that stage is still reported as unknown/error rather than presenting the resulting financial intent. Provider-read failures are likewise preserved. Each independent stage gets a new recorder and cloned plan/agreement/clock inputs; neither an earlier unperformed effect nor hypothetical input changes become another stage's assumed state.

## Interpretation boundaries

Each job evaluates independently with a server-captured time and fresh reads; this is not a transactionally consistent snapshot. Display order does not create a cross-job ordering. The preview performs no durable leases, reservations, progress/cursor updates, scheduled-task logging or heartbeat delivery.

Eligibility for a selected plan does not guarantee inclusion in a globally bounded next batch. Budget, ordering, competing tenants, leases and concurrent processing remain live-only constraints.

Execution stops at an operation whose result has not been obtained. Later claim-dependent reads, provider checks, accounting calls, membership/access changes and notices cannot be guaranteed. These are conditional continuations, not successful predictions. A job-level error is surfaced as an error, not as “no work”.

## Shared family entry points

- `directDebitRetryPipeline.runRetries`: production and preview share due selection, policy and canonical-plan reload, payment linkage/mirror construction, fresh mandate validation, prior-attempt evidence, stale/in-flight claim checks, and construction of the concrete claim payload. Live payment status revalidation remains after the actual claim and cannot be asserted by preview before winning it.
- `ddRenewalPipeline.runRenewals`: the live composition root and preview use `gocardlessDdRenewalsCore` with explicit capabilities. The pricing/configuration/discount/VAT simulation dependency graph takes an injected database; query mutations and lifecycle operations become serializable effects. The first intended database/email/subscription/activation effect stops recording. Failed reads are latched so a helper's legacy fallback cannot become confident financial intent.
- `gocardlessArrearsPipeline.runArrearsAccess` and `runArrearsMonthly`: independently recorded access-policy transition and idempotent monthly debt accrual. Collection after accrual is conditional on the resulting ledger and its later intent lease. One sweep's boundary does not hide the other sweep.
- `directDebitReconciliationPipeline.reconciliationStages`: stale agreements, missing subscriptions, subscription drift, stale payment obligations and failed accounting are evaluated with a separate recording interpreter per descriptor. Fresh resource reads and actual selection predicates precede effects. A recorded event replay or accounting posting is not proof its subsequent business effects will succeed.
- `directDebitDynamicPipeline`: separate dynamic completion, completion-notification and collection stages. Collection shares canonical reloads, lifecycle/hold/arrears checks, reservation lookup, fresh mandate notice checks and the concrete reservation/reauthorization payload. Locked authority checks, payment submission and attachment depend on a real winning reservation and are not executed.
- `directDebitOwnerPipeline`: owner pause restart, annual expiry, scheduled activation, payment-link reminders and rolling reminders are registered independently. `annualOwnerRenewalPipeline.runOwnerAnnualRenewals` selects the canonical owner's annual invoicing settings and invokes the same `runAnnualOwnerRow` used by the live cron. It constructs a concrete history insert or invoice before the recording boundary; follow-on workflows, accounting linkage, notices and notes depend on that operation's real result.

## Verification

- `directDebitDryRunRuntime.test.mjs`: database/client escape denial, provider method allowlist, fresh reads, evidence failures, tenant mismatch, stop-before-effect and cleanup/finally mutation traps.
- `directDebitDryRun.imports.test.mjs`: recursively inspects all preview-family imports; rejects raw database clients, direct network calls, environment/global escapes and unapproved external dependencies.
- `gocardless-dd.dry-run.test.mjs`: actual endpoint authorization before reads, identity/provider boundaries, repeated isolated calls, fresh retry-mandate evidence, retry claim construction, dynamic reservation reauthorization, independent arrears access/debt boundaries, provider failures and database/RPC/provider mutation traps.
- Existing console visibility and provider-boundary regressions are run with isolated fixtures.
- The focused isolated backend run covers the cron families, console boundary tests, shared pipelines, pricing/VAT, owner pause and annual expiry. Actual-endpoint tests additionally reach annual-owner history insertion and successor renewal pricing without changing data.

No database migration is introduced. No live cron, real collection, real provider mutation or rollback-based execution is used for verification.