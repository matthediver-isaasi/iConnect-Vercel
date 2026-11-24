// Runtime composition only: never import this into the dry-run capability graph.
export const proposalMembershipEnabled = () => process.env.PROPOSAL_MEMBERSHIP_ENTITLEMENTS_ENABLED === 'true';
