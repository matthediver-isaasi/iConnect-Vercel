---
name: Membership override display must not re-derive cost
description: org-membership card override path should only attach metadata; sim/records already applied the override.
---

# Org membership card overrides: never re-derive cost on the display path

The org membership tab (`api/membership/org-membership.js`) builds two year cards.
Every cost figure it serves already has any override applied **before** the
display code runs:

- `nextYearPreview` and the un-recorded current year come from
  `simulateMembershipForOrg` (the source of truth), which applies the override,
  the year-2 no-rollover rule, and VAT/total.
- the recorded current year reads saved `organisation_membership_history`
  values, written with the override applied.

**Rule:** `applyOverrideToYear` must only attach display metadata
(`overrideType`, note, discount type/value, config name, `originalAnnualCost`)
and then recompute VAT/total from the already-correct `finalCost`. It must NOT
recompute `annualCost`/`customDiscountTotal`/`freeDiscount`/`finalCost`.

**Why:** re-deriving applied the override twice. The percent/free-period
incentive (config `free_period_unit='percent'`) got re-added as a year-2
"rollover" that the simulation deliberately omits (sim sets `rolloverDiscount`
to 0 in year 2), and VAT/total were never recomputed — so the card showed a
lower Final Cost than the sim while VAT/Total still reflected the higher
pre-rollover figure (internally contradictory and divergent from the invoice).

**How to apply:** when any code path mutates a year card's `finalCost`, call
`recomputeVatForYear(yearData)` (VAT = round(finalCost × rate%, 2);
total = round(finalCost + VAT, 2) — same rounding as
`membershipSimulation.js`). The simulation is the source of truth for cost;
the card is a pure display of server-provided `finalCost`/`vatAmount`/`totalWithVat`.
