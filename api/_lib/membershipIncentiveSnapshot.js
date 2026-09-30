// Freeze the joining schedule in an existing JSON column. Renewal schedules
// must never be used to reconstruct an original new-member entitlement.
export function membershipIncentiveSnapshot(sim) {
  const incentiveConfig = sim.incentiveConfig || sim.config;
  if (sim.yearNumber !== 1 || !incentiveConfig) return {};
  return {
    commitment_snapshot: {
      config: structuredClone(incentiveConfig),
      amounts: { annual_cost: sim.annualCost },
    },
  };
}