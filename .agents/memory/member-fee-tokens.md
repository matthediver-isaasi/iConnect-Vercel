---
name: Member-driven membership fee tokens
description: How the public membership-fee link supports individual (member) memberships alongside organisations.
---

# Member-driven membership fee tokens

`membership_fee_token` rows carry EITHER `organization_id` OR `member_id` (org column is nullable since the member rollout; legacy deployments are healed at runtime by `ensureMemberTokenColumns` and by `scripts/apply-member-fee-token-migration.mjs` on DEST).

Rules:
- Every consumer of a fee token must branch on `member_id` (the `isMemberToken` flag in the public token API): history table (`member_membership_history` vs `organisation_membership_history`), invoicing table, notes (`member_note` vs `organization_note`), sim (`simulateMembershipForMember` vs `...ForOrg`), config resolver, invoice address resolver entity type.
- Recipient for member tokens is the member's own email; token idempotency/reuse is keyed on (tenant, member, year).
- The workflow "Create Membership" action routes member entities with NO `organization_id` and a matching member-scoped config (`getConfigForMember`) to the member path; members with an org stay on the org path.
- **Why:** org-shaped assumptions (tier recipients, add-on lines, org notes) silently break or leak when applied to individual members.

Direct Debit from the fee page:
- `start_direct_debit` token action mirrors `/api/membership/direct-debit` start, but ADOPTS an existing unpaid non-DD history row (links agreement, flips payment_method) instead of refusing — workflow-recorded fees arrive as unpaid rows with a raised invoice. Refuse only when paid / has a Stripe PI.
- DD card only shows when tier `dd_enabled` AND `resolveDdOffer` returns non-null (needs a configured monthly amount) AND tenant has GC creds; hosted flow redirects back to `/membership-fees/{token}?dd=complete|cancelled`.
