/**
 * One explicitly authorized object only. Defaults to read-only preflight.
 * --apply removes through Storage API, never SQL. No fallback credentials.
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';

export const TARGET = Object.freeze({
  projectUrl: 'https://lvmzliemqnieeoruhkik.supabase.co',
  tenantId: 'fd82da65-aab7-4a5c-85b8-b2febeb2003d',
  bucket: 'public-assets',
  path: 'fd82da65-aab7-4a5c-85b8-b2febeb2003d/uploads/1787918392305-51t3122-CoP_Leadership_Team_Expression_of_Interest_Alignment_June_2026_Version_1.0.docx',
  objectId: 'dcf50a0e-e30f-4bd5-afd2-4422e34c99dd',
  etag: '"fd8f82fe06ad1e638adc26a7476b88a7"',
  size: 486985,
});
const suffix = `/storage/v1/object/public/${TARGET.bucket}/${TARGET.path}`;
export const ORIGINAL_URL = `https://vault.iconn.app${suffix}`;
const originUrl = `${TARGET.projectUrl}${suffix}`;

function checked(result, label) {
  if (result.error) throw new Error(`${label} failed; stopping without further changes`);
  return result.data;
}

function objectIsMissing(result) {
  // This installed SDK discards the REST NoSuchKey code on info() errors.
  // Require both its object-specific message and its embedded 404 status.
  return result.error?.code === 'NoSuchKey'
    || (String(result.error?.statusCode) === '404'
      && result.error?.message === 'Object not found');
}

export async function removeAuthorizedDocument({ db, fetcher = fetch, apply = false }) {
  const tenant = checked(await db.from('tenant').select('id,name,slug')
    .eq('id', TARGET.tenantId).single(), 'Tenant verification');
  assert.equal(tenant.id, TARGET.tenantId);
  assert.equal(tenant.slug, 'gfi');
  assert.equal(tenant.name, 'Graduate Futures Institute');
  // Exact filters only. Do not enumerate unrelated objects or records.
  for (const [column, value] of [
    ['storage_path', TARGET.path],
    ['file_url', ORIGINAL_URL],
    ['file_url', originUrl],
  ]) {
    const refs = checked(await db.from('file_repository').select('id')
      .eq(column, value).limit(1), 'Repository reference check');
    assert.equal(refs.length, 0, 'A repository record still references this object; stop');
  }
  const storage = db.storage.from(TARGET.bucket);
  const info = await storage.info(TARGET.path);
  const missing = objectIsMissing(info);
  if (!missing) {
    const object = checked(info, 'Object identity');
    assert.equal(object.id, TARGET.objectId);
    assert.equal(object.name, TARGET.path);
    assert.equal(object.bucketId, TARGET.bucket);
    assert.equal(object.etag, TARGET.etag);
    assert.equal(object.size, TARGET.size);
    for (const url of [originUrl, ORIGINAL_URL]) {
      const response = await fetcher(url, { method: 'HEAD', redirect: 'error' });
      assert.equal(response.status, 200, 'Pre-delete URL identity unavailable');
      assert.equal(response.headers.get('etag'), TARGET.etag, 'URL points at different content');
    }
  }
  if (!apply) return { mode: 'preflight', identityVerified: true, alreadyAbsent: missing };
  if (!missing) checked(await storage.remove([TARGET.path]), 'Storage deletion');
  const after = await storage.info(TARGET.path);
  assert.ok(objectIsMissing(after), 'Storage API did not confirm object absence');
  const urls = [];
  for (const [label, url] of [['origin', originUrl], ['original', ORIGINAL_URL]]) {
    const response = await fetcher(url, { redirect: 'error', headers: { 'Cache-Control': 'no-cache' } });
    const contentType = response.headers.get('content-type') || '';
    assert.ok(!response.ok, `${label} still serves content`);
    assert.match(contentType, /application\/json/i, `${label} absence not established`);
    const body = await response.json();
    assert.ok(body.error === 'not_found' || body.code === 'NoSuchKey'
      || (String(body.statusCode) === '404' && body.message === 'Object not found'),
    `${label} returned an error other than object absence`);
    urls.push({
      label, status: response.status, contentType,
      cache: response.headers.get('cf-cache-status'), objectAbsent: true,
    });
  }
  return { mode: 'apply', removed: !missing, storageAbsent: true, urls };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert.ok(process.argv.slice(2).every(arg => arg === '--apply'), 'Unknown argument');
    assert.equal(process.env.DEST_SUPABASE_URL?.replace(/\/$/, ''), TARGET.projectUrl,
      'Destination project mismatch');
    assert.ok(process.env.DEST_SUPABASE_KEY, 'DEST credentials required');
    const db = createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY,
      { auth: { persistSession: false } });
    console.log(JSON.stringify(await removeAuthorizedDocument({
      db, apply: process.argv.includes('--apply'),
    }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}