// Provider metadata contract shared by creation, dispatch and ownership checks.
// Existing Checkout sessions, subscriptions and agreement snapshots use this
// value. `monthly_card_plan` was a classifier-only typo, not a legacy writer
// value; accepting it here would admit events the real processor cannot handle.
export const CARD_PLAN_KIND = 'monthly_card';