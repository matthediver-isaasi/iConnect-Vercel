# Membership Schedules — How Pricing Works

This document explains how membership schedules calculate fees, apply discounts, handle new joiners, and transition between membership years.

---

## 1. What Is a Membership Schedule?

A membership schedule is a configuration that defines how membership fees are calculated for an organisation or individual member. Each schedule includes:

- **Annual fee** — either a flat rate or a set of pricing bands
- **Membership year** — the start month and day (e.g. 1st April), which determines the annual cycle
- **Currency** — the currency used for invoicing (e.g. GBP)
- **VAT settings** — default tax treatment applied to invoices
- **Incentives** — optional free periods or percentage discounts for new joiners
- **Pro-rata** — whether partial-year fees apply when joining mid-year
- **Rollover** — whether unused free period carries into the following year

A schedule can be scoped to organisations (where the organisation pays) or to individual members (where the member pays directly).

---

## 2. Schedule Structures

Different types of organisation can be assigned to different schedules. This is done through **structure matching**: each schedule can be linked to a custom field (e.g. "Organisation Type") and a specific value (e.g. "Charity"). When the system calculates fees, it reads the organisation's field value and selects the schedule that matches.

- If only one schedule exists with no structure field, all organisations use that schedule.
- If multiple schedules exist with structure matching, the system picks the first one whose field value matches.
- If no match is found, the system reports an error — it does not fall back silently.

---

## 3. Pricing Bands

When a schedule uses **banded pricing** (rather than a flat rate), the annual fee depends on a field value — typically the number of members in the organisation.

Each band defines a range (e.g. 1–10, 11–50, 51–100) and an annual cost. The system reads the organisation's current field value, finds the band whose range it falls into, and uses that band's annual cost.

If no band matches the current field value, the calculation stops with an error.

**Flat-rate pricing** is simpler: the schedule defines a single annual cost that applies to everyone, regardless of field values.

---

## 4. Custom Discounts

Schedules can include **conditional discount rules** that reduce the annual fee based on an organisation's field values. For example:

- If "Country" equals "Republic of Ireland", apply a 20% discount
- If "Region" equals "Scotland", apply a fixed £50 discount

These rules are evaluated in order. Multiple rules can match and stack — percentage discounts and fixed discounts are totalled separately, then both are subtracted from the annual cost.

Custom discounts are applied **before** any pro-rata or free period calculations. This means the daily rate used for pro-rata is based on the already-discounted annual cost.

---

## 5. Year 1 — New Organisations

When an organisation joins for the first time, two mechanisms may reduce their first-year fee:

### 5a. Pro-Rata

If pro-rata is enabled on the schedule, the system calculates a daily rate:

> **Daily rate** = (Annual cost after discounts) ÷ (Total days in the membership year)

It then counts the number of days from the join date to the end of the membership year, and charges only for those days:

> **Pro-rata cost** = Daily rate × Remaining days

### 5b. Free Period

If a free period is configured, the organisation receives a period of free membership starting from their join date. This can be defined in two ways:

**Time-based** (e.g. 3 months free):
The system converts the free period into days and subtracts those free days from the remaining days:

> **Billable days** = Remaining days − Free period days
> **Final cost** = Daily rate × Billable days

If pro-rata is also enabled, the free period days are limited to the remaining days in the year — they cannot exceed the pro-rata period.

**Percentage-based** (e.g. 25% off):
The system calculates the full-year discount amount, then pro-rates that discount in proportion to the days remaining in the year:

> **Full discount** = Annual cost × Percentage
> **Pro-rated discount** = Full discount × (Remaining days ÷ Total days in year)
> **Final cost** = Pro-rata cost − Pro-rated discount

### 5c. No Pro-Rata, With Free Period

If pro-rata is disabled but a free period is configured, the free period discount is applied to the full annual cost:

- **Percentage**: The percentage is applied directly to the annual cost.
- **Time-based**: Free days are subtracted from the total days in the year, and the daily rate is used to calculate the discount.

---

## 6. Year 2 — Free Period Rollover

If the free period was not fully used in Year 1 (because the organisation joined late in the year), the unused portion can **roll over** into Year 2. This only happens when the **rollover** setting is enabled on the schedule.

If rollover is disabled, Year 2 is charged at the full annual cost with no free period benefit.

### 6a. Time-Based Rollover

The system calculates how many free days were used in Year 1 and subtracts them from the total free period. The remaining days become a discount in Year 2:

> **Spillover days** = Total free period days − Days used in Year 1
> **Year 2 discount** = Daily rate (Year 2) × Spillover days

### 6b. Percentage-Based Rollover

The system calculates what proportion of the full percentage discount was consumed in Year 1 (based on the pro-rata proportion). The remainder is applied in Year 2:

> **Year 1 used** = Full discount amount × (Year 1 remaining days ÷ Year 1 total days)
> **Spillover** = Full discount amount − Year 1 used
> **Year 2 final cost** = Annual cost (Year 2) − Spillover

