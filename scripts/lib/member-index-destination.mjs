import pg from 'pg';

export const PROJECT = 'lvmzliemqnieeoruhkik';
export async function connectDestination() {
  if (!process.env.DEST_DATABASE_URL) throw new Error('DEST_DATABASE_URL is required');
  const url = new URL(process.env.DEST_DATABASE_URL);
  if (!(url.hostname === `db.${PROJECT}.supabase.co` ||
    (url.hostname.endsWith('.pooler.supabase.com') &&
      decodeURIComponent(url.username).endsWith(`.${PROJECT}`)))) {
    throw new Error('Destination project identity mismatch');
  }
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  if (!response.ok) throw new Error('Could not load trusted Supabase CA');
  const client = new pg.Client({
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: true, ca: await response.text() },
    connectionTimeoutMillis: 15000,
  });
  await client.connect();
  return client;
}