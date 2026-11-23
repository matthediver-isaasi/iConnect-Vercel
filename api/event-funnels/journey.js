import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { loadPrivateTicketViewer } from '../_lib/privateTicketAccess.js';
import { createEventFunnelJourneyHandler } from '../_lib/eventFunnelJourneyHandler.js';
import { createFunnelSelectionResolver, assertFunnelCommercialCompatibility } from '../_lib/eventFunnelCommercial.js';

// Creation/publishing remain disabled until aggregate payment and recovery are ready.
export default createEventFunnelJourneyHandler({
  db: supabase, resolveTenant: resolveTenantFromRequest, loadViewer: loadPrivateTicketViewer,
  resolveSelection: createFunnelSelectionResolver({ db: supabase }),
  validateLines: assertFunnelCommercialCompatibility,
});
