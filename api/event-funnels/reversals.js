import {supabase} from '../_lib/database.js';
import {getTenantContext,hasAdminAccess,hasFeatureAccess} from '../_lib/tenantContext.js';
import {createFunnelReversalHandler} from '../_lib/eventFunnelReversalHandler.js';
export const config={maxDuration:60};
export default createFunnelReversalHandler({db:supabase,getTenantContext,hasAdminAccess,hasFeatureAccess});
