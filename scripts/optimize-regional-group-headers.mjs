#!/usr/bin/env node
/**
 * One-off, fail-closed optimizer for the 15 member-group headers selected by
 * the published "Regional Leads" Canvas page.
 *
 * Dry-run is the default:
 *   node scripts/optimize-regional-group-headers.mjs
 *
 * Upload immutable WebP variants and switch the 15 header URLs:
 *   node scripts/optimize-regional-group-headers.mjs --apply
 *
 * Preview or apply a restoration from a generated manifest:
 *   node scripts/optimize-regional-group-headers.mjs --restore=<manifest>
 *   node scripts/optimize-regional-group-headers.mjs --restore=<manifest> --apply
 *
 * Safety properties:
 *   - Scope, tenant, page/block configuration, source URLs, and source bytes are
 *     pinned in scripts/data/regional-group-headers-baseline.json.
 *   - A timestamped rollback manifest is written before any storage or DB write.
 *   - All 15 assets are prepared and verified before any group row is updated.
 *   - DB updates compare the current URL and roll back this run on partial failure.
 *   - The Canvas design, full group records except header_image_url, tenant-wide
 *     header URL set, source objects, and replacement objects are verified after.
 *   - Immutable target paths and accepted source/target URL states make re-runs safe.
 */

import { createClient } from '@supabase/supabase-js';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PUBLIC_BUCKET,
  TARGET_HEIGHT,
  TARGET_MAX_TOTAL_BYTES,
  TARGET_QUALITY,
  TARGET_WIDTH,
  assertMetadata,
  buildTargetPath,
  createOptimizedImage,
  diffHeaderUrls,
  findBlocksByType,
  inspectImage,
  sha256,
  stableJsonString,
  verifyOrRollback,
  withoutHeaderImage,
} from './lib/regionalGroupHeaders.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = resolve(__dirname, 'data', 'regional-group-headers-baseline.json');
const BACKUP_ROOT = resolve(__dirname, 'backups', 'regional-group-headers');
const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const restoreArg = argv.find((arg) => arg.startsWith('--restore='));
const RESTORE_PATH = restoreArg ? resolve(process.cwd(), restoreArg.slice('--restore='.length)) : null;

const SUPABASE_URL = process.env.DEST_SUPABASE_URL;
const SUPABASE_KEY = process.env.DEST_SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing DEST_SUPABASE_URL / DEST_SUPABASE_KEY.');
  process.exit(2);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

function runStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function fail(message) {
  throw new Error(message);
}

function assertEqual(actual, expected, label) {
  if (stableJsonString(actual) !== stableJsonString(expected)) {
    fail(`${label} changed.\nExpected: ${JSON.stringify(expected)}\nReceived: ${JSON.stringify(actual)}`);
  }
}

function verificationUrl(url, token) {
  const parsed = new URL(url);
  parsed.searchParams.set('verify', token);
  return parsed.toString();
}

