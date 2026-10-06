import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../_lib/tenantContext.js';
import { makeEventRegistrationMemberHandler } from '../_lib/eventRegistrationMember.js';

export default makeEventRegistrationMemberHandler({
  db: supabase, getContext: getTenantContext,
  adminAccess: hasAdminAccess, featureAccess: hasFeatureAccess,
});
