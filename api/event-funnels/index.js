import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../_lib/tenantContext.js';
import { createEventFunnelAdminHandler } from '../_lib/eventFunnelAdmin.js';

export default createEventFunnelAdminHandler({
  db: supabase, getContext: getTenantContext, hasAdminAccess, hasFeatureAccess,
});
