import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../../_lib/tenantContext.js';
import { createSingleResourceHandler } from '../../_lib/singleResourceAccess.js';

export default createSingleResourceHandler({
  db: supabase,
  getContext: getTenantContext,
  hasAdminAccess,
  hasFeatureAccess,
});