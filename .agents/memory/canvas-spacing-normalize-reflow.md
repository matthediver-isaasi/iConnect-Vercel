---
name: Canvas spacing normalize — reflow & idempotent band re-fit
description: How to safely normalize vertical rhythm on absolutely-positioned canvas pages, and the non-obvious rule that band membership must be cluster-based to stay idempotent.
---

Older hand-built BNMS canvas pages store every block absolutely positioned
(`bp.desktop.{x,y,w,h}`), so "fix the vertical rhythm" means REFLOWING `y`, not
editing flow layout. A safe normalize (no copy/image/link/block-type/order
changes) mutates only geometry: block `desktop.{x,y,w,h}`, hero/colour-band `h`,
style paddings, divider thickness.

**Cluster-preserving reflow.** Group tightly-coupled blocks (columns, card
grids, icon+heading+divider stacks, overlaps) into rigid CLUSTERS via a gap
threshold (~40px). Preserve each cluster's internal offsets; only re-stack whole
clusters top-to-bottom with canonical gaps (gap-after-hero vs section-gap). Snap
opening/closing hero heights; then re-fit each colour band around its content.

**Why band re-fit must be CLUSTER-based, not per-block (the idempotency trap):**
Deciding which blocks a colour band wraps by a per-block top-edge or even
per-block vertical-midpoint test is NOT a fixed point. After a re-fit the band
gains inner padding on both sides; on the next pass a neighbouring block that
merely abuts that padding flips in/out of the "inside" set, so the script keeps
producing edits forever (non-idempotent). Fix: assign whole CLUSTERS to a band
by testing the CLUSTER midpoint against the band box. Cluster membership is
stable across passes (intra-cluster gaps preserved, inter-cluster gaps become
the canonical constants, so the same clusters re-form), which makes the re-fit a
fixed point. Bonus: an overlapping neighbour that clusters WITH band content
travels with the band instead of flip-flopping.

**Verification before writing to prod.** Two independent checks per page:
(1) content-preservation — deep-compare before/after after STRIPPING volatile
geometry (`desktop.x/y/w/h`, `style.padding*`, divider `content.thickness`) and
assert block id/type/order unchanged; (2) idempotency — run the transform twice
and assert the second pass yields zero edits. Also assert no negative `y`.

**Apply-script safety contract (reused pattern):** dry-run by default, write only
with `--apply`; snapshot each page's design to
`scripts/backups/<feature>/<RUN_TS>/<slug>.json` + `manifest.json` BEFORE writing;
re-verify content-preserved + idempotent immediately after each write; provide
`--restore --from=<run> [--slug=]` and `--list-backups`. Approved slug set comes
from a report bucket, re-validated through the same in-scope predicate the
scanner uses (keep them mirrored).
