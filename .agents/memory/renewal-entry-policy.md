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

BNMS uses a different questionnaire for first membership:
ab2d6278-686c-4604-be28-05d4bb328e03. Verify the form before configuration.

**Why:** The owner distinguishes new-member questions leading to join forms from
renewal questions leading to renewal forms. Never substitute the renewal entry
as a fallback for joining.

**How to apply:** Keep the two settings independent. A signed-in guest can use
the public joining questionnaire without changing that form's public access or
granting the guest financial-history permission.
