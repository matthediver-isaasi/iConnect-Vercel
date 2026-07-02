/**
 * Centralized Database Configuration
 * 
 * This module provides a single Supabase client for all API endpoints.
 * 
 * ARCHITECTURE NOTE: There is NO development environment concept in this project.
 * The only difference between preview and production is the Vercel branch.
 * Both use the same SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables
 * configured in Vercel for each branch/deployment.
 */

import { createClient } from '@supabase/supabase-js';

// Suppress DEP0169 (url.parse() deprecation) emitted by transitive dependencies
// (follow-redirects via axios, Express internals, mdurl via markdown-it).
// The warning is benign — nothing in this codebase calls url.parse() directly —
// but Vercel tags every process.emitWarning call as [error], polluting logs.
// All other deprecation warnings (and all real errors) are unaffected.
// Idempotency guard prevents re-registration on module cache invalidation.
if (!process.__dep0169FilterAttached) {
  process.__dep0169FilterAttached = true;
  // Capture Node's built-in warning listeners (the default stderr printer is one
  // of them) then replace them all with a single filtered wrapper that drops
  // DEP0169 and delegates everything else to the original handlers unchanged.
  const originalListeners = process.rawListeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', (warning) => {
    if (warning.code === 'DEP0169') return;
    for (const fn of originalListeners) {
      fn.call(process, warning);
    }
  });
}

export const supabaseUrl = process.env.SUPABASE_URL;
export const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
export const databaseUrl = process.env.DATABASE_URL;

export const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;
