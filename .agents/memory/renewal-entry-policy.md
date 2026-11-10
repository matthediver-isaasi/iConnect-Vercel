---
name: Renewal entry policy
description: Tenant choice between same-schedule renewal and questionnaire-led reassessment.
---

BNMS requires members to answer eligibility questions before being routed to the
appropriate renewal form. A previous membership schedule must not determine the
renewal destination or bypass this reassessment.

**Why:** The owner states members' circumstances can change; BNMS wants the
renewed schedule to reflect their current situation. Other tenants may explicitly
choose continuation on the same schedule.

**How to apply:** Support a tenant-configured renewal entry form, independently
of the final payment form or schedule. Preserve the original term as evidence
for grace/late-renewal dates while validating the questionnaire-selected successor
schedule. Category changes at renewal are not mid-term amendments. Do not silently
fall back to the previous schedule when a destination is unavailable. The owner
identified form 090be663-5429-4e46-b6ee-d824d37d6d3b as BNMS's entry questionnaire;
verify its current configuration before modifying it.

The owner is preparing the remaining category renewal forms separately; testing
currently focuses on Full and Full Junior. Do not expand renewal-entry routing
work into creating category forms or adding temporary incomplete-category flows.

**Why:** The owner explicitly excluded that work from this implementation.

BNMS's approved entry policy distinguishes four states: public new applicants
use Getting Started (ab2d6278-686c-4604-be28-05d4bb328e03); authenticated
never-held accounts and eligible post-grace former members use Continuing
(7e263a45-ad57-4404-bc18-05288fd52ec9); eligible open-window and within-grace
renewals use Renewing (090be663-5429-4e46-b6ee-d824d37d6d3b).

**Why:** The owner approved separate public joining, existing-account joining,
and ordinary renewal journeys. This supersedes the earlier direction to send
signed-in guests to Getting Started.

**How to apply:** Verify live contracts before configuration. Preserve public
joining and existing-account authentication; signed-out visitors are not
necessarily new accounts. Destination selection never grants purchase
authority or financial-history access. A shared Continuing entry must not
classify a former member's restart as a new-applicant purchase, and branch
changes must preserve category-specific questions and approval.

Keep the portal Payment Details card visible even when no payment arrangement
or eligible action is available.

**Why:** The owner explicitly retired the legacy auto-hide behaviour; the card
must communicate the member's state rather than disappear after loading.

**How to apply:** Gate joining/renewal/payment actions independently using verified
eligibility. Missing payment evidence must not hide the entire card or grant an action.

Associate renewal must respect the Associate join form's primary-organisation-only
questions. Do not copy the Full/Full Junior trust, department or secondary-site questions.

**Why:** The owner clarified that “same renewal process” means prefill and safe
affiliation updates for the fields that exist, not identical questionnaires.

**How to apply:** Configure only the represented affiliations and preserve each
membership category's questions and schedule mappings.

When converting a join form to explicit renewal schedule mappings, verify the
schedule's category match rather than trusting the join field's default schedule.

**Why:** A Trainee join copy retained a Full-member default while its legacy
automatic rule selected Trainee. Copying that default into an explicit mapping
changed the intended category.

**How to apply:** Check tenant, member scope, class field and exact class match
before saving a mapping; ambiguous matches require review.

BNMS Student memberships are free and their term length is defined by the
member's course end date, not an assumed annual paid term.

**Why:** The owner explicitly stated this business rule when requesting investigation
of member-date-based schedule expiry.

**How to apply:** Preserve the existing student questions and date evidence.
Implement this through generic schedule configuration, not a BNMS-only rule.
Students must use the normal renewal questionnaire when their term ends; it may
route them into another membership class rather than another Student term.
An administrator changing the course end date must be handled as an audited
manual membership extension, not an automatic renewal.

**Why:** The owner clarified that Student membership has the same renewal
requirement as other classes, and administrative course extensions are distinct.

**How to apply:** Do not automatically roll Student memberships forward. Audit
existing Student-class members for supporting term-date evidence before
reconstructing their memberships; class alone is not evidence of valid dates.

Date-field terms are initially limited to no-charge individual schedules.
Paid schedules and instalments must not inherit this mode implicitly.

**Why:** An arbitrary course end is not a fixed-month financial commitment;
adapting paid terms requires separate consent, pricing and collection design.

**How to apply:** Keep standard paid schedules unchanged. Form-based no-charge
activation must be explicit, follow completed processing/required approval,
and never retroactively activate old submissions merely because a form setting
was enabled. A repeated form must not silently extend an existing term.
