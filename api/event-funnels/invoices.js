import {supabase} from '../_lib/database.js';
import {resolveTenantFromRequest} from '../_lib/tenantResolver.js';
import {loadPrivateTicketViewer} from '../_lib/privateTicketAccess.js';
import {createFunnelOwnedInvoicesHandler} from '../_lib/eventFunnelOwnedInvoices.js';
export const config={maxDuration:60};
export default createFunnelOwnedInvoicesHandler({
  db:supabase,resolveTenant:resolveTenantFromRequest,loadViewer:loadPrivateTicketViewer,
});