async function fetchBuffer(url, label, { allowMissing = false } = {}) {
  const response = await fetch(url, {
    headers: { accept: 'image/avif,image/webp,image/png,image/*,*/*' },
    cache: 'no-store',
  });
  if (allowMissing && response.status === 404) return null;
  if (allowMissing && response.status === 400) {
    const body = await response.clone().json().catch(() => null);
    if (
      body?.statusCode === '404'
      && body?.error === 'not_found'
      && body?.code === 'NoSuchKey'
    ) {
      return null;
    }
  }
  if (!response.ok) fail(`${label} returned HTTP ${response.status}: ${url}`);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith('image/')) {
    fail(`${label} returned non-image content type ${JSON.stringify(contentType)}: ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function fetchPage() {
  const { data, error } = await supabase
    .from('i_edit_page')
    .select('id, tenant_id, title, slug, status, builder_type, canvas_design')
    .eq('id', baseline.page.id)
    .maybeSingle();
  if (error) fail(`Could not load Regional Leads page: ${error.message}`);
  if (!data) fail(`Regional Leads page ${baseline.page.id} does not exist.`);
  return data;
}

function assertPageScope(page) {
  assertEqual({
    id: page.id,
    tenantId: page.tenant_id,
    title: page.title,
    slug: page.slug,
    status: page.status,
    builderType: page.builder_type,
  }, baseline.page, 'Page identity');

  const matches = findBlocksByType(page.canvas_design, baseline.block.type);
  if (matches.length !== 1) {
    fail(`Expected exactly one ${baseline.block.type} block, found ${matches.length}.`);
  }
  const block = matches[0].block;
  assertEqual({
    id: block.id,
    type: block.type,
    source: block.content?.source,
    columns: block.content?.columns,
    selectedGroupIds: block.content?.selectedGroupIds,
  }, baseline.block, 'Regional Leads member-group block');
  return block;
}

async function fetchSelectedGroups() {
  const ids = baseline.block.selectedGroupIds;
  const { data, error } = await supabase
    .from('member_group')
    .select('*')
    .eq('tenant_id', baseline.page.tenantId)
    .in('id', ids);
  if (error) fail(`Could not load selected member groups: ${error.message}`);
  if (data.length !== ids.length) {
    fail(`Expected ${ids.length} tenant-owned member groups, found ${data.length}.`);
  }
  const byId = new Map(data.map((row) => [row.id, row]));
  return ids.map((id) => {
    const row = byId.get(id);
    if (!row) fail(`Selected member group ${id} is missing or belongs to another tenant.`);
    return row;
  });
}

async function fetchTenantHeaders() {
  const { data, error } = await supabase
    .from('member_group')
    .select('id, header_image_url')
    .eq('tenant_id', baseline.page.tenantId);
  if (error) fail(`Could not load tenant member-group headers: ${error.message}`);
  return data;
}

function getTargetUrl(targetPath) {
  const { data } = supabase.storage.from(PUBLIC_BUCKET).getPublicUrl(targetPath);
  if (!data?.publicUrl) fail(`Could not create public URL for ${targetPath}.`);
  return data.publicUrl;
}

async function prepareAssets(groups) {
  const groupById = new Map(groups.map((row) => [row.id, row]));
  const prepared = [];

  for (const [index, expected] of baseline.groups.entries()) {
    const row = groupById.get(expected.id);
    if (!row) fail(`Baseline group ${expected.id} is not selected by the page.`);
    if (row.tenant_id !== baseline.page.tenantId) fail(`${expected.name} belongs to the wrong tenant.`);
    if (row.name !== expected.name) {
      fail(`Group ${expected.id} was renamed from ${JSON.stringify(expected.name)} to ${JSON.stringify(row.name)}.`);
    }
    if (row.is_active !== true) fail(`${expected.name} is no longer active.`);

    const targetPath = buildTargetPath({
      tenantId: baseline.page.tenantId,
      groupId: expected.id,
      sourceSha256: expected.source.sha256,
    });
    const targetUrl = getTargetUrl(targetPath);
    if (row.header_image_url !== expected.sourceUrl && row.header_image_url !== targetUrl) {
      fail(
        `${expected.name} header URL changed outside this operation.\n`
        + `Expected source: ${expected.sourceUrl}\nExpected target: ${targetUrl}\n`
        + `Received: ${row.header_image_url}`,
      );
    }

    const sourceBuffer = await fetchBuffer(
      verificationUrl(expected.sourceUrl, expected.source.sha256.slice(0, 12)),
      `${expected.name} source`,
    );
    const sourceMetadata = await inspectImage(sourceBuffer);
    assertMetadata(sourceMetadata, expected.source, `${expected.name} source`);

    const targetBuffer = await createOptimizedImage(sourceBuffer);
    const targetMetadata = await inspectImage(targetBuffer);
    if (
      targetMetadata.format !== 'webp'
      || targetMetadata.width !== TARGET_WIDTH
      || targetMetadata.height !== TARGET_HEIGHT
    ) {
      fail(`${expected.name} did not produce a ${TARGET_WIDTH}x${TARGET_HEIGHT} WebP.`);
    }

    prepared.push({
      id: expected.id,
      name: expected.name,
      sourceUrl: expected.sourceUrl,
      source: sourceMetadata,
      targetPath,
      targetUrl,
      target: targetMetadata,
      targetBuffer,
      currentHeaderUrl: row.header_image_url,
    });
    console.log(
      `  [${String(index + 1).padStart(2, '0')}/${baseline.groups.length}] `
      + `${expected.name}: ${sourceMetadata.bytes.toLocaleString()} -> `
      + `${targetMetadata.bytes.toLocaleString()} bytes`,
    );
  }

  const sourceTotalBytes = prepared.reduce((sum, item) => sum + item.source.bytes, 0);
  const targetTotalBytes = prepared.reduce((sum, item) => sum + item.target.bytes, 0);
  if (targetTotalBytes > TARGET_MAX_TOTAL_BYTES) {
    fail(
      `Optimized payload is ${targetTotalBytes.toLocaleString()} bytes; `
      + `limit is ${TARGET_MAX_TOTAL_BYTES.toLocaleString()} bytes.`,
    );
  }
  return { prepared, sourceTotalBytes, targetTotalBytes };
}

function manifestGroup(item) {
  const { targetBuffer: _targetBuffer, ...serializable } = item;
  return serializable;
}

function persistManifest(path, manifest) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function ensureTargetObjects(prepared, manifest, manifestPath) {
  for (const [index, item] of prepared.entries()) {
    const verifyUrl = verificationUrl(item.targetUrl, item.target.sha256.slice(0, 12));
    let existing = await fetchBuffer(
      verifyUrl,
      `${item.name} existing target`,
      { allowMissing: true },
    );
    let storageAction = 'reused';

    if (existing) {
      const existingMetadata = await inspectImage(existing);
      assertMetadata(existingMetadata, item.target, `${item.name} existing target`);
    } else {
      const { error } = await supabase.storage
        .from(PUBLIC_BUCKET)
        .upload(item.targetPath, item.targetBuffer, {
          contentType: 'image/webp',
          cacheControl: '31536000',
          upsert: false,
        });
      if (error) fail(`Could not upload ${item.name}: ${error.message}`);
      storageAction = 'uploaded';
      existing = await fetchBuffer(
        verificationUrl(item.targetUrl, `${item.target.sha256.slice(0, 12)}-${Date.now()}`),
        `${item.name} uploaded target`,
      );
      assertMetadata(await inspectImage(existing), item.target, `${item.name} uploaded target`);
    }

    manifest.groups[index].storageAction = storageAction;
    persistManifest(manifestPath, manifest);
    console.log(`  ${storageAction === 'uploaded' ? 'uploaded' : 'reused  '} ${item.name}`);
  }
  manifest.status = 'assets-ready';
  manifest.assetsReadyAt = new Date().toISOString();
  persistManifest(manifestPath, manifest);
}

async function rollbackHeaderUpdates(changedItems) {
  const failures = [];
  for (const item of [...changedItems].reverse()) {
    const { data, error } = await supabase
      .from('member_group')
      .update({ header_image_url: item.sourceUrl })
      .eq('id', item.id)
      .eq('tenant_id', baseline.page.tenantId)
      .eq('header_image_url', item.targetUrl)
      .select('id')
      .maybeSingle();
    if (error || !data) failures.push(`${item.name}: ${error?.message || 'compare-and-set missed'}`);
  }
  if (failures.length) {
    fail(`Header rollback was incomplete:\n${failures.join('\n')}`);
  }
}

async function restoreTargetHeaders(restoredItems) {
  const failures = [];
  for (const item of [...restoredItems].reverse()) {
    const { data, error } = await supabase
      .from('member_group')
      .update({ header_image_url: item.targetUrl })
      .eq('id', item.id)
      .eq('tenant_id', baseline.page.tenantId)
      .eq('header_image_url', item.sourceUrl)
      .select('id')
      .maybeSingle();
    if (error || !data) failures.push(`${item.name}: ${error?.message || 'compare-and-set missed'}`);
  }
  if (failures.length) {
    fail(`Restore rollback was incomplete:\n${failures.join('\n')}`);
  }
}

async function switchHeaders(prepared) {
  const changed = [];
  try {
    for (const item of prepared) {
      if (item.currentHeaderUrl === item.targetUrl) {
        console.log(`  unchanged ${item.name} (already optimized)`);
        continue;
      }
      const { data, error } = await supabase
        .from('member_group')
        .update({ header_image_url: item.targetUrl })
        .eq('id', item.id)
        .eq('tenant_id', baseline.page.tenantId)
        .eq('header_image_url', item.sourceUrl)
        .select('id')
        .maybeSingle();
      if (error || !data) {
        fail(`${item.name} update failed: ${error?.message || 'source URL changed concurrently'}`);
      }
      changed.push(item);
      console.log(`  updated   ${item.name}`);
    }
    return changed;
  } catch (error) {
    console.error(`Update failed after ${changed.length} row(s); rolling those rows back...`);
    await rollbackHeaderUpdates(changed);
    throw error;
  }
}

async function verifyFinalState({
  pageBefore,
  groupsBefore,
  tenantHeadersBefore,
  prepared,
  expectedUrlKey,
  allowedTenantDiffIds,
}) {
  const pageAfter = await fetchPage();
  assertPageScope(pageAfter);
  assertEqual(pageAfter.canvas_design, pageBefore.canvas_design, 'Canvas design');

  const groupsAfter = await fetchSelectedGroups();
  const beforeById = new Map(groupsBefore.map((row) => [row.id, row]));
  const preparedById = new Map(prepared.map((item) => [item.id, item]));
  for (const row of groupsAfter) {
    const before = beforeById.get(row.id);
    assertEqual(
      withoutHeaderImage(row),
      withoutHeaderImage(before),
      `${row.name} non-header fields`,
    );
    const expectedUrl = preparedById.get(row.id)[expectedUrlKey];
    if (row.header_image_url !== expectedUrl) {
      fail(`${row.name} has ${row.header_image_url}, expected ${expectedUrl}.`);
    }
  }

  const tenantHeadersAfter = await fetchTenantHeaders();
  const tenantDiff = diffHeaderUrls(tenantHeadersBefore, tenantHeadersAfter);
  assertEqual(
    tenantDiff.map((entry) => entry.id).sort(),
    [...allowedTenantDiffIds].sort(),
    'Tenant-wide changed member-group IDs',
  );

  let targetTotalBytes = 0;
  for (const item of prepared) {
    const sourceBuffer = await fetchBuffer(
      verificationUrl(item.sourceUrl, `original-${item.source.sha256.slice(0, 12)}`),
      `${item.name} preserved source`,
    );
    assertMetadata(await inspectImage(sourceBuffer), item.source, `${item.name} preserved source`);

    const targetBuffer = await fetchBuffer(
      verificationUrl(item.targetUrl, `target-${item.target.sha256.slice(0, 12)}`),
      `${item.name} public target`,
    );
    const targetMetadata = await inspectImage(targetBuffer);
    assertMetadata(targetMetadata, item.target, `${item.name} public target`);
    targetTotalBytes += targetMetadata.bytes;
  }
  if (targetTotalBytes > TARGET_MAX_TOTAL_BYTES) {
    fail(`Verified target total ${targetTotalBytes} exceeds ${TARGET_MAX_TOTAL_BYTES}.`);
  }

  return { groupsAfter, tenantDiff, targetTotalBytes };
}

async function verifyHeadersRestoredToSnapshot(groupsBefore, tenantHeadersBefore) {
  const groupsAfter = await fetchSelectedGroups();
  assertEqual(
    groupsAfter.map((row) => ({ id: row.id, header_image_url: row.header_image_url })),
    groupsBefore.map((row) => ({ id: row.id, header_image_url: row.header_image_url })),
    'Selected group headers after rollback',
  );
  const tenantHeadersAfter = await fetchTenantHeaders();
  assertEqual(
    diffHeaderUrls(tenantHeadersBefore, tenantHeadersAfter),
    [],
    'Tenant member-group headers after rollback',
  );
}

async function optimize() {
  console.log(`Regional Group Header Optimizer [${APPLY ? 'APPLY' : 'DRY-RUN'}]`);
  console.log(`Page: ${baseline.page.title} (${baseline.page.id})`);
  console.log(`Transform: centre-crop ${TARGET_WIDTH}x${TARGET_HEIGHT} WebP q${TARGET_QUALITY}`);

  const pageBefore = await fetchPage();
  assertPageScope(pageBefore);
  const groupsBefore = await fetchSelectedGroups();
  const tenantHeadersBefore = await fetchTenantHeaders();

  console.log('\nInspecting pinned sources and preparing replacements...');
  const { prepared, sourceTotalBytes, targetTotalBytes } = await prepareAssets(groupsBefore);
  const reduction = (1 - targetTotalBytes / sourceTotalBytes) * 100;
  console.log(
    `\nPayload: ${sourceTotalBytes.toLocaleString()} -> ${targetTotalBytes.toLocaleString()} bytes `
    + `(${reduction.toFixed(1)}% smaller)`,
  );

  if (!APPLY) {
    console.log('\nDry-run passed. No storage objects or database records were changed.');
    console.log('Run again with --apply to upload and switch the 15 URLs.');
    return;
  }

  const stamp = runStamp();
  const runDir = resolve(BACKUP_ROOT, stamp);
  const manifestPath = resolve(runDir, 'manifest.json');
  const manifest = {
    version: 1,
    operation: 'optimize-regional-group-headers',
    status: 'prepared',
    createdAt: new Date().toISOString(),
    page: {
      ...baseline.page,
      canvasDesignSha256: sha256(stableJsonString(pageBefore.canvas_design)),
    },
    block: baseline.block,
    transform: {
      format: 'webp',
      width: TARGET_WIDTH,
      height: TARGET_HEIGHT,
      fit: 'cover',
      position: 'centre',
      quality: TARGET_QUALITY,
    },
    storage: {
      bucket: PUBLIC_BUCKET,
      immutable: true,
      originalsDeleted: false,
    },
    summary: {
      groupCount: prepared.length,
      sourceTotalBytes,
      targetTotalBytes,
      reductionPercent: Number(reduction.toFixed(2)),
    },
    groups: prepared.map(manifestGroup),
  };

  // This is deliberately before the first storage upload or DB update.
  persistManifest(manifestPath, manifest);
  console.log(`\nRollback manifest written: ${manifestPath}`);

  console.log('\nEnsuring all immutable target objects exist...');
  await ensureTargetObjects(prepared, manifest, manifestPath);

  console.log('\nSwitching member-group header URLs...');
  const changed = await switchHeaders(prepared);
  manifest.status = 'headers-switched';
  manifest.headersSwitchedAt = new Date().toISOString();
  manifest.changedGroupIds = changed.map((item) => item.id);
  persistManifest(manifestPath, manifest);

  console.log('\nVerifying database, Canvas, original objects, and public targets...');
  const verified = await verifyOrRollback(
    () => verifyFinalState({
      pageBefore,
      groupsBefore,
      tenantHeadersBefore,
      prepared,
      expectedUrlKey: 'targetUrl',
      allowedTenantDiffIds: changed.map((item) => item.id),
    }),
    async (verificationError) => {
      manifest.status = 'verification-failed';
      manifest.verificationError = verificationError.message;
      persistManifest(manifestPath, manifest);
      try {
        await rollbackHeaderUpdates(changed);
        await verifyHeadersRestoredToSnapshot(groupsBefore, tenantHeadersBefore);
        manifest.status = 'rolled-back-after-verification-failure';
        manifest.rolledBackAt = new Date().toISOString();
        persistManifest(manifestPath, manifest);
      } catch (rollbackError) {
        manifest.status = 'rollback-failed';
        manifest.rollbackError = rollbackError.message;
        persistManifest(manifestPath, manifest);
        throw rollbackError;
      }
    },
  );

  manifest.status = 'complete';
  manifest.verifiedAt = new Date().toISOString();
  manifest.verification = {
    canvasDesignUnchanged: true,
    nonHeaderGroupFieldsUnchanged: true,
    sourceObjectsPreserved: true,
    publicTargetsReachable: true,
    targetTotalBytes: verified.targetTotalBytes,
    tenantHeaderDiff: verified.tenantDiff,
  };
  persistManifest(manifestPath, manifest);

  console.log(`\nComplete. Verified ${prepared.length} replacement URLs.`);
  console.log(`Aggregate transfer: ${verified.targetTotalBytes.toLocaleString()} bytes.`);
  console.log(`Manifest: ${manifestPath}`);
}

async function restore(manifestPath) {
  const sourceManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (
    sourceManifest.operation !== 'optimize-regional-group-headers'
    || sourceManifest.status !== 'complete'
    || sourceManifest.page?.id !== baseline.page.id
    || sourceManifest.page?.tenantId !== baseline.page.tenantId
    || !Array.isArray(sourceManifest.groups)
    || sourceManifest.groups.length !== baseline.groups.length
  ) {
    fail(`Manifest is not a valid Regional Leads header manifest: ${manifestPath}`);
  }
  assertEqual(sourceManifest.block, baseline.block, 'Restore manifest block');
  assertEqual(sourceManifest.transform, {
    format: 'webp',
    width: TARGET_WIDTH,
    height: TARGET_HEIGHT,
    fit: 'cover',
    position: 'centre',
    quality: TARGET_QUALITY,
  }, 'Restore manifest transform');
  assertEqual(sourceManifest.storage, {
    bucket: PUBLIC_BUCKET,
    immutable: true,
    originalsDeleted: false,
  }, 'Restore manifest storage policy');
  assertEqual(
    sourceManifest.groups.map((item) => item.id),
    baseline.groups.map((item) => item.id),
    'Restore manifest group order',
  );

  for (const [index, item] of sourceManifest.groups.entries()) {
    const expected = baseline.groups[index];
    assertEqual({
      id: item.id,
      name: item.name,
      sourceUrl: item.sourceUrl,
      source: item.source,
    }, expected, `Restore manifest source ${index + 1}`);
    const expectedTargetPath = buildTargetPath({
      tenantId: baseline.page.tenantId,
      groupId: expected.id,
      sourceSha256: expected.source.sha256,
    });
    if (item.targetPath !== expectedTargetPath) {
      fail(`${expected.name} restore target path is not derived from the pinned source.`);
    }
    if (item.targetUrl !== getTargetUrl(expectedTargetPath)) {
      fail(`${expected.name} restore target URL is not the pinned public object URL.`);
    }
  }

  console.log(`Regional Group Header Restore [${APPLY ? 'APPLY' : 'DRY-RUN'}]`);
  console.log(`Manifest: ${manifestPath}`);

  const pageBefore = await fetchPage();
  assertPageScope(pageBefore);
  const groupsBefore = await fetchSelectedGroups();
  const tenantHeadersBefore = await fetchTenantHeaders();
  const groupById = new Map(groupsBefore.map((row) => [row.id, row]));

  for (const item of sourceManifest.groups) {
    const row = groupById.get(item.id);
    if (!row) fail(`Manifest group ${item.id} is not selected by the page.`);
    if (row.header_image_url !== item.sourceUrl && row.header_image_url !== item.targetUrl) {
      fail(`${item.name} URL is neither the manifest source nor target URL.`);
    }
    const sourceBuffer = await fetchBuffer(
      verificationUrl(item.sourceUrl, `restore-${item.source.sha256.slice(0, 12)}`),
      `${item.name} restore source`,
    );
    assertMetadata(await inspectImage(sourceBuffer), item.source, `${item.name} restore source`);
    const regeneratedTarget = await createOptimizedImage(sourceBuffer);
    assertMetadata(
      await inspectImage(regeneratedTarget),
      item.target,
      `${item.name} restore target`,
    );
  }

  if (!APPLY) {
    const count = sourceManifest.groups.filter(
      (item) => groupById.get(item.id).header_image_url === item.targetUrl,
    ).length;
    console.log(`Dry-run passed. ${count} header URL(s) would be restored; no writes were made.`);
    return;
  }

  const restoreManifestPath = resolve(
    BACKUP_ROOT,
    runStamp(),
    'restore-manifest.json',
  );
  const restoreManifest = {
    version: 1,
    operation: 'restore-regional-group-headers',
    status: 'prepared',
    createdAt: new Date().toISOString(),
    sourceManifest: manifestPath,
    page: sourceManifest.page,
    groups: sourceManifest.groups.map(({ id, name, sourceUrl, targetUrl }) => ({
      id,
      name,
      sourceUrl,
      targetUrl,
      currentHeaderUrl: groupById.get(id).header_image_url,
    })),
  };
  persistManifest(restoreManifestPath, restoreManifest);

  const restored = [];
  try {
    for (const item of sourceManifest.groups) {
      const row = groupById.get(item.id);
      if (row.header_image_url === item.sourceUrl) continue;
      const { data, error } = await supabase
        .from('member_group')
        .update({ header_image_url: item.sourceUrl })
        .eq('id', item.id)
        .eq('tenant_id', baseline.page.tenantId)
        .eq('header_image_url', item.targetUrl)
        .select('id')
        .maybeSingle();
      if (error || !data) fail(`${item.name} restore failed: ${error?.message || 'compare-and-set missed'}`);
      restored.push(item);
    }
  } catch (error) {
    await restoreTargetHeaders(restored);
    throw error;
  }

  const prepared = sourceManifest.groups.map((item) => ({
    ...item,
    targetBuffer: undefined,
  }));
  const verified = await verifyOrRollback(
    () => verifyFinalState({
      pageBefore,
      groupsBefore,
      tenantHeadersBefore,
      prepared,
      expectedUrlKey: 'sourceUrl',
      allowedTenantDiffIds: restored.map((item) => item.id),
    }),
    async (verificationError) => {
      restoreManifest.status = 'verification-failed';
      restoreManifest.verificationError = verificationError.message;
      persistManifest(restoreManifestPath, restoreManifest);
      try {
        await restoreTargetHeaders(restored);
        await verifyHeadersRestoredToSnapshot(groupsBefore, tenantHeadersBefore);
        restoreManifest.status = 'rolled-back-after-verification-failure';
        restoreManifest.rolledBackAt = new Date().toISOString();
        persistManifest(restoreManifestPath, restoreManifest);
      } catch (rollbackError) {
        restoreManifest.status = 'rollback-failed';
        restoreManifest.rollbackError = rollbackError.message;
        persistManifest(restoreManifestPath, restoreManifest);
        throw rollbackError;
      }
    },
  );
  restoreManifest.status = 'complete';
  restoreManifest.verifiedAt = new Date().toISOString();
  restoreManifest.restoredGroupIds = restored.map((item) => item.id);
  restoreManifest.tenantHeaderDiff = verified.tenantDiff;
  persistManifest(restoreManifestPath, restoreManifest);
  console.log(`Restore complete. Manifest: ${restoreManifestPath}`);
}

try {
  if (RESTORE_PATH) await restore(RESTORE_PATH);
  else await optimize();
} catch (error) {
  console.error(`\nFAILED: ${error.message}`);
  process.exitCode = 1;
}