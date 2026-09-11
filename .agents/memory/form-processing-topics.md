# Form processing topics

- [Paid-form pipeline baseUrl](paid-form-pipeline-baseurl.md) — server-driven finalize paths (webhook/cron) must resolve a tenant-trusted baseUrl or entity pipelines are skipped.
- [Form validation across payment paths](form-validation-payment-paths.md) — new submission constraints must guard normal submissions and every paid quote/create path.
- [Form cross-tenant org guard & rollback pitfalls](form-crosstenant-write-guard.md) — org writes need write-time tenant filters (stale bundles bypass resolution fixes); public path rollback DELETES the submission + notes.
- [Form processor tenant scoping](form-processor-tenant-scope.md) — body tenant_id is client-controlled; resolve tenant from persisted form/submission BEFORE any tenant-scoped query, reject mismatches 403.
- [Reactive form prefill ownership](reactive-form-prefill-ownership.md) — configured defaults are replaceable only at their captured initial value; drafts, transitions, and respondent edits always win.
- [Replacing required relationship owners](required-relationship-owner-replacement.md) — required many-to-one owner edges need one atomic DB operation; sequential REST replacement cannot preserve invariants.
- [Structured form action retry state](structured-form-action-retry-state.md) — failed or already-running actions keep public/paid processing incomplete until every invocation reaches a safe terminal state.