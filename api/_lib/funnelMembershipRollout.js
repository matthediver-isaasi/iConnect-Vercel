// Rollout gate for event-funnel complimentary membership benefits.
export const funnelMembershipEnabled = () => process.env.EVENT_FUNNEL_MEMBERSHIP_ENTITLEMENTS_ENABLED === 'true';
