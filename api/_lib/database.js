/**
 * Centralized Database Configuration
 * 
 * This module handles environment-aware database configuration.
 * In development (NODE_ENV=development), it uses DEV_* prefixed variables.
 * In production, it uses the standard SUPABASE_URL, SUPABASE_SERVICE_KEY.
 */

import { createClient } from '@supabase/supabase-js';

const isDevelopment = process.env.NODE_ENV === 'development';

export const supabaseUrl = isDevelopment && process.env.DEV_SUPABASE_URL 
  ? process.env.DEV_SUPABASE_URL 
  : process.env.SUPABASE_URL;

export const supabaseServiceKey = isDevelopment && process.env.DEV_SUPABASE_SERVICE_KEY
  ? process.env.DEV_SUPABASE_SERVICE_KEY
  : process.env.SUPABASE_SERVICE_KEY;

export const databaseUrl = isDevelopment && process.env.DEV_DATABASE_URL
  ? process.env.DEV_DATABASE_URL
  : process.env.DATABASE_URL;

export const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

if (isDevelopment) {
  console.log('[Database] Running in development mode');
  console.log('[Database] Supabase URL:', supabaseUrl ? supabaseUrl.substring(0, 30) + '...' : 'NOT SET');
}
