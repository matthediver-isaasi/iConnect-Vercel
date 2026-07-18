/**
 * AI Composition generated-asset storage — Phase 3 (Task #2851).
 *
 * Stores a generated image buffer in the tenant media library:
 *   1. Plan storage quota check (checkStorageQuota).
 *   2. Upload to Supabase Storage (public-assets, tenant-scoped path).
 *   3. file_repository row (the media library — spec §19).
 *   4. ai_generated_asset metadata row (prompt, model, aspect, placement,
 *      alt text, usage status, parent asset, cost).
 *   5. Storage metering via addTenantStorageBytes (actual byte size).
 *
 * Throws with a friendly message on any hard failure — callers apply
 * per-asset failure isolation.
 */

import { supabase } from './database.js';
import { checkStorageQuota } from './planQuota.js';
import { addTenantStorageBytes } from './tenantStorageUsage.js';

const BUCKET = 'public-assets';

export async function storeGeneratedAsset({
  tenantId,
  memberId = null,
  compositionId = null,
  elementId = null,
  buffer,
  prompt = null,
  model = null,
  provider = 'openai',
  aspectRatio = null,
  brief = null,
  parentAssetId = null,
  usageStatus = 'in_use',
  cost = null,
}) {
  if (!supabase) throw new Error('Storage is not configured');
  if (!tenantId || !buffer?.length) throw new Error('Missing tenant or image data');

  const quota = await checkStorageQuota(tenantId, { fileSizeBytes: buffer.length });
  if (!quota.ok) {
    throw Object.assign(
      new Error(quota.body?.message || 'Storage quota exceeded'),
      { httpStatus: quota.status || 402 },
    );
  }

  const fileName = `ai-image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
  const storagePath = `${tenantId}/ai-generated/${fileName}`;

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, buffer, { contentType: 'image/png', upsert: false });
  if (upErr) throw new Error(`Failed to store the generated image: ${upErr.message}`);

  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  const url = pub?.publicUrl || null;

  const { data: fileRow, error: fileErr } = await supabase
    .from('file_repository')
    .insert({
      tenant_id: tenantId,
      file_name: fileName,
      file_url: url,
      file_type: 'image',
      mime_type: 'image/png',
      file_size: buffer.length,
      description: prompt ? `AI-generated image: ${String(prompt).slice(0, 300)}` : 'AI-generated image',
      tags: ['ai-generated'],
      bucket: BUCKET,
      storage_path: storagePath,
    })
    .select('id')
    .single();
  if (fileErr) {
    // Best-effort cleanup so orphaned objects don't accumulate.
    await supabase.storage.from(BUCKET).remove([storagePath]).catch(() => {});
    throw new Error('Failed to register the generated image in the media library');
  }

  const altText = String(brief?.accessibilityDescription || '').trim() || null;
  const { data: metaRow } = await supabase
    .from('ai_generated_asset')
    .insert({
      tenant_id: tenantId,
      file_repository_id: fileRow.id,
      composition_id: compositionId,
      element_id: elementId,
      created_by: memberId,
      prompt,
      model,
      provider,
      aspect_ratio: aspectRatio,
      placement: brief?.placement || null,
      alt_text: altText,
      usage_status: usageStatus,
      parent_asset_id: parentAssetId,
      generation_cost: cost,
      brief: brief || null,
    })
    .select('id')
    .single();

  addTenantStorageBytes(tenantId, buffer.length).catch(() => {});

  return {
    fileRepositoryId: fileRow.id,
    url,
    generatedAssetId: metaRow?.id || null,
    altText,
    sizeBytes: buffer.length,
  };
}

/** Mark an earlier generated asset replaced/alternative (usage tracking). */
export async function markGeneratedAssetUsage(tenantId, fileRepositoryId, usageStatus) {
  if (!supabase || !fileRepositoryId) return;
  await supabase
    .from('ai_generated_asset')
    .update({ usage_status: usageStatus })
    .eq('tenant_id', tenantId)
    .eq('file_repository_id', fileRepositoryId);
}

/** Look up the ai_generated_asset row for a file (for parent linking). */
export async function findGeneratedAssetByFile(tenantId, fileRepositoryId) {
  if (!supabase || !fileRepositoryId) return null;
  const { data } = await supabase
    .from('ai_generated_asset')
    .select('id, prompt, brief, aspect_ratio')
    .eq('tenant_id', tenantId)
    .eq('file_repository_id', fileRepositoryId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}
