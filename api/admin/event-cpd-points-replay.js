import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../_lib/tenantContext.js';
import { makeCpdPointsReplayHandler } from '../_lib/eventCpdPointsReprocessing.js';

export default makeCpdPointsReplayHandler({
  db: supabase,
  getContext: getTenantContext,
  hasAdminAccess,
  hasFeatureAccess,
  signingSecret: () => process.env.SUPABASE_SERVICE_KEY,
});