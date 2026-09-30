import { supabase } from './database.js';
import { createDiscountHelper } from './discountHelperCore.js';
export const evaluateDiscountsForEntity = (...args) => createDiscountHelper(supabase).evaluateDiscountsForEntity(...args);
export const evaluateDiscountsForOrg = (...args) => createDiscountHelper(supabase).evaluateDiscountsForOrg(...args);
export const applyDiscountsToAnnualCost = (...args) => createDiscountHelper(supabase).applyDiscountsToAnnualCost(...args);