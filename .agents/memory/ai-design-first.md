---
name: AI V2 design-first workflow
description: Phase 6 visual-proposal → approve → deconstruct → code gen with similarity gate; hard invariants.
---

- The approved visual concept is NEVER authoritative for content: deconstruction into a layout blueprint strips URLs/emails/quoted copy and whitelists structural fields only; content still comes from manifests/plan.
  **Why:** concept mockups contain hallucinated placeholder text/prices; transcribing them would ship fabricated facts.
  **How to apply:** any new field added to the blueprint must go through the sanitizer whitelist; the code prompt restates "THE VISUAL IS NOT AUTHORITATIVE FOR CONTENT".
- Screenshot-vs-concept similarity is a soft gate: below threshold → bounded repair cycles (own budget, separate from functional repair budget), budget exhausted → deliver with WARNING. Similarity alone must never reject a build; skipped compare always passes.
- The generation job pauses at status `awaiting_visual` (not `running`), so the in-flight lock (which checks `running`) doesn't block resume; client resumes via `visualAction: approve|revise`.
- Unref'd budget timers (correct so serverless invocations aren't held open) mean tests simulating a timeout must keep the event loop alive with a real timer, or node:test reports "promise resolution still pending".
