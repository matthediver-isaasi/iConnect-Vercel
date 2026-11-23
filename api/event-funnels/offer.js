import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { loadPrivateTicketViewer } from '../_lib/privateTicketAccess.js';
import { createFunnelPublicHandler } from '../_lib/eventFunnelPublic.js';

export default createFunnelPublicHandler('offer', { db: supabase, resolveTenant: resolveTenantFromRequest, loadViewer: loadPrivateTicketViewer });
