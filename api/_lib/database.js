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

export const supabaseUrl = process.env.SUPABASE_URL;
export const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
export const databaseUrl = process.env.DATABASE_URL;

export const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;
