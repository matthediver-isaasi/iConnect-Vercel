import pg from 'pg';
export const EVENT = '66050b3c-aa70-4174-8552-0a2af85e5410';
export const PROJECT = 'lvmzliemqnieeoruhkik';
export async function connectDestination() {
  if (process.env.DEST_SUPABASE_URL !== `https://${PROJECT}.supabase.co`) throw new Error('Destination REST pin failed');
  const url = new URL(process.env.DEST_DATABASE_URL);
  if (!['aws-1-eu-central-1.pooler.supabase.com', `db.${PROJECT}.supabase.co`].includes(url.hostname)
    || (url.port && url.port !== '5432')
    || (url.hostname.includes('pooler') && !decodeURIComponent(url.username).endsWith(`.${PROJECT}`))) throw new Error('Destination SQL pin failed');
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  if (!response.ok) throw new Error('CA unavailable');
  const client = new pg.Client({ connectionString: url.toString(), ssl: { rejectUnauthorized: true, ca: await response.text(), servername: url.hostname } });
  await client.connect();
  return client;
}