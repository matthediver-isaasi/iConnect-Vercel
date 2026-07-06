/**
 * Shared backup runner logic for Supabase Storage + Postgres → Cloudflare R2.
 *
 * Used by BOTH:
 *   - the daily cron endpoints (api/cron/backup-*-to-r2.js), and
 *   - the platform manual-trigger endpoints (api/platform/backups/*.js).
 *
 * Each runner processes one bounded chunk of work (governed by timeBudgetMs)
 * and persists a resume cursor in R2 so a chunk that runs out of time is
 * continued by the next invocation. This lets a manual run drive a backup to
 * completion by re-invoking until the returned summary reports it is done.
 *
 * Required env vars:
 *   DEST_SUPABASE_URL, DEST_SUPABASE_KEY     (storage backup)
 *   DEST_DATABASE_URL                        (database backup)
 *   R2_ACCOUNT_ID (or R2_ENDPOINT), R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 * Optional:
 *   DB_BACKUP_SCHEMAS  (comma-separated, default "public")
 */

import { createClient } from '@supabase/supabase-js';
import { Upload } from '@aws-sdk/lib-storage';
import pg from 'pg';
import { pipeline } from 'stream/promises';
import { createGzip } from 'zlib';
import { PassThrough } from 'stream';
import copyStreams from 'pg-copy-streams';
import { createR2Client, getR2Bucket, headR2Object, putR2Object, getR2ObjectText } from './r2Client.js';

const { Pool } = pg;
const { to: copyTo } = copyStreams;

export const STORAGE_CURSOR_KEY = '_backup-state/storage-cursor.json';
export const DB_CURSOR_KEY = '_backup-state/database-cursor.json';

const STORAGE_R2_PREFIX = 'supabase-storage';
const DUMP_PREFIX = 'database-dumps';
const PAGE_SIZE = 1000;

export const DEFAULT_STORAGE_TIME_BUDGET_MS = 50_000;
export const DEFAULT_DB_TIME_BUDGET_MS = 250_000;

// ── shared helpers ──────────────────────────────────────────────────────────

