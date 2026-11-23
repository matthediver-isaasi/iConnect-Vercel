import {supabase} from '../_lib/database.js';
import {createFunnelReversalCron} from '../_lib/eventFunnelReversalCron.js';
export const config={maxDuration:60};
// Deliberately unscheduled until migration rehearsal and activation approval.
export default createFunnelReversalCron({db:supabase,getSecret:()=>process.env.CRON_SECRET});
