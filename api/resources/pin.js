import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../_lib/tenantContext.js';
import { createResourcePinHandler } from '../_lib/resourcePins.js';

export default createResourcePinHandler({ db: supabase, getTenantContext, hasAdminAccess, hasFeatureAccess });
