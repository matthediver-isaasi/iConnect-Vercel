export const DESTINATION_PROJECT_REF = 'lvmzliemqnieeoruhkik';

export function isApprovedDestinationSupabaseTarget(databaseUrlValue, supabaseUrlValue) {
  let databaseUrl;
  let supabaseUrl;
  try {
    databaseUrl = new URL(databaseUrlValue);
    supabaseUrl = new URL(supabaseUrlValue);
  } catch {
    return false;
  }

  if (supabaseUrl.protocol !== 'https:') return false;
  if (supabaseUrl.hostname !== `${DESTINATION_PROJECT_REF}.supabase.co`) return false;
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) return false;
  if (databaseUrl.pathname !== '/postgres') return false;

  const username = decodeURIComponent(databaseUrl.username);
  const isDirect = databaseUrl.hostname === `db.${DESTINATION_PROJECT_REF}.supabase.co`
    && username === 'postgres';
  const isPooler = databaseUrl.hostname.endsWith('.pooler.supabase.com')
    && username === `postgres.${DESTINATION_PROJECT_REF}`;

  return isDirect || isPooler;
}