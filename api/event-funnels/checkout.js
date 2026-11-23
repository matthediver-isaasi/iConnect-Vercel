import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { loadPrivateTicketViewer } from '../_lib/privateTicketAccess.js';
import { createFunnelSelectionResolver } from '../_lib/eventFunnelCommercial.js';
import { createEventFunnelCheckoutHandler } from '../_lib/eventFunnelCheckoutHandler.js';

export const config={maxDuration:60};
export default createEventFunnelCheckoutHandler({
  db:supabase,resolveTenant:resolveTenantFromRequest,loadViewer:loadPrivateTicketViewer,
  resolveSelection:createFunnelSelectionResolver({db:supabase}),
});