function makeSupabase() {
  const url = process.env.DEST_SUPABASE_URL;
  const key = process.env.DEST_SUPABASE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function r2Context() {
  const r2 = createR2Client();
  const bucket = getR2Bucket();
  if (!r2 || !bucket) return null;
  return { r2, bucket };
}

async function loadCursor(r2, bucket, key) {
  try {
    const text = await getR2ObjectText(r2, bucket, key);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function saveCursor(r2, bucket, key, cursor) {
  await putR2Object(r2, bucket, key, JSON.stringify(cursor), { contentType: 'application/json' });
}

async function clearCursor(r2, bucket, key) {
  await putR2Object(
    r2,
    bucket,
    key,
    JSON.stringify({ completed: true, clearedAt: new Date().toISOString() }),
    { contentType: 'application/json' }
  ).catch(() => {}); // best-effort
}

// ── storage backup ──────────────────────────────────────────────────────────

/**
 * Async generator: yields { path, size, updatedAt } for every real object
 * (not folder) under a prefix in a Supabase Storage bucket. Objects are
 * emitted in Supabase's listing order (alphabetical by name at each level),
 * which is deterministic and consistent across runs — enabling cursor-based
 * resumability without pre-sorting a full in-memory list.
 */
async function* streamObjects(supabase, bucketName, prefix) {
  let offset = 0;
  while (true) {
    const { data, error } = await supabase.storage
      .from(bucketName)
      .list(prefix, { limit: PAGE_SIZE, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) {
      console.warn(`[backup-storage] list ${bucketName}/${prefix} error: ${error.message}`);
      return;
    }
    if (!data || data.length === 0) return;
    for (const entry of data) {
      if (entry.id === null) {
        const childPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
        yield* streamObjects(supabase, bucketName, childPrefix);
      } else {
        yield {
          path: prefix ? `${prefix}/${entry.name}` : entry.name,
          size: Number(entry?.metadata?.size || 0),
          updatedAt: entry.updated_at || entry.created_at || '',
        };
      }
    }
    if (data.length < PAGE_SIZE) return;
    offset += PAGE_SIZE;
  }
}

/**
 * Return true if the R2 object already reflects this Supabase object version.
 * Both size AND supabase-updated-at metadata must match; if either is absent
 * (e.g. object predates this backup) we re-upload to populate the metadata.
 */
function isUnchanged(r2Head, obj) {
  if (!r2Head) return false;
  const r2Size = r2Head.metadata['supabase-size'];
  const r2Updated = r2Head.metadata['supabase-updated-at'];
  if (!r2Size || !r2Updated) return false;
  return r2Size === String(obj.size) && r2Updated === String(obj.updatedAt);
}

/**
 * Run one chunk of the incremental storage backup.
 * Returns { ok, error?, copied, skipped, errored, bytes, deferred, durationMs }.
 */
export async function runStorageBackup({ timeBudgetMs = DEFAULT_STORAGE_TIME_BUDGET_MS } = {}) {
  const startTime = Date.now();
  const summary = { copied: 0, skipped: 0, errored: 0, bytes: 0, durationMs: 0, deferred: false };

  const supabase = makeSupabase();
  if (!supabase) {
    return { ok: false, error: 'DEST_SUPABASE_URL / DEST_SUPABASE_KEY not configured', ...summary };
  }
  const ctx = r2Context();
  if (!ctx) {
    return { ok: false, error: 'R2 credentials not configured (R2_ACCOUNT_ID/R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET)', ...summary };
  }
  const { r2, bucket: r2Bucket } = ctx;

  try {
    const cursor = await loadCursor(r2, r2Bucket, STORAGE_CURSOR_KEY);
    const resumeBucket = cursor && !cursor.completed ? cursor.lastBucket || null : null;
    const resumePath = cursor && !cursor.completed ? cursor.lastPath || null : null;
    const sweepStarted = (cursor && !cursor.completed && cursor.sweepStarted) || new Date().toISOString();

    const { data: buckets, error: bucketsErr } = await supabase.storage.listBuckets();
    if (bucketsErr) {
      return { ok: false, error: bucketsErr.message, ...summary, ok: false };
    }

    const allBuckets = (buckets || []).map((b) => b.name).sort();
    let timedOut = false;

    outerLoop:
    for (const bucketName of allBuckets) {
      if (resumeBucket && bucketName < resumeBucket) continue;

      if (Date.now() - startTime > timeBudgetMs) {
        timedOut = true;
        summary.deferred = true;
        break;
      }

      console.log(`[backup-storage] processing bucket: ${bucketName}`);

      try {
        for await (const obj of streamObjects(supabase, bucketName, '')) {
          // Strict less-than: lastPath is the unprocessed object that caused
          // the timeout, so on resume we retry it.
          if (resumeBucket && bucketName === resumeBucket && resumePath && obj.path < resumePath) {
            continue;
          }

          if (Date.now() - startTime > timeBudgetMs) {
            timedOut = true;
            summary.deferred = true;
            await saveCursor(r2, r2Bucket, STORAGE_CURSOR_KEY, {
              lastBucket: bucketName,
              lastPath: obj.path,
              sweepStarted,
            });
            break outerLoop;
          }

          const r2Key = `${STORAGE_R2_PREFIX}/${bucketName}/${obj.path}`;

          try {
            const r2Head = await headR2Object(r2, r2Bucket, r2Key);
            if (isUnchanged(r2Head, obj)) {
              summary.skipped++;
              continue;
            }

            const { data: signedData, error: signErr } = await supabase.storage
              .from(bucketName)
              .createSignedUrl(obj.path, 300);
            if (signErr || !signedData?.signedUrl) {
              console.warn(`[backup-storage] signed URL failed for ${bucketName}/${obj.path}: ${signErr?.message}`);
              summary.errored++;
              continue;
            }

            const fetchResp = await fetch(signedData.signedUrl);
            if (!fetchResp.ok) {
              console.warn(`[backup-storage] fetch failed ${bucketName}/${obj.path}: HTTP ${fetchResp.status}`);
              summary.errored++;
              continue;
            }

            const upload = new Upload({
              client: r2,
              params: {
                Bucket: r2Bucket,
                Key: r2Key,
                Body: fetchResp.body,
                Metadata: {
                  'supabase-size': String(obj.size),
                  'supabase-updated-at': String(obj.updatedAt),
                },
                ...(obj.size > 0 ? { ContentLength: obj.size } : {}),
              },
              queueSize: 1,
              partSize: 10 * 1024 * 1024,
            });
            await upload.done();

            summary.copied++;
            summary.bytes += obj.size;
          } catch (err) {
            console.error(`[backup-storage] error processing ${bucketName}/${obj.path}:`, err.message);
            summary.errored++;
          }
        }
      } catch (err) {
        console.error(`[backup-storage] error iterating bucket ${bucketName}:`, err.message);
        summary.errored++;
      }
    }

    if (!timedOut) {
      await clearCursor(r2, r2Bucket, STORAGE_CURSOR_KEY);
      console.log('[backup-storage] full sweep completed, cursor cleared');
    }

    summary.durationMs = Date.now() - startTime;
    console.log('[backup-storage] done', JSON.stringify(summary));
    return { ok: true, ...summary };
  } catch (err) {
    console.error('[backup-storage] fatal:', err.message);
    summary.durationMs = Date.now() - startTime;
    return { ok: false, error: err.message, ...summary };
  }
}

// ── database backup ─────────────────────────────────────────────────────────

function runStamp() {
  const iso = new Date().toISOString();
  return iso.slice(0, 19).replace(/:/g, '-') + 'Z';
}

function datePart(stamp) {
  return stamp.slice(0, 10);
}

function getSchemas() {
  const raw = process.env.DB_BACKUP_SCHEMAS || 'public';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

async function getSchemaTables(pool, schemas) {
  const { rows } = await pool.query(
    `SELECT schemaname, tablename
     FROM pg_catalog.pg_tables
     WHERE schemaname = ANY($1)
     ORDER BY schemaname, tablename`,
    [schemas]
  );
  return rows.map((r) => ({ schema: r.schemaname, table: r.tablename, key: `${r.schemaname}.${r.tablename}` }));
}

async function dumpTableToR2(pool, r2, r2Bucket, schema, tableName, r2Key) {
  const client = await pool.connect();
  try {
    let compressedBytes = 0;

    const gzip = createGzip({ level: 6 });
    const passthrough = new PassThrough();
    passthrough.on('data', (chunk) => { compressedBytes += chunk.length; });

    const upload = new Upload({
      client: r2,
      params: {
        Bucket: r2Bucket,
        Key: r2Key,
        Body: passthrough,
        ContentType: 'application/gzip',
      },
      queueSize: 1,
      partSize: 10 * 1024 * 1024,
    });

    const uploadPromise = upload.done();

    const copyStream = client.query(
      copyTo(`COPY (SELECT * FROM "${schema}"."${tableName}") TO STDOUT (FORMAT CSV, HEADER)`)
    );

    await pipeline(copyStream, gzip, passthrough);
    await uploadPromise;

    return compressedBytes;
  } finally {
    client.release();
  }
}

/**
 * Run one chunk of the resumable database dump.
 * Returns { ok, error?, runStamp, schemas, totalTables, dumped[], skipped[],
 *           errored[], totalCompressedBytes, complete, resumed, durationMs }.
 */
export async function runDatabaseBackup({ timeBudgetMs = DEFAULT_DB_TIME_BUDGET_MS } = {}) {
  const databaseUrl = process.env.DEST_DATABASE_URL;
  if (!databaseUrl) {
    return { ok: false, error: 'DEST_DATABASE_URL not configured' };
  }
  const ctx = r2Context();
  if (!ctx) {
    return { ok: false, error: 'R2 credentials not configured (R2_ACCOUNT_ID/R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET)' };
  }
  const { r2, bucket: r2Bucket } = ctx;

  const startTime = Date.now();

  let stamp, folderPrefix, startFromTableKey;
  const dbCursor = await loadCursor(r2, r2Bucket, DB_CURSOR_KEY);
  if (dbCursor?.stamp && dbCursor?.nextTable && !dbCursor?.completed) {
    stamp = dbCursor.stamp;
    folderPrefix = dbCursor.folderPrefix;
    startFromTableKey = dbCursor.nextTable;
    console.log(`[backup-database] resuming run ${stamp} from table ${startFromTableKey}`);
  } else {
    stamp = runStamp();
    folderPrefix = `${DUMP_PREFIX}/${datePart(stamp)}/${stamp}`;
    startFromTableKey = null;
    console.log(`[backup-database] starting new run ${stamp}`);
  }

  const schemas = getSchemas();
  const summary = {
    ok: true,
    runStamp: stamp,
    schemas,
    totalTables: 0,
    dumped: [],
    skipped: [],
    errored: [],
    totalCompressedBytes: 0,
    durationMs: 0,
    complete: false,
    resumed: !!startFromTableKey,
  };

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 3,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const allTables = await getSchemaTables(pool, schemas);
    summary.totalTables = allTables.length;
    console.log(`[backup-database] ${allTables.length} table(s) across schemas: ${schemas.join(', ')}`);

    const tables = startFromTableKey
      ? allTables.filter((t) => t.key >= startFromTableKey)
      : allTables;

    for (let i = 0; i < tables.length; i++) {
      const { schema, table, key } = tables[i];

      if (Date.now() - startTime > timeBudgetMs) {
        const remaining = tables.slice(i);
        await saveCursor(r2, r2Bucket, DB_CURSOR_KEY, { stamp, folderPrefix, nextTable: key });
        summary.skipped.push(...remaining.map((t) => t.key));
        console.warn(`[backup-database] time budget exceeded, saved cursor at ${key}; ${remaining.length} deferred`);
        break;
      }

      const r2Key = `${folderPrefix}/${key}.csv.gz`;
      console.log(`[backup-database] dumping ${key}`);

      try {
        const compressedBytes = await dumpTableToR2(pool, r2, r2Bucket, schema, table, r2Key);
        summary.dumped.push({ table: key, r2Key, compressedBytes });
        summary.totalCompressedBytes += compressedBytes;
      } catch (err) {
        console.error(`[backup-database] error dumping ${key}:`, err.message);
        summary.errored.push({ table: key, error: err.message });
      }
    }

    summary.complete = summary.skipped.length === 0 && summary.errored.length === 0;
    summary.durationMs = Date.now() - startTime;

    if (summary.complete) {
      await clearCursor(r2, r2Bucket, DB_CURSOR_KEY);
    }

    const manifestKey = `${folderPrefix}/_manifest.json`;
    await putR2Object(r2, r2Bucket, manifestKey, JSON.stringify(summary, null, 2), {
      contentType: 'application/json',
    }).catch((err) => console.warn('[backup-database] manifest write failed:', err.message));

    console.log('[backup-database] done', JSON.stringify({
      runStamp: summary.runStamp,
      dumped: summary.dumped.length,
      skipped: summary.skipped.length,
      errored: summary.errored.length,
      complete: summary.complete,
    }));

    return summary;
  } catch (err) {
    console.error('[backup-database] fatal:', err.message);
    summary.durationMs = Date.now() - startTime;
    return { ...summary, ok: false, error: err.message };
  } finally {
    await pool.end().catch(() => {});
  }
}

// ── status ──────────────────────────────────────────────────────────────────

/**
 * Read the persisted storage + database cursors from R2 so the UI can show
 * whether a backup is idle (last sweep complete), paused mid-run, or never
 * run. Returns { ok, configured, storage, database }.
 */
export async function getBackupStatus() {
  const ctx = r2Context();
  if (!ctx) {
    return { ok: true, configured: false, storage: null, database: null };
  }
  const { r2, bucket: r2Bucket } = ctx;
  const [storage, database] = await Promise.all([
    loadCursor(r2, r2Bucket, STORAGE_CURSOR_KEY),
    loadCursor(r2, r2Bucket, DB_CURSOR_KEY),
  ]);
  return { ok: true, configured: true, storage, database };
}
