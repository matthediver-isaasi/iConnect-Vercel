import { runHealthChecks } from './_lib/healthChecks.js';

function noStore(res) {
  res.setHeader?.('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader?.('Pragma', 'no-cache');
  res.setHeader?.('Expires', '0');
}

export function createHealthHandler({
  getToken = () => process.env.ICONNECT_HEALTH_CHECK_TOKEN,
  checks = runHealthChecks,
  clock = () => new Date(),
} = {}) {
  return async function healthHandler(req, res) {
    noStore(res);

    const configuredToken = getToken();
    const suppliedToken = req?.headers?.['x-health-token']
      || req?.headers?.['X-Health-Token'];
    if (!configuredToken || suppliedToken !== configuredToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let dependencies;
    try {
      dependencies = await checks();
    } catch {
      dependencies = {};
    }
    const safeDependencies = {
      database: dependencies?.database === 'ok' ? 'ok' : 'error',
      auth: dependencies?.auth === 'ok' ? 'ok' : 'error',
      storage: dependencies?.storage === 'ok' ? 'ok' : 'error',
    };
    const healthy = Object.values(safeDependencies).every((value) => value === 'ok');
    return res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'error',
      ...safeDependencies,
      timestamp: clock().toISOString(),
    });
  };
}

export default createHealthHandler();