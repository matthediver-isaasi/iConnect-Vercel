import { supabase } from './database.js';
import { createMembershipSimulator } from './membershipSimulationCore.js';
import { proposalMembershipEnabled } from './proposalMembershipRollout.js';
export const resolveRollingSimulationContext = (...args) => createMembershipSimulator(supabase).resolveRollingSimulationContext(...args);
export const simulateMembershipForOrg = (...args) => createMembershipSimulator(supabase, undefined, { proposalMemberships: proposalMembershipEnabled() }).simulateMembershipForOrg(...args);
export const simulateMembershipForMember = (...args) => createMembershipSimulator(supabase).simulateMembershipForMember(...args);