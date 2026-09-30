import { supabase } from './database.js';
import { createVatOverrideHelper } from './vatOverrideHelperCore.js';
export const evaluateVatOverrideForOrg = (...args) => createVatOverrideHelper(supabase).evaluateVatOverrideForOrg(...args);
export const evaluateVatOverrideForMember = (...args) => createVatOverrideHelper(supabase).evaluateVatOverrideForMember(...args);