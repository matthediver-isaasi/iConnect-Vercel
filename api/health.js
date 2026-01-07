import { supabase } from './_lib/database.js';

export default async function handler(req, res) {
  const supabaseConfigured = !!supabase;
  
  return res.json({ 
    status: 'ok',
    supabase: supabaseConfigured,
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
}
