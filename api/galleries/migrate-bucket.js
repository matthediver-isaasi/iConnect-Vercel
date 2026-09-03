/**
 * Gallery Bucket Migration
 *
 * When a gallery's `is_public` flag is toggled, its existing photos may be
 * sitting in the wrong storage bucket (private files in public-assets, or
 * vice-versa). This endpoint copies each photo to the correct bucket,
 * deletes it from the old bucket, and updates the GalleryPhoto rows so
 * `bucket`, `storage_path` and `file_url` reflect the new location.
 *
 * Public galleries -> bucket "public-assets" with permanent CDN URLs.
 * Private galleries -> bucket "private-uploads" with secure-url references
 * that require authentication.
 */

import { supabase } from '../_lib/database.js';
import { getTenantContext, hasFeatureAccess } from '../_lib/tenantContext.js';

const BUCKETS = {
  PUBLIC: 'public-assets',
  PRIVATE: 'private-uploads',
};

function buildPublicUrl(bucket, path) {
  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data?.publicUrl || null;
}

function buildSecureUrl(bucket, path) {
  return `/api/storage/secure-url?bucket=${bucket}&path=${encodeURIComponent(path)}&redirect=true`;
}

async function migratePhoto(photo, targetBucket) {
  const sourceBucket = photo.bucket;
  const path = photo.storage_path;

  if (!sourceBucket || !path) {
    return { skipped: true, reason: 'missing bucket or path' };
  }

  if (sourceBucket === targetBucket) {
    return { skipped: true, reason: 'already in target bucket' };
  }

  // Copy from source to target at the same path
  const { error: copyErr } = await supabase.storage
    .from(sourceBucket)
    .copy(path, path, { destinationBucket: targetBucket });

  if (copyErr) {
    // If copy fails because the destination already exists, treat as success
    // and proceed to delete the source. Otherwise propagate the error.
    const msg = (copyErr.message || '').toLowerCase();
    if (!msg.includes('already exists') && !msg.includes('duplicate')) {
      return { error: copyErr.message || 'copy failed' };
    }
  }

  // Delete the original
  const { error: delErr } = await supabase.storage
    .from(sourceBucket)
    .remove([path]);

  if (delErr) {
    // Never advance the database row or gallery visibility while the source
    // object still exists. This is security-critical for public-to-private
    // transitions because an orphan in public-assets remains directly
    // reachable even after the gallery policy becomes restricted. The copied
    // target is safe to leave in place: a retry treats "already exists" as a
    // successful copy and retries this source deletion.
    return { error: delErr.message || 'source delete failed' };
  }

  const newUrl =
    targetBucket === BUCKETS.PUBLIC
      ? buildPublicUrl(targetBucket, path)
      : buildSecureUrl(targetBucket, path);

  const { error: updErr } = await supabase
    .from('gallery_photo')
    .update({ bucket: targetBucket, file_url: newUrl })
    .eq('id', photo.id);

  if (updErr) {
    return { error: updErr.message || 'db update failed' };
  }

  return { migrated: true };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) {
    return res.status(503).json({ error: 'Storage not configured' });
  }

  try {
    const tenantContext = await getTenantContext(req);
    if (!tenantContext.isAuthenticated || !tenantContext.tenantId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const canManageGallery = !!tenantContext.tenantUserId
      || (tenantContext.roleId && await hasFeatureAccess(tenantContext.roleId, 'content.gallery.manage'));
    if (!canManageGallery) return res.status(403).json({ error: 'Gallery management access required' });

    const { gallery_id, target_is_public } = req.body || {};
    if (!gallery_id) {
      return res.status(400).json({ error: 'gallery_id is required' });
    }

    const { data: gallery, error: gErr } = await supabase
      .from('gallery')
      .select('id, tenant_id, is_public')
      .eq('id', gallery_id)
      .single();

    if (gErr || !gallery) {
      return res.status(404).json({ error: 'Gallery not found' });
    }

    if (gallery.tenant_id !== tenantContext.tenantId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (typeof target_is_public !== 'boolean') {
      return res.status(400).json({ error: 'target_is_public must be a boolean' });
    }
    const effectiveIsPublic = target_is_public;
    const targetBucket = effectiveIsPublic ? BUCKETS.PUBLIC : BUCKETS.PRIVATE;
    const changingVisibility = gallery.is_public !== effectiveIsPublic;

    // Private -> public is deliberately flipped first. Any failed copy leaves
    // an intended-public photo unavailable behind secure storage, rather than
    // exposing a restricted photo. Re-running this endpoint resumes the moves.
    if (changingVisibility && effectiveIsPublic) {
      const { data: updatedGallery, error: visibilityError } = await supabase
        .from('gallery')
        .update({ is_public: true, access_policy: null })
        .eq('id', gallery_id)
        .eq('tenant_id', tenantContext.tenantId)
        .select('id, tenant_id, is_public, access_policy')
        .single();
      if (visibilityError || !updatedGallery) {
        return res.status(500).json({ error: 'Failed to make gallery public; no photos were moved' });
      }
    }

    const { data: photos, error: pErr } = await supabase
      .from('gallery_photo')
      .select('id, bucket, storage_path')
      .eq('gallery_id', gallery_id)
      .eq('tenant_id', tenantContext.tenantId);

    if (pErr) {
      return res.status(500).json({ error: 'Failed to load photos' });
    }

    let migrated = 0;
    let skipped = 0;
    let failed = 0;
    const errors = [];

    for (const photo of photos || []) {
      const result = await migratePhoto(photo, targetBucket);
      if (result.migrated) migrated += 1;
      else if (result.skipped) skipped += 1;
      else if (result.error) {
        failed += 1;
        errors.push({ id: photo.id, error: result.error });
      }
    }

    if (failed) {
      return res.status(409).json({
        error: `Migration incomplete: ${failed} photo${failed === 1 ? '' : 's'} could not be moved. Retry to resume.`,
        success: false,
        visibility_changed: changingVisibility && effectiveIsPublic,
        target_bucket: targetBucket,
        total: photos?.length || 0,
        migrated,
        skipped,
        failed,
        errors,
      });
    }

    // Public -> private is flipped only after every photo is private. If this
    // update fails, the gallery remains public while some files are withheld;
    // it never becomes private while public assets remain, and retry is safe.
    let resultingGallery = gallery;
    if (changingVisibility && !effectiveIsPublic) {
      const { data: updatedGallery, error: visibilityError } = await supabase
        .from('gallery')
        .update({ is_public: false })
        .eq('id', gallery_id)
        .eq('tenant_id', tenantContext.tenantId)
        .select('id, tenant_id, is_public, access_policy')
        .single();
      if (visibilityError || !updatedGallery) {
        return res.status(409).json({
          error: 'Photos were secured but gallery visibility could not be updated. Retry to complete the transition.',
          success: false,
          visibility_changed: false,
          target_bucket: targetBucket,
          total: photos?.length || 0,
          migrated,
          skipped,
          failed: 0,
          errors: [],
        });
      }
      resultingGallery = updatedGallery;
    } else if (changingVisibility) {
      resultingGallery = { ...gallery, is_public: true, access_policy: null };
    }

    return res.json({
      success: true,
      gallery: resultingGallery,
      visibility_changed: changingVisibility,
      target_bucket: targetBucket,
      total: photos?.length || 0,
      migrated,
      skipped,
      failed,
      errors,
    });
  } catch (error) {
    console.error('[GalleryMigrate] Error:', error);
    return res
      .status(500)
      .json({ error: 'Migration failed: ' + (error.message || 'Unknown error') });
  }
}
