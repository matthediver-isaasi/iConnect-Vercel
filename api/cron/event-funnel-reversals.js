import {supabase} from '../_lib/database.js';
import {createFunnelReversalCron} from '../_lib/eventFunnelReversalCron.js';
import {withFunnelWorkerActivation} from '../_lib/eventFunnelActivation.js';
export const config={maxDuration:60};
const handler=createFunnelReversalCron({db:supabase,getSecret:()=>process.env.CRON_SECRET});
export default withFunnelWorkerActivation({db:supabase,worker:'reversals',handler});
