---
name: AI Composition quality gates
description: Deterministic post-generation gates + screenshot review stage for canvas AI compositions
---

- Deterministic gates (plan contract, prompt fulfilment, layout inspection, postcss CSS check) run in `runDocumentAttempt` after schema validation; failures feed the existing bounded retry loop as feedback strings prefixed `[gate] `; report stored on `generationMetadata.qualityGates`.
- Layout geometry is only judged on breakpoints the model actually authored (`desktop` always; tablet/mobile only when `doc.layouts[bp][id]` exists) — inherited desktop frames must never fail a smaller breakpoint.
- Screenshot review is a separate `review` pipeline stage AFTER the version is saved and usage metered. It NEVER fails the job: verdict stored on `validation_result.gates.screenshotReview`; a `fail` verdict only blocks Insert client-side. Any infra problem (no browserless token, no vision, capture error, unreadable response) degrades to `skipped` = non-blocking.
- **Why the wall-clock budget:** review runs inside one serverless invocation; sequential 20s captures × 3 breakpoints could breach the function timeout. Captures run in parallel and race a hard 35s budget (`budgetMs` param, testable); budget exhaustion → `skipped`, never a hung invocation.
- **How to apply:** any new gate must either be deterministic-and-retryable (goes in aiCompositionQualityGates.js) or advisory-and-never-blocking (goes in the review stage with skip semantics + budget).