### Important Note

The rollover discount is calculated using **Year 2's pricing**, not Year 1's. If prices have changed between years, the daily rate used for the spillover calculation reflects the current year's annual cost. The rollover represents "time still owed" rather than "money still owed."

---

## 7. Year 3 and Beyond

From the third membership year onwards, no pro-rata, free period, or rollover discounts apply. The organisation is charged the full annual cost (after any applicable custom discounts and overrides).

---

## 8. VAT and VAT Overrides

Each schedule can have a default VAT treatment applied to invoices. This may come from the pricing band configuration or the flat-rate setup.

Additionally, schedules support **VAT override rules** — conditional rules that change the VAT treatment based on a field value. For example:

- If "Country" is not "United Kingdom", apply zero-rated VAT

VAT overrides are evaluated after the cost calculation is complete. They affect only the tax treatment on the invoice — they do not change the fee amount itself.

For organisation-scoped schedules, the override checks the organisation's custom field values. For member-scoped schedules, it checks the member's preference values or core fields (e.g. country).

---

## 9. Schedule Versioning

When pricing needs to change (e.g. annual fee increases), a new version of the schedule is created:

- The old schedule is archived by setting an **effective end date** (`effective_to`)
- The new schedule is created with no end date, making it the active version

The system always uses the **currently active schedule** (the one with no end date) when calculating fees. It does not look back at which schedule was active when an organisation first joined.

Once a membership year has been invoiced, the fee, schedule, and band details are recorded in the membership history. This provides a permanent audit trail of what was charged, regardless of future schedule changes.

---

## 10. Manual Overrides

Administrators can apply per-organisation overrides that take precedence over the standard schedule calculation. There are three types:

### Price Override
Sets a specific annual cost, bypassing all band matching, custom discounts, pro-rata, and free period calculations entirely. The override amount is used as the final cost.

### Discount Override
Replaces the standard custom discount rules with a single manual discount (either percentage or fixed amount). The discount is applied to the gross annual cost (before any other discounts).

### Structure Override
Reassigns the organisation to a different schedule and optionally a specific band within that schedule. The system recalculates using the override schedule's pricing and discount rules.

Overrides can be set for a specific membership year or applied globally (no year specified). Year-specific overrides take priority over global ones.

---

## 11. Invoicing

When a membership is renewed (either manually or by the automated renewal process), the system:

1. **Creates a membership history record** — capturing the membership year label, final cost, schedule used, band matched, and any overrides applied
2. **Generates an invoice via Xero** — including the calculated fee, VAT treatment, a descriptive line item, and the organisation's invoicing address
3. **Adds an organisation note** — documenting the renewal for audit purposes

The invoice line item includes the membership year label, tier/band name, and the final fee. The invoice reference follows the pattern "Membership 2025/2026".

### Invoice Settings

- **Account code**: Configurable per tenant (defaults to the general sales account)
- **Invoice status**: Configurable (e.g. DRAFT or AUTHORISED)
- **Due date**: Set to 30 days from the invoice creation date
- **Invoice address**: Resolved from a configurable field on the organisation or member, with fallback to the schedule's default address field

### Invoicing Modes

Renewals can operate in two modes:

- **Scheduled**: The system automatically renews at the membership year start date and generates the invoice on a separately configured invoice date
- **Manual**: An administrator triggers the renewal and invoice generation on demand

---

## 12. Potential Gaps — For Review

The following areas may warrant further discussion to confirm they align with business expectations:

### 12a. Rollover Uses Current Year Pricing

When free period days spill over from Year 1 into Year 2, the daily rate used to calculate the Year 2 discount is based on **Year 2's annual cost**, not Year 1's. If the annual cost increased between years, the rollover discount will be worth more in monetary terms than the equivalent free days would have been in Year 1.

**Question**: Should the rollover discount be calculated using the pricing that was in effect when the organisation joined (Year 1), or is using the current year's pricing the intended behaviour?

### 12b. Schedule Resolution Always Uses the Active Version

When calculating fees, the system always selects the schedule that is currently active (no end date). It does not consider which schedule was active when the organisation first joined or when they were last invoiced.

This means that if an organisation's pricing band thresholds change between schedule versions, an existing organisation could shift to a different band without any explicit action — simply because the new schedule's bands have different ranges.

**Question**: Is this the intended behaviour, or should organisations be "locked in" to the schedule version that was active at the time of their original application or most recent renewal?

### 12c. Year 1 Free Period Not Gated by Rollover Setting

In Year 1, the free period discount is always applied if the schedule has a free period configured — regardless of the rollover setting. The rollover setting only controls whether unused free period carries into Year 2. This is likely correct behaviour (the free period is a joining incentive, rollover is a separate decision about spillover), but it is worth confirming.

**Question**: Is it correct that the free period always applies in Year 1 even if rollover is disabled? Or should disabling rollover also disable the free period entirely?
