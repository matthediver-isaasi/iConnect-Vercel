import { supabase } from './database.js';
import { createMembershipSimulator } from './membershipSimulationCore.js';
import { proposalMembershipEnabled } from './proposalMembershipRollout.js';
import { funnelMembershipEnabled } from './funnelMembershipRollout.js';
export const resolveRollingSimulationContext = (...args) => createMembershipSimulator(supabase).resolveRollingSimulationContext(...args);
export const simulateMembershipForOrg = (...args) => createMembershipSimulator(supabase, undefined, { proposalMemberships: proposalMembershipEnabled(), funnelMemberships: funnelMembershipEnabled() }).simulateMembershipForOrg(...args);
export const simulateMembershipForMember = (...args) => createMembershipSimulator(supabase, undefined, { funnelMemberships: funnelMembershipEnabled() }).simulateMembershipForMember(...args);