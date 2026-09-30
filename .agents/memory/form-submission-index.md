# Form and submission topics

Focused index for durable form, submission, mapping, validation, and payment-entry rules:

- [Public form submission idempotency](public-form-idempotency.md) — dup guard = client key + unique index returning the ORIGINAL success payload + keyless 10s backstop; test endpoint in-process against DEST (local DB is pre-tenant).
- [Form submission emails](form-submission-emails.md) — exactly-once via atomic claim on form_submission.submission_email_state; all send paths must use the shared guarded sender.
- [Form prefill logged-in fallback](form-prefill-fallback.md) — prefill target: URL param > authed member/org via shared resolver; prefill effect must wait for member AND org custom values; embed iframe resolves auth via /api/auth/me itself.
- [Form processing topics](form-processing-topics.md) — paid-form pipeline, validation, tenant guards, prefill ownership, relationship owners, and retry state.
- [Form membership auto-resolve](form-membership-auto-resolve.md) — membership action resolve_mode='auto' picks the structure from the mapped answer vs match values; no-match = descriptive error, never £0; tierless classes hide the payment field.
- [Form relationship value security](form-relationship-value-security.md) — dependent option reads do not secure writes; revalidate every submit/amend path and scope label reads to persisted submissions.
- [Dependent form options](form-dependent-options-index.md) — authoritative filter rules, confirmed-empty states, and nested field parity across validation and output.
- [Form processing authorization boundary](form-processing-authorization-boundary.md) — record side effects require trusted/authenticated identity and persisted lifecycle/config checks before execution.
- [Member category form mappings](member-category-form-mappings.md) — category answers target explicit member categories; validate tenant definitions and diff only each mapped destination.
- [Form answer-driven role assignment](form-answer-driven-role-assignment.md) — answers select only persisted role mappings; configuring them requires role-assignment authority, and they are create-only.
- [Conditional form transitions](conditional-form-transitions.md) — persist only action IDs/mappings; server re-verifies rules and destination access, while assignment/draft context stays source-scoped.
- [Form answer lifecycle](form-answer-lifecycle-index.md) — scalar row sources, temporal validation, retained derived labels, and hidden-answer authority.
- [Composite form mapping components](composite-form-mapping-components.md) — extract a selected scalar before transforms in every mapping path; fallback must inspect that exact scalar.
- [Form author schema discovery](form-author-schema-discovery.md) — schema visibility is not record access; preserve author gates and explicit field denials in respondent-facing metadata.
- [Paid form DD eligibility](paid-form-dd-eligibility.md) — prospective eligibility must survive checkout retries without backfilling historical submissions; ambiguous external effects cannot be blindly replayed.