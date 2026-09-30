export function validateWorkflowOrganizationMembershipSimulation(simResult) {
  if (!simResult?.org?.id) return 'Membership simulation did not return an organisation';
  if (!simResult?.config?.id) return 'Membership simulation did not return a membership configuration';
  if (!simResult?.membershipYear?.label) return 'Membership simulation did not return a membership year';
  if (simResult.config.pricing_model !== 'flat' && !simResult?.matchedBand?.id) {
    return 'Membership simulation did not return a pricing band for a tiered configuration';
  }
  return null;
}