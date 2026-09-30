---
name: Quality-gate retry loops need the bar in the initial prompt
description: Post-hoc rejection gates + retry feedback alone don't converge; state the quantitative bar up front and feed back measured deltas.
---

**Rule:** any deterministic quality gate (size floors, required layout/imagery) enforced after generation must ALSO be stated in the initial generation prompt, and retry feedback should include the previous attempt's measured values next to the required floors — not just the rejection text.

**Why:** V2 page generation failed all attempts on the anti-bland gates: the model's first output was a thin skeleton because the prompt never mentioned the floors, and terse rejection strings didn't tell it how far off it was. Adding the bar to the prompt + measured-size retry feedback (and one extra retry for pages) was the fix.

**How to apply:** when adding or tightening a gate in `runCodeRejectionGates` (or similar), update the matching prompt rules in the same change, and check the retry block carries concrete numbers. Prompt rules and gates are a matched pair (see also ai-composition-gate-reconciliation.md).

**Plan-stage copy budget:** when a pipeline has a plan stage feeding a code/render stage with a size gate, the plan is the content ceiling — gate copy depth AT THE PLAN (cheap retries with exact numbers) instead of letting every code retry fail the size gate. Scale total floors by sections that actually carry copy (slot/component sections exempt) or slot-heavy pages false-reject.
