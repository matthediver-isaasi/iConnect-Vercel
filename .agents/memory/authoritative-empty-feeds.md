---
name: Authoritative empty feeds
description: Safety rule for feeds where an empty success causes downstream data to be cleared.
---

If a successful empty feed is authoritative and causes a consumer to clear saved
data, the producer must preserve three states: populated, confirmed empty, and
load failure. Never convert a query, seed, permission, or configuration failure
into the same empty array used for an intentional empty selection.

**Why:** A downstream consumer may correctly treat `[]` as an instruction to
delete its last-known-good data. A fail-open loader can therefore turn a
transient backend fault into a public data-loss incident while still reporting
success.

**How to apply:** Require positive evidence for intentional emptiness (for
example a saved/seed marker). Throw or return a non-success response for all
ambiguous load failures, and have consumers retain their previous snapshot on
that failure. Test both confirmed-empty and backend-error paths end to end.

Optional mutation-capability readiness must not gate existing read-only lists
or statistics. Missing archive/delete support should disable those actions,
not show an unloaded campaign list as zero.

**Why:** An archive rollout made retained campaigns appear lost because list
and summary queries depended on the unapplied mutation migration.

**How to apply:** Keep read availability independent, with narrowly identified
legacy-schema compatibility. Preserve errors for unrelated failures and keep
destructive operations fail-closed until their database authority is installed.