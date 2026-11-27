import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { createGroupResourcePinHandler } from '../_lib/groupResourcePins.js';

export default createGroupResourcePinHandler({ db: supabase, getTenantContext, hasAdminAccess });
