---
name: AI composition gate reconciliation
description: Quality gates vs plan/prompt contradictions in AI Design Studio generation — self-inflicted plan promises must not fail the job.
---

# AI composition quality gates vs the plan's own promises

**Rule:** Quality gates that enforce promises the pipeline made to ITSELF (plan contract: card recipes, componentFamilies, requiredAssets) must be reconcilable on the final retry — accept the draft with warnings and a downgraded contract. Only genuine defects (layout/CSS breakage, things the AUTHOR's brief actually asked for, missing desiredAction CTA) stay fatal.

**Why:** Prod generation jobs burned all retries failing `plan_contract` / `prompt_fulfilment` gates on over-promises the plan stage invented. Worst case, the document prompt FORBADE links while the `missing_real_cta` gate REQUIRED a link-based CTA — a contradiction invisible in tests because fixtures carried links.

**How to apply:**
- When adding a gate, ask: "can the prompt that produced this document actually satisfy it?" Prompt rules and gate requirements must be checked as a pair.
- Fixtures that pre-satisfy a gate hide prompt/gate contradictions — add a test that the prompt permits what the gate demands.
- Reconciliation lives in `reconcileQualityGateFailures` (aiCompositionQualityGates.js), invoked from `runDocumentAttempt` at final attempt; result recorded in `generationMetadata.qualityGates.reconciled`.
- Links in generated docs: record ids are verified server-side (`stripUnverifiedRecordLinks` before validation; document stage receives only `state.records`). The auto-generated plan must be `sanitizePlan`-ed BEFORE persisting (not just on the plan-review resume path) or contract caps never apply.
