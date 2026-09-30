import { getTenantContext } from '../_lib/tenantContext.js';
import { simulateMembershipForOrg, simulateMembershipForMember } from '../_lib/membershipSimulation.js';
import { readFileSync } from 'fs';
import { join } from 'path';

function checkCronConfiguration() {
  try {
    const vercelJsonPath = join(process.cwd(), 'vercel.json');
    const vercelJson = JSON.parse(readFileSync(vercelJsonPath, 'utf-8'));
    const crons = vercelJson?.crons || [];
    const membershipCron = crons.find(c => c.path === '/api/cron/process-membership-renewals');
    if (membershipCron) {
      return { configured: true, schedule: membershipCron.schedule };
    }
    return { configured: false, schedule: null };
  } catch {
    return { configured: false, schedule: null, readError: true };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const tenantContext = await getTenantContext(req);
    if (!tenantContext?.tenantId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { tenantId } = tenantContext;
    const { organizationId, memberId, mode, targetYear } = req.body;

    if (!organizationId && !memberId) {
      return res.status(400).json({ error: 'organizationId or memberId is required' });
    }

    if (!mode || !['automatic', 'scheduled', 'manual'].includes(mode)) {
      return res.status(400).json({ error: 'mode must be "automatic", "scheduled", or "manual"' });
    }

    const isMemberSimulation = !!memberId && !organizationId;

    const simResult = isMemberSimulation
      ? await simulateMembershipForMember(tenantId, memberId, {
          source: 'simulate',
          mode,
          targetYear: targetYear || null,
        })
      : await simulateMembershipForOrg(tenantId, organizationId, {
          source: 'simulate',
          mode,
          targetYear: targetYear || null,
        });

    if (!simResult.success) {
      return res.json({ success: false, steps: simResult.steps });
    }

    const cronSteps = [];
    if (mode !== 'manual') {
      const cronCheck = checkCronConfiguration();
      if (cronCheck.configured) {
        cronSteps.push({ step: 'Cron Job Check', detail: `Membership renewal cron is configured (schedule: ${cronCheck.schedule} — daily at 06:00 UTC)`, status: 'ok', timestamp: new Date().toISOString() });
      } else if (cronCheck.readError) {
        cronSteps.push({ step: 'Cron Job Check', detail: 'Could not read vercel.json to verify cron configuration. The cron may still be configured in production.', status: 'warning', timestamp: new Date().toISOString() });
      } else {
        cronSteps.push({ step: 'Cron Job Check', detail: 'Membership renewal cron job is NOT configured in vercel.json. Automatic/scheduled renewals will not run until the cron entry is added.', status: 'error', timestamp: new Date().toISOString() });
      }
    }

    const allSteps = [
      simResult.steps[0],
      ...cronSteps,
      ...simResult.steps.slice(1),
    ];

    const entityName = isMemberSimulation
      ? simResult.member?.name || 'Unknown Member'
      : simResult.org?.name || 'Unknown Organisation';

    return res.json({
      success: true,
      mode,
      ...(isMemberSimulation
        ? { member: entityName }
        : { organization: entityName }),
      membershipYear: simResult.membershipYear.label,
      tierLabel: simResult.tierLabel,
      finalCost: simResult.finalCost,
      currency: simResult.currency,
      overrideApplied: simResult.overrideApplied,
      invoicePreview: simResult.invoicePreview,
      steps: allSteps,
    });
  } catch (error) {
    console.error('[Simulate Renewal] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
