import { supabase } from '../../_lib/database.js';
import { getSessionPlatformOwner } from '../../_lib/platformSession.js';
import { getDemoDefinition } from '../../../demo-seeds/registry.mjs';
import {
  seedDemoTenant,
  resetDemoData,
  deleteDemoTenant,
  demoTenantStatus,
  setDemoPortalPassword,
} from '../../../demo-seeds/engine.mjs';
import { provisionTenant } from '../../_lib/provisionTenantService.js';
import { acquirePlatformOpLock } from '../../_lib/platformOpLock.js';

/**
 * POST /api/platform/demo-tenants/operate
 * body: { seedKey, action: 'seed' | 'reset' | 'delete' | 'set-password', confirmSlug?, password? }
 *
 * Runs one demo-tenant lifecycle operation via the demo-seeds engine.
 * Platform-owner only. Destructive actions (reset/delete) require
 * confirmSlug to match the definition's tenant slug.
 *
 * Serverless resilience: this function has an extended maxDuration (see
 * vercel.json). Every engine operation is idempotent and resumable — seeding
 * upserts on stable natural keys and reset/delete work off the persisted
 * manifest — so if an invocation is ever cut short, re-running the SAME
 * action from the console safely resumes/completes it without duplicating
 * data or leaving the tenant half-built. An atomic, token-owned DB lease
 * (platform_op_lock RPC pair) prevents two operations running concurrently
 * against the same definition; acquisition is fail-closed. The 10-minute TTL
 * exceeds the 300s function budget, so a crashed invocation's lease always
 * self-expires before it could block a legitimate retry forever.
 */

const LOCK_TTL_SECONDS = 10 * 60;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  const owner = await getSessionPlatformOwner(req);
  if (!owner) {
    return res.status(401).json({ error: 'Platform owner authentication required' });
  }

  const { seedKey, action, confirmSlug, password } = req.body || {};
  const definition = getDemoDefinition(seedKey);
  if (!definition) {
    return res.status(400).json({ error: `Unknown demo tenant definition '${seedKey}'` });
  }
  if (!['seed', 'reset', 'delete', 'set-password'].includes(action)) {
    return res.status(400).json({ error: `Unknown action '${action}'` });
  }
  if (action === 'set-password' && password != null && String(password).trim().length > 0 && String(password).trim().length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters (leave blank to generate one)' });
  }
  if ((action === 'reset' || action === 'delete') && confirmSlug !== definition.tenant.slug) {
    return res.status(400).json({ error: 'Confirmation slug does not match' });
  }

  const lock = await acquirePlatformOpLock(
    supabase,
    `demo-tenant:${seedKey}`,
    { action, ownerEmail: owner.email, startedAt: new Date().toISOString() },
    LOCK_TTL_SECONDS
  );
  if (!lock.ok) {
    if (lock.error) {
      // Fail closed: never run an unguarded destructive operation.
      return res.status(503).json({ error: lock.error });
    }
    const holder = lock.holder || {};
    return res.status(409).json({
      error: `A '${holder.action || 'demo tenant'}' operation for this demo tenant is already in progress (started by ${holder.ownerEmail || 'unknown'}). Try again shortly.`,
    });
  }

  const logs = [];
  const log = (msg) => { logs.push(String(msg)); console.log(`[Platform Demo Tenants] ${msg}`); };

  try {
    let result;
    if (action === 'seed') {
      const { manifest, adminSetup } = await seedDemoTenant(definition, {
        sb: supabase,
        provisionTenant,
        log,
      });
      result = { counts: manifest.counts, adminSetup };
    } else if (action === 'reset') {
      result = await resetDemoData(definition, { sb: supabase, log });
    } else if (action === 'set-password') {
      // Plaintext password is returned once to the platform owner and never
      // stored (only bcrypt hashes are written).
      const trimmed = password != null ? String(password).trim() : '';
      result = await setDemoPortalPassword(definition, {
        sb: supabase,
        password: trimmed.length > 0 ? trimmed : null,
        log,
      });
    } else {
      result = await deleteDemoTenant(definition, { sb: supabase, log });
    }

    const status = await demoTenantStatus(definition, { sb: supabase });
    return res.status(200).json({ success: true, action, result, status, logs: logs.slice(-20) });
  } catch (error) {
    console.error(`[Platform Demo Tenants] ${action} failed:`, error);
    // Operations are idempotent/resumable: tell the admin how to recover so
    // a timeout or transient failure never silently leaves a half-built tenant.
    return res.status(500).json({
      error: error.message || `Demo tenant ${action} failed`,
      recoverable: true,
      hint: `The ${action} operation is idempotent — running it again will safely resume and complete without duplicating data.`,
      logs: logs.slice(-20),
    });
  } finally {
    await lock.release();
  }
}
