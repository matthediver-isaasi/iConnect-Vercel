---
name: AI V2 visual validation & repair loop
description: Phase 3 validate/repair stages in generate-v2 — candidate versions, skip semantics, rejection cleanup invariants
---

- **Candidate-version pattern:** the code stage persists the version WITHOUT setting `current_version_id`; only the validate stage's pass branch promotes. A failed generation can therefore never replace a valid current version — rejection cleanup (`buildRejectionCleanup`) deletes only the job's own candidate ids (filtered against current) and deletes the composition shell only when this job created it (guarded with `.is('current_version_id', null)`).
- **Skip ≠ fail:** unconfigured/failed Browserless captures and unconfigured/timed-out AI reviews are `skipped` and pass validation. Infrastructure trouble is never evidence of a bad design. Only browser-measured blocking issues or blocking review findings can trigger repair/rejection.
- **Judgement stays in Node:** the Browserless `/function` script only measures (rects, fontSize, overflowX, ancestors, section child heights); all thresholds live in pure `inspectBreakpointMetrics` so every check is unit-testable with fabricated metrics. Ancestor lists are captured in-page so the overlap check can skip parent/child pairs without DOM access.
- **Repair loop:** max cycles via `AIC_MAX_REPAIR_CYCLES` (default 2); a repair that fails the sanitise pipeline/gates consumes a cycle and its errors feed the next prompt. Repair prompts prefer the stored UNSCOPED model CSS (`rawCss` kept in job state) so the model never has to strip scope prefixes.
- **Vision inputs:** same-invocation screenshots are sent as data URLs (buffers kept in a closure map) — do not rely on media-library URLs being fetchable by OpenAI; stored URLs are used only for later-invocation repair prompts and the audit trail.
