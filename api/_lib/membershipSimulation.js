import { supabase } from './database.js';
import { createMembershipSimulator } from './membershipSimulationCore.js';
export const resolveRollingSimulationContext = (...args) => createMembershipSimulator(supabase).resolveRollingSimulationContext(...args);
export const simulateMembershipForOrg = (...args) => createMembershipSimulator(supabase).simulateMembershipForOrg(...args);
export const simulateMembershipForMember = (...args) => createMembershipSimulator(supabase).simulateMembershipForMember(...args);