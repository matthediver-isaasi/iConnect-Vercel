/**
 * Bounded, destination-only repair runner for the generation-aware member
 * content index.
 *
 * This command intentionally does not create an OpenAI client.  Recovery is
 * limited to persisted embeddings: a source is repaired only when the writer
 * can reuse every existing embedding.  The generation-aware indexer owns
 * claim/publish atomicity; this runner only supplies the narrow pg-backed
 * Supabase facade and the resumable budget.
 *
 * Usage:
 *   node scripts/recover-member-content-index.mjs \
 *     --tenant=<uuid> --type=blog_post
 *   node scripts/recover-member-content-index.mjs \
 *     --apply --tenant=<uuid> --type=blog_post --max-items=2 --seconds=20
 *   node scripts/recover-member-content-index.mjs \
 *     --tenant=<uuid> --type=all --cursor='{"type":"blog_post","lastId":"..."}' \
 *     --repeat --report=repair-report.json
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { connectDestination } from './lib/member-index-destination.mjs';
import {
  createMemberIndexPgClient,
  MEMBER_CONTENT_TYPES,
} from './lib/member-index-pg-client.mjs';
import { reindexAllMemberContent } from '../api/_lib/memberContentIndexer.js';

const RUN_TYPES = Object.freeze(['all', ...MEMBER_CONTENT_TYPES]);
const MAX_ITEMS_DEFAULT = 2;
const MAX_SECONDS_DEFAULT = 20;
const MAX_ITEMS = 5;
const MAX_SECONDS = 30;
const REST_PROJECT_HOST = 'lvmzliemqnieeoruhkik.supabase.co';
const TRANSPORTS = Object.freeze(['pg', 'rest']);

export function validateDestinationRestUrl(value) {
  if (typeof value !== 'string' || !value) {
    throw usageError('RECOVERY_DEST_SUPABASE_URL_REQUIRED');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw usageError('RECOVERY_DEST_SUPABASE_URL_INVALID');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== REST_PROJECT_HOST ||
    parsed.username ||
    parsed.password
  ) {
    throw usageError('RECOVERY_DEST_SUPABASE_URL_INVALID');
  }
  return value;
}

export function createDestinationRestClient({
  env = process.env,
  createClient = createSupabaseClient,
} = {}) {
  const url = validateDestinationRestUrl(env.DEST_SUPABASE_URL);
  if (typeof env.DEST_SUPABASE_KEY !== 'string' || !env.DEST_SUPABASE_KEY) {
    throw usageError('RECOVERY_DEST_SUPABASE_KEY_REQUIRED');
  }
  return createClient(url, env.DEST_SUPABASE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

function assertTransportSupportsType(options) {
  const transport = options.transport || 'pg';
  if (transport === 'pg' && (options.type === 'all' || options.type === 'canvas_page')) {
    throw usageError('RECOVERY_REST_TRANSPORT_REQUIRED');
  }
}

function usageError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function readOption(argv, index, name) {
  const argument = argv[index];
  const prefix = `--${name}=`;
  if (argument.startsWith(prefix)) return { value: argument.slice(prefix.length), next: index };
  if (argument === `--${name}`) {
    if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      throw usageError(`RECOVERY_${name.toUpperCase().replaceAll('-', '_')}_REQUIRED`);
    }
    return { value: argv[index + 1], next: index + 1 };
  }
  return null;
}

function isUuid(value) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

function parsePositiveBound(value, code, max) {
  if (!/^[0-9]+$/.test(value)) throw usageError(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw usageError(code);
  return parsed;
}

function parseCursor(value) {
  let cursor;
  try {
    cursor = JSON.parse(value);
  } catch {
    throw usageError('RECOVERY_CURSOR_JSON_INVALID');
  }
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
    throw usageError('RECOVERY_CURSOR_INVALID');
  }
  return cursor;
}

export function parseRecoveryArgs(argv = process.argv.slice(2)) {
  let apply = false;
  let repeat = false;
  let transport = 'pg';
  let tenant;
  let type;
  let maxItems = MAX_ITEMS_DEFAULT;
  let seconds = MAX_SECONDS_DEFAULT;
  let cursor = null;
  let reportPath = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      apply = true;
      continue;
    }
    if (argument === '--repeat') {
      repeat = true;
      continue;
    }
    if (argument === '--help') {
      throw usageError('RECOVERY_HELP');
    }

    const tenantOption = readOption(argv, index, 'tenant');
    if (tenantOption) {
      tenant = tenantOption.value;
      index = tenantOption.next;
      continue;
    }
    const typeOption = readOption(argv, index, 'type');
    if (typeOption) {
      type = typeOption.value;
      index = typeOption.next;
      continue;
    }
    const transportOption = readOption(argv, index, 'transport');
    if (transportOption) {
      if (!TRANSPORTS.includes(transportOption.value)) {
        throw usageError('RECOVERY_TRANSPORT_INVALID');
      }
      transport = transportOption.value;
      index = transportOption.next;
      continue;
    }
    const maxItemsOption = readOption(argv, index, 'max-items');
    if (maxItemsOption) {
      maxItems = parsePositiveBound(
        maxItemsOption.value,
        'RECOVERY_MAX_ITEMS_INVALID',
        MAX_ITEMS,
      );
      index = maxItemsOption.next;
      continue;
    }
    const secondsOption = readOption(argv, index, 'seconds');
    if (secondsOption) {
      seconds = parsePositiveBound(
        secondsOption.value,
        'RECOVERY_SECONDS_INVALID',
        MAX_SECONDS,
      );
      index = secondsOption.next;
      continue;
    }
    const cursorOption = readOption(argv, index, 'cursor');
    if (cursorOption) {
      cursor = parseCursor(cursorOption.value);
      index = cursorOption.next;
      continue;
    }
    const reportOption = readOption(argv, index, 'report');
    if (reportOption) {
      if (!reportOption.value || reportOption.value.startsWith('-')) {
        throw usageError('RECOVERY_REPORT_PATH_INVALID');
      }
      reportPath = reportOption.value;
      index = reportOption.next;
      continue;
    }
    throw usageError('RECOVERY_ARGUMENT_NOT_ALLOWED');
  }

  if (!tenant || !isUuid(tenant)) throw usageError('RECOVERY_TENANT_UUID_REQUIRED');
  if (!type || !RUN_TYPES.includes(type)) throw usageError('RECOVERY_TYPE_INVALID');

  return {
    apply,
    repeat,
    transport,
    tenant,
    type,
    maxItems,
    seconds,
    cursor,
    reportPath,
  };
}

async function configureSession(client) {
  // These are fixed statements, not caller-provided SQL.  SET LOCAL is also
  // issued inside dry-run's read-only transaction below.
  await client.query("SET statement_timeout = '15s'");
  await client.query("SET lock_timeout = '3s'");
}

function cloneCursor(cursor) {
  return cursor === null ? null : JSON.parse(JSON.stringify(cursor));
}

export function errorCodeFromValue(value) {
  if (!value) return null;
  if (typeof value === 'object') {
    if (typeof value.code === 'string') return value.code;
    if (value.error) return errorCodeFromValue(value.error);
  }
  if (typeof value === 'string') {
    const sqlState = value.match(/\b[0-9]{2}[0-9A-Z]{3}\b/);
    if (sqlState) return sqlState[0];
    const match = value.match(/\b[A-Z][A-Z0-9_]{2,}\b/);
    return match ? match[0] : 'MEMBER_INDEX_ITEM_ERROR';
  }
  return 'MEMBER_INDEX_ITEM_ERROR';
}

function summariseIndexerResult(result) {
  if (!result || typeof result !== 'object') {
    return {
      counts: { items: 0, chunks: 0, embedded: 0, reused: 0, removed: 0, errors: 1 },
      done: false,
      cursor: null,
      errorCodes: ['MEMBER_INDEX_RESULT_INVALID'],
    };
  }
  const countKeys = ['items', 'chunks', 'embedded', 'reused', 'removed', 'errors'];
  const counts = Object.fromEntries(
    countKeys.map((key) => [key, Number.isFinite(result[key]) ? result[key] : 0]),
  );
  const errorCodes = new Set();
  for (const value of result.errorCodes || []) {
    const code = errorCodeFromValue(value);
    if (code) errorCodes.add(code);
  }
  for (const detail of result.details || []) {
    const code = errorCodeFromValue(detail?.code || detail?.error || detail);
    if (code) errorCodes.add(code);
  }
  if (counts.errors > 0 && errorCodes.size === 0) {
    errorCodes.add('MEMBER_INDEX_ITEM_ERROR');
  }
  return {
    counts,
    done: result.done === true,
    cursor: result.nextCursor ?? null,
    errorCodes: [...errorCodes].sort(),
  };
}

function scopedAggregateOrThrow(result) {
  if (!result || result.error) {
    const error = new Error(result?.error?.code || 'MEMBER_INDEX_AGGREGATE_ERROR');
    error.code = result?.error?.code || 'MEMBER_INDEX_AGGREGATE_ERROR';
    throw error;
  }
  return result.data;
}

function planSummary(planResult) {
  if (!planResult || planResult.error) {
    const code = planResult?.error?.code || 'MEMBER_INDEX_PLAN_ERROR';
    return {
      counts: { items: 0, chunks: 0, embedded: 0, reused: 0, removed: 0, errors: 1 },
      cursor: null,
      done: false,
      errorCodes: [code],
    };
  }
  return {
    counts: { items: planResult.data.items, chunks: 0, embedded: 0, reused: 0, removed: 0, errors: 0 },
    cursor: planResult.data.nextCursor,
    done: planResult.data.done === true,
    errorCodes: [],
  };
}

function fingerprintOrCode(result) {
  if (!result || result.error) {
    return { errorCode: result?.error?.code || 'MEMBER_INDEX_FINGERPRINT_ERROR' };
  }
  return result.data;
}

async function runOne(client, options, { writerSupabase = null } = {}) {
  const facade = createMemberIndexPgClient({
    client,
    allowWrites: options.apply,
  });
  const contentType = options.type === 'all' ? null : options.type;
  const originalCursor = cloneCursor(options.cursor);
  const beforeType = contentType;

  if (!options.apply) {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("SET LOCAL lock_timeout = '3s'");
  }

  try {
    // For --type=all, aggregate all authored types including Canvas pages.
    // REST transport supplies the indexer's richer Canvas source queries.
    const before = scopedAggregateOrThrow(
      await facade.readScopedAggregateCounts({
        tenantId: options.tenant,
        contentType: beforeType,
      }),
    );
    const beforeFingerprint = options.apply
      ? fingerprintOrCode(
          await facade.readScopedChunkFingerprint({
            tenantId: options.tenant,
            contentType,
          }),
        )
      : null;

    if (!options.apply) {
      const plan = await facade.readScopedSourcePlan({
        tenantId: options.tenant,
        contentType,
        maxItems: options.maxItems,
        cursor: cloneCursor(originalCursor),
        deadlineMs: Date.now() + options.seconds * 1000,
      });
      const summary = planSummary(plan);
      const fingerprint = fingerprintOrCode(
        await facade.readScopedChunkFingerprint({
          tenantId: options.tenant,
          contentType,
        }),
      );
      if (fingerprint.errorCode) summary.errorCodes.push(fingerprint.errorCode);
      if (summary.errorCodes.length) summary.counts.errors = summary.errorCodes.length;
      const after = scopedAggregateOrThrow(
        await facade.readScopedAggregateCounts({
          tenantId: options.tenant,
          contentType: beforeType,
        }),
      );
      return {
        mode: 'dry-run',
        planOnly: true,
        counts: summary.counts,
        cursor: summary.cursor,
        done: summary.done,
        errorCodes: [...new Set(summary.errorCodes)].sort(),
        before,
        after,
        _fingerprint: fingerprint.errorCode ? null : fingerprint,
      };
    }

    let indexerResult;
    try {
      indexerResult = await reindexAllMemberContent({
        supabase: writerSupabase || facade,
        // Deliberately no OpenAI provider.  maxEmbeddingChunks=0 makes the
        // generation-aware writer abort a source if a persisted embedding is
        // missing or its content hash changed.
        openai: undefined,
        tenantId: options.tenant,
        contentType,
        maxItems: options.maxItems,
        maxEmbeddingChunks: 0,
        embeddingBudget: { maxEmbeddingChunks: 0 },
        deadlineMs: Date.now() + options.seconds * 1000,
        cursor: cloneCursor(originalCursor),
        dryRun: !options.apply,
        skipOrphanSweep: true,
        noOrphanSweep: true,
      });
    } catch (error) {
      indexerResult = {
        items: 0,
        chunks: 0,
        embedded: 0,
        reused: 0,
        removed: 0,
        errors: 1,
        details: [{ error: errorCodeFromValue(error) || 'MEMBER_INDEX_RUN_ERROR' }],
        done: false,
        nextCursor: originalCursor,
      };
    }

    const summary = summariseIndexerResult(indexerResult);
    const after = scopedAggregateOrThrow(
      await facade.readScopedAggregateCounts({
        tenantId: options.tenant,
        contentType: beforeType,
      }),
    );
    const afterFingerprint = fingerprintOrCode(
      await facade.readScopedChunkFingerprint({
        tenantId: options.tenant,
        contentType,
      }),
    );
    const fingerprintErrors = [beforeFingerprint, afterFingerprint]
      .filter((value) => value.errorCode)
      .map((value) => value.errorCode);
    summary.errorCodes.push(...fingerprintErrors);
    return {
      mode: options.apply ? 'apply' : 'dry-run',
      planOnly: false,
      counts: summary.counts,
      cursor: summary.cursor,
      done: summary.done,
      errorCodes: [...new Set(summary.errorCodes)].sort(),
      before,
      after,
      _fingerprint: {
        before: beforeFingerprint.errorCode ? null : beforeFingerprint,
        after: afterFingerprint.errorCode ? null : afterFingerprint,
      },
    };
  } finally {
    if (!options.apply) await client.query('ROLLBACK').catch(() => {});
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function compareChunkFingerprints(first, repeat) {
  const firstAfter = first?.after ?? first;
  const repeatAfter = repeat?.after ?? repeat;
  return (
    firstAfter !== null &&
    firstAfter !== undefined &&
    repeatAfter !== null &&
    repeatAfter !== undefined &&
    sameJson(firstAfter, repeatAfter)
  );
}

export async function runRecovery(
  options,
  { connect = connectDestination, createRestClient = createDestinationRestClient } = {},
) {
  assertTransportSupportsType(options);
  let writerSupabase = null;
  if ((options.transport || 'pg') === 'rest') {
    writerSupabase = await createRestClient();
  }
  const client = await connect();
  const startedAt = new Date().toISOString();
  try {
    await configureSession(client);
    const firstInternal = await runOne(client, options, { writerSupabase });
    const { _fingerprint: firstFingerprint, ...first } = firstInternal;
    let repeatResult = null;
    let repeatFingerprint = null;
    if (options.repeat) {
      // A repeat deliberately receives the original cursor, not first.cursor.
      // This catches accidental cursor mutation and provides a bounded
      // idempotency check for a parent-selected known-good sample.
      const repeatedOptions = { ...options, cursor: cloneCursor(options.cursor) };
      const repeatedInternal = await runOne(client, repeatedOptions, { writerSupabase });
      ({ _fingerprint: repeatFingerprint, ...repeatResult } = repeatedInternal);
    }
    const nestedErrorCodes = [
      ...(first.errorCodes || []),
      ...(repeatResult?.errorCodes || []),
    ];
    const sameChunkFingerprint = options.repeat
      ? compareChunkFingerprints(firstFingerprint, repeatFingerprint)
      : null;
    if (options.repeat && !sameChunkFingerprint) {
      const driftCode = 'MEMBER_CONTENT_REPEAT_FINGERPRINT_DRIFT';
      if (!repeatResult.errorCodes.includes(driftCode)) {
        repeatResult.errorCodes = [...repeatResult.errorCodes, driftCode].sort();
      }
      repeatResult.counts.errors += 1;
      nestedErrorCodes.push(driftCode);
    }
    return {
      observedAt: startedAt,
      tenant: options.tenant,
      type: options.type,
      transport: options.transport || 'pg',
      mode: options.apply ? 'apply' : 'dry-run',
      maxItems: options.maxItems,
      seconds: options.seconds,
      originalCursor: cloneCursor(options.cursor),
      errorCodes: [...new Set(nestedErrorCodes)].sort(),
      first,
      repeat: options.repeat
        ? {
            sameOriginalCursor: sameJson(options.cursor, cloneCursor(options.cursor)),
            sameResultCursor: sameJson(first.cursor, repeatResult.cursor),
            sameChunkFingerprint,
            result: repeatResult,
          }
        : null,
    };
  } finally {
    await client.end().catch(() => {});
  }
}

export function reportHasFailures(report) {
  if (!report || typeof report !== 'object') return true;
  if (Array.isArray(report.errorCodes) && report.errorCodes.length > 0) return true;
  if (Array.isArray(report.first?.errorCodes) && report.first.errorCodes.length > 0) {
    return true;
  }
  if (
    Array.isArray(report.repeat?.result?.errorCodes) &&
    report.repeat.result.errorCodes.length > 0
  ) {
    return true;
  }
  return false;
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  let options;
  try {
    options = parseRecoveryArgs(argv);
  } catch (error) {
    const code = error?.code || 'RECOVERY_ARGUMENTS_INVALID';
    if (code === 'RECOVERY_HELP') {
      console.log(
        'Usage: node scripts/recover-member-content-index.mjs ' +
          '--tenant=<uuid> --type=<all|resource|event|complex_event|news_post|blog_post|canvas_page> ' +
          '[--transport=pg|rest] ' +
          '[--apply] [--max-items=1..5] [--seconds=1..30] [--cursor=<json>] [--repeat] [--report=<path>]',
      );
      return null;
    }
    console.error(JSON.stringify({ errorCodes: [code] }));
    return { errorCodes: [code] };
  }

  try {
    const report = await runRecovery(options, dependencies);
    if (options.reportPath) {
      await fs.writeFile(
        path.resolve(options.reportPath),
        `${JSON.stringify(report, null, 2)}\n`,
        'utf8',
      );
    }
    // This is intentionally a machine-readable, source-free report.  It does
    // not print indexer details (which can contain source IDs/text).
    console.log(JSON.stringify(report));
    return report;
  } catch (error) {
    const code = error?.code || errorCodeFromValue(error) || 'RECOVERY_FAILED';
    console.error(JSON.stringify({ errorCodes: [code] }));
    return { errorCodes: [code] };
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath && import.meta.url === invokedPath) {
  const result = await main();
  if (reportHasFailures(result)) process.exitCode = 1;
}
