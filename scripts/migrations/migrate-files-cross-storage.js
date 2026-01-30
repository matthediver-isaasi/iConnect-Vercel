#!/usr/bin/env node

/**
 * Cross-Storage File Migration Script
 * 
 * Migrates files from source (single-tenant) Supabase storage to 
 * destination (multi-tenant) Supabase storage with tenant-scoped paths.
 * 
 * This script should be run AFTER the data migration (migrate-tenant.js)
 * to copy actual files and update URL references.
 * 
 * Usage:
 *   node scripts/migrations/migrate-files-cross-storage.js [options]
 * 
 * Options:
 *   --dry-run           Show what would be migrated without making changes
 *   --tenant-id=ID      Required. The tenant ID for scoped paths
 *   --batch-size=N      Number of files to process per batch (default: 10)
 *   --skip-downloaded   Skip files that have already been downloaded
 *   --tables=t1,t2      Only process specific tables
 *   --help              Show this help message
 * 
 * Required Environment Variables:
 *   SOURCE_SUPABASE_URL   - Source Supabase project URL
 *   SOURCE_SUPABASE_KEY   - Source Supabase service role key
 *   DEST_SUPABASE_URL     - Destination Supabase project URL  
 *   DEST_SUPABASE_KEY     - Destination Supabase service role key
 */

import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SOURCE_SUPABASE_URL = process.env.SOURCE_SUPABASE_URL;
const SOURCE_SUPABASE_KEY = process.env.SOURCE_SUPABASE_KEY;
const DEST_SUPABASE_URL = process.env.DEST_SUPABASE_URL;
const DEST_SUPABASE_KEY = process.env.DEST_SUPABASE_KEY;

const PROGRESS_FILE = path.join(__dirname, 'cross-storage-migration-progress.json');

const NEW_BUCKETS = {
  PUBLIC: 'public-assets',
  PRIVATE: 'private-uploads'
};

const DEFAULT_BATCH_SIZE = 10;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

function parseArgs() {
  const args = {
    dryRun: false,
    tenantId: null,
    batchSize: DEFAULT_BATCH_SIZE,
    skipDownloaded: false,
    tables: null,
    help: false
  };

  for (const arg of process.argv.slice(2)) {
    if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg.startsWith('--tenant-id=')) {
      args.tenantId = arg.split('=')[1];
    } else if (arg.startsWith('--batch-size=')) {
      args.batchSize = parseInt(arg.split('=')[1], 10) || DEFAULT_BATCH_SIZE;
    } else if (arg === '--skip-downloaded') {
      args.skipDownloaded = true;
    } else if (arg.startsWith('--tables=')) {
      args.tables = arg.split('=')[1].split(',').map(t => t.trim());
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    }
  }

  return args;
}

function showHelp() {
  console.log(`
Cross-Storage File Migration Script

Migrates files from source Supabase storage to destination Supabase storage
with tenant-scoped paths. Run this AFTER data migration.

Usage: node scripts/migrations/migrate-files-cross-storage.js [options]

Options:
  --tenant-id=ID      Required. The tenant ID for scoped paths
  --dry-run           Show what would be migrated without making changes
  --batch-size=N      Number of files to process per batch (default: 10)
  --skip-downloaded   Skip files already in progress file
  --tables=t1,t2      Only process specific tables (comma-separated)
  --help, -h          Show this help message

Supported Tables:
  file_repository, form_submission, system_settings, member, organization,
  tenant, news_post, i_edit_page, resource, event, job_posting, project_card,
  form_draft_submission, blog_post, page_banner, speaker, card_deck,
  navigation_item, i_edit_page_element, wall_of_fame

Required Environment Variables:
  SOURCE_SUPABASE_URL   Source Supabase project URL
  SOURCE_SUPABASE_KEY   Source Supabase service role key
  DEST_SUPABASE_URL     Destination Supabase project URL
  DEST_SUPABASE_KEY     Destination Supabase service role key

Examples:
  node scripts/migrations/migrate-files-cross-storage.js --tenant-id=abc123 --dry-run
  node scripts/migrations/migrate-files-cross-storage.js --tenant-id=abc123 --batch-size=20
  node scripts/migrations/migrate-files-cross-storage.js --tenant-id=abc123 --tables=file_repository
`);
}

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
    }
  } catch (e) {
    console.log('Could not load progress file, starting fresh');
  }
  return {
    migratedFiles: [],
    failedFiles: [],
    urlMappings: {},
    lastRunAt: '',
    stats: {
      totalProcessed: 0,
      totalMigrated: 0,
      totalFailed: 0,
      totalSkipped: 0
    }
  };
}

function saveProgress(progress) {
  progress.lastRunAt = new Date().toISOString();
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

function parseSupabaseStorageUrl(url) {
  if (!url || typeof url !== 'string') return null;

  try {
    const patterns = [
      /\/storage\/v1\/object\/public\/([^\/]+)\/(.+)$/,
      /\/storage\/v1\/object\/sign\/([^\/]+)\/([^?]+)/,
      /\/storage\/v1\/object\/authenticated\/([^\/]+)\/(.+)$/,
      /\/storage\/v1\/object\/private\/([^\/]+)\/(.+)$/,
      /supabase\.co\/storage\/v1\/object\/public\/([^\/]+)\/(.+)$/,
      /supabase\.co\/storage\/v1\/object\/sign\/([^\/]+)\/([^?]+)/,
      /supabase\.co\/storage\/v1\/object\/authenticated\/([^\/]+)\/(.+)$/
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) {
        let storagePath = match[2];
        try {
          storagePath = decodeURIComponent(storagePath);
        } catch (e) {
          // Keep original if decode fails
        }
        return {
          bucket: match[1],
          storagePath: storagePath,
          originalUrl: url
        };
      }
    }
  } catch (e) {
    console.warn(`Failed to parse URL: ${url}`);
  }

  return null;
}

function findUrlsInValue(value, sourceUrl, results = [], path = '') {
  if (!value) return results;
  
  if (typeof value === 'string') {
    if (isSourceStorageUrl(value, sourceUrl)) {
      results.push({ path, url: value });
    }
    return results;
  }
  
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      findUrlsInValue(item, sourceUrl, results, `${path}[${index}]`);
    });
    return results;
  }
  
  if (typeof value === 'object') {
    for (const [key, val] of Object.entries(value)) {
      const fieldPath = path ? `${path}.${key}` : key;
      if (key.includes('url') || key.includes('image') || key.includes('file') || key.includes('src')) {
        if (typeof val === 'string' && isSourceStorageUrl(val, sourceUrl)) {
          results.push({ path: fieldPath, url: val });
        }
      }
      findUrlsInValue(val, sourceUrl, results, fieldPath);
    }
    return results;
  }
  
  return results;
}

function updateUrlInObject(obj, path, newUrl) {
  const parts = path.split(/\.|\[|\]/).filter(p => p !== '');
  let current = obj;
  
  for (let i = 0; i < parts.length - 1; i++) {
    const key = isNaN(parts[i]) ? parts[i] : parseInt(parts[i], 10);
    if (current[key] === undefined) return false;
    current = current[key];
  }
  
  const lastKey = isNaN(parts[parts.length - 1]) 
    ? parts[parts.length - 1] 
    : parseInt(parts[parts.length - 1], 10);
  
  if (current[lastKey] !== undefined) {
    current[lastKey] = newUrl;
    return true;
  }
  return false;
}

function isSourceStorageUrl(url, sourceSupabaseUrl) {
  if (!url || typeof url !== 'string') return false;
  
  try {
    const sourceHost = new URL(sourceSupabaseUrl).host;
    return url.includes(sourceHost) && url.includes('/storage/');
  } catch {
    return false;
  }
}

function getNewStoragePath(originalPath, tenantId, fileType, context = {}) {
  const filename = originalPath.split('/').pop();
  
  const isBranding = fileType === 'branding' || 
    filename.toLowerCase().includes('logo') || 
    filename.toLowerCase().includes('favicon') ||
    filename.toLowerCase().includes('banner');
  
  if (isBranding) {
    return `${tenantId}/branding/${filename}`;
  }
  
  if (context.formSubmissionId) {
    return `${tenantId}/form-submissions/${context.formId || 'legacy'}/${context.formSubmissionId}/${filename}`;
  }
  
  if (context.articleId) {
    return `${tenantId}/articles/${context.articleId}/${filename}`;
  }
  
  if (context.pageId) {
    return `${tenantId}/pages/${context.pageId}/${filename}`;
  }
  
  return `${tenantId}/uploads/${filename}`;
}

async function downloadFromSource(sourceClient, bucket, storagePath) {
  let lastError;
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { data, error } = await sourceClient.storage
        .from(bucket)
        .download(storagePath);
      
      if (error) {
        throw new Error(`Download error: ${error.message}`);
      }
      
      return data;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        console.log(`    Retry ${attempt}/${MAX_RETRIES} for download...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
      }
    }
  }
  
  throw lastError;
}

async function uploadToDestination(destClient, bucket, storagePath, fileData, contentType) {
  let lastError;
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { error } = await destClient.storage
        .from(bucket)
        .upload(storagePath, fileData, {
          contentType: contentType || 'application/octet-stream',
          upsert: true
        });
      
      if (error) {
        throw new Error(`Upload error: ${error.message}`);
      }
      
      const { data: urlData } = destClient.storage
        .from(bucket)
        .getPublicUrl(storagePath);
      
      return urlData.publicUrl;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        console.log(`    Retry ${attempt}/${MAX_RETRIES} for upload...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
      }
    }
  }
  
  throw lastError;
}

function generateNewUrl(destBucket, newPath, isPrivate, destSupabaseUrl) {
  if (isPrivate) {
    return `/api/storage/secure-url?bucket=${destBucket}&path=${encodeURIComponent(newPath)}`;
  }
  return `${destSupabaseUrl}/storage/v1/object/public/${destBucket}/${encodeURIComponent(newPath)}`;
}

async function migrateFile(sourceClient, destClient, fileInfo, tenantId, dryRun) {
  const { bucket, storagePath, originalUrl } = fileInfo.parsed;
  const newPath = getNewStoragePath(storagePath, tenantId, fileInfo.fileType, fileInfo.context);
  const destBucket = fileInfo.isPrivate ? NEW_BUCKETS.PRIVATE : NEW_BUCKETS.PUBLIC;
  
  if (dryRun) {
    const previewUrl = generateNewUrl(destBucket, newPath, fileInfo.isPrivate, DEST_SUPABASE_URL);
    console.log(`  [DRY RUN] Would migrate:`);
    console.log(`    From: ${bucket}/${storagePath}`);
    console.log(`    To:   ${destBucket}/${newPath}`);
    console.log(`    URL:  ${previewUrl}`);
    return { success: true, newUrl: previewUrl, newPath, destBucket };
  }
  
  try {
    console.log(`  Downloading from source: ${bucket}/${storagePath}`);
    const fileData = await downloadFromSource(sourceClient, bucket, storagePath);
    
    console.log(`  Uploading to destination: ${destBucket}/${newPath}`);
    await uploadToDestination(
      destClient, 
      destBucket, 
      newPath, 
      fileData, 
      fileInfo.mimeType
    );
    
    const newUrl = generateNewUrl(destBucket, newPath, fileInfo.isPrivate, DEST_SUPABASE_URL);
    
    console.log(`  Success: ${newUrl}`);
    return { success: true, newUrl, newPath, destBucket };
  } catch (error) {
    console.error(`  Failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function getFileRepositoryRecords(destClient, tenantId, sourceUrl) {
  console.log('\nFetching file_repository records...');
  
  const { data, error } = await destClient
    .from('file_repository')
    .select('id, file_name, file_url, file_type, mime_type, folder_id, bucket, storage_path')
    .eq('tenant_id', tenantId);
  
  if (error) {
    console.error('Error fetching file_repository:', error);
    return [];
  }
  
  const filesToMigrate = (data || [])
    .filter(f => isSourceStorageUrl(f.file_url, sourceUrl))
    .map(f => ({
      id: f.id,
      source: 'file_repository',
      originalUrl: f.file_url,
      parsed: parseSupabaseStorageUrl(f.file_url),
      fileType: f.file_type,
      mimeType: f.mime_type,
      isPrivate: false,
      context: { folderId: f.folder_id }
    }))
    .filter(f => f.parsed !== null);
  
  console.log(`  Found ${filesToMigrate.length} files to migrate from file_repository`);
  return filesToMigrate;
}

async function getFormSubmissionFiles(destClient, tenantId, sourceUrl) {
  console.log('\nFetching form_submission files...');
  
  const { data, error } = await destClient
    .from('form_submission')
    .select('id, form_id, submission_data')
    .eq('tenant_id', tenantId);
  
  if (error) {
    console.error('Error fetching form_submission:', error);
    return [];
  }
  
  const filesToMigrate = [];
  
  for (const submission of data || []) {
    if (submission.submission_data) {
      const submissionData = typeof submission.submission_data === 'string' 
        ? JSON.parse(submission.submission_data) 
        : submission.submission_data;
      
      const foundUrls = findUrlsInValue(submissionData, sourceUrl);
      for (const { path, url } of foundUrls) {
        const parsed = parseSupabaseStorageUrl(url);
        if (parsed) {
          const safePathId = path.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30);
          filesToMigrate.push({
            id: `submission-${submission.id}-${safePathId}`,
            source: 'form_submission_nested',
            submissionId: submission.id,
            fieldPath: path,
            originalUrl: url,
            parsed,
            fileType: 'form_upload',
            mimeType: null,
            isPrivate: true,
            context: { 
              formSubmissionId: submission.id,
              formId: submission.form_id
            }
          });
        }
      }
    }
  }
  
  console.log(`  Found ${filesToMigrate.length} files to migrate from form_submission`);
  return filesToMigrate;
}

async function getBrandingFiles(destClient, tenantId, sourceUrl) {
  console.log('\nFetching branding/settings files...');
  
  const { data, error } = await destClient
    .from('system_settings')
    .select('id, setting_key, setting_value')
    .eq('tenant_id', tenantId);
  
  if (error) {
    console.error('Error fetching system_settings:', error);
    return [];
  }
  
  const filesToMigrate = [];
  const imageKeys = ['logo_url', 'favicon_url', 'banner_url', 'header_logo', 'footer_logo'];
  
  for (const setting of data || []) {
    if (imageKeys.includes(setting.setting_key)) {
      const value = setting.setting_value;
      if (value && typeof value === 'string' && isSourceStorageUrl(value, sourceUrl)) {
        const parsed = parseSupabaseStorageUrl(value);
        if (parsed) {
          filesToMigrate.push({
            id: `setting-${setting.id}`,
            source: 'system_settings',
            settingId: setting.id,
            settingKey: setting.setting_key,
            originalUrl: value,
            parsed,
            fileType: 'branding',
            mimeType: null,
            isPrivate: false,
            context: {}
          });
        }
      }
    }
  }
  
  console.log(`  Found ${filesToMigrate.length} files to migrate from system_settings`);
  return filesToMigrate;
}

async function getArticleFiles(destClient, tenantId, sourceUrl) {
  console.log('\nFetching article files...');
  
  const { data, error } = await destClient
    .from('article')
    .select('*')
    .eq('tenant_id', tenantId);
  
  if (error) {
    console.error('Error fetching article:', error);
    return [];
  }
  
  const filesToMigrate = [];
  
  for (const article of data || []) {
    if (article.featured_image && isSourceStorageUrl(article.featured_image, sourceUrl)) {
      const parsed = parseSupabaseStorageUrl(article.featured_image);
      if (parsed) {
        filesToMigrate.push({
          id: `article-${article.id}-featured`,
          source: 'article',
          articleId: article.id,
          field: 'featured_image',
          originalUrl: article.featured_image,
          parsed,
          fileType: 'article_image',
          mimeType: null,
          isPrivate: false,
          context: { articleId: article.id }
        });
      }
    }
    
    if (article.content && typeof article.content === 'string') {
      const urlMatches = article.content.match(/https?:\/\/[^\s"'<>]+/g) || [];
      for (const url of urlMatches) {
        if (isSourceStorageUrl(url, sourceUrl)) {
          const parsed = parseSupabaseStorageUrl(url);
          if (parsed) {
            filesToMigrate.push({
              id: `article-${article.id}-content-${Buffer.from(url).toString('base64').slice(0, 10)}`,
              source: 'article_content',
              articleId: article.id,
              originalUrl: url,
              parsed,
              fileType: 'article_content_image',
              mimeType: null,
              isPrivate: false,
              context: { articleId: article.id }
            });
          }
        }
      }
    }
  }
  
  console.log(`  Found ${filesToMigrate.length} files to migrate from article`);
  return filesToMigrate;
}

async function getMemberFiles(destClient, tenantId, sourceUrl) {
  console.log('\nFetching member profile files...');
  
  const { data, error } = await destClient
    .from('member')
    .select('id, profile_photo_url')
    .eq('tenant_id', tenantId);
  
  if (error) {
    console.error('Error fetching member:', error);
    return [];
  }
  
  const filesToMigrate = [];
  
  for (const member of data || []) {
    for (const field of ['profile_photo_url']) {
      const url = member[field];
      if (url && isSourceStorageUrl(url, sourceUrl)) {
        const parsed = parseSupabaseStorageUrl(url);
        if (parsed) {
          filesToMigrate.push({
            id: `member-${member.id}-${field}`,
            source: 'member',
            memberId: member.id,
            field,
            originalUrl: url,
            parsed,
            fileType: 'profile_image',
            mimeType: null,
            isPrivate: false,
            context: {}
          });
        }
      }
    }
  }
  
  console.log(`  Found ${filesToMigrate.length} files to migrate from member`);
  return filesToMigrate;
}

async function getOrganizationFiles(destClient, tenantId, sourceUrl) {
  console.log('\nFetching organization files...');
  
  const { data, error } = await destClient
    .from('organization')
    .select('id, logo_url')
    .eq('tenant_id', tenantId);
  
  if (error) {
    console.error('Error fetching organization:', error);
    return [];
  }
  
  const filesToMigrate = [];
  
  for (const org of data || []) {
    for (const field of ['logo_url']) {
      const url = org[field];
      if (url && isSourceStorageUrl(url, sourceUrl)) {
        const parsed = parseSupabaseStorageUrl(url);
        if (parsed) {
          filesToMigrate.push({
            id: `org-${org.id}-${field}`,
            source: 'organization',
            organizationId: org.id,
            field,
            originalUrl: url,
            parsed,
            fileType: 'branding',
            mimeType: null,
            isPrivate: false,
            context: {}
          });
        }
      }
    }
  }
  
  console.log(`  Found ${filesToMigrate.length} files to migrate from organization`);
  return filesToMigrate;
}

async function getTenantBrandingFiles(destClient, tenantId, sourceUrl) {
  console.log('\nFetching tenant branding files...');
  
  const { data, error } = await destClient
    .from('tenant')
    .select('*')
    .eq('id', tenantId);
  
  if (error) {
    console.error('Error fetching tenant:', error);
    return [];
  }
  
  const filesToMigrate = [];
  
  for (const tenant of data || []) {
    for (const field of ['logo_url', 'favicon_url']) {
      const url = tenant[field];
      if (url && isSourceStorageUrl(url, sourceUrl)) {
        const parsed = parseSupabaseStorageUrl(url);
        if (parsed) {
          filesToMigrate.push({
            id: `tenant-${tenant.id}-${field}`,
            source: 'tenant',
            tenantId: tenant.id,
            field,
            originalUrl: url,
            parsed,
            fileType: 'branding',
            mimeType: null,
            isPrivate: false,
            context: {}
          });
        }
      }
    }
  }
  
  console.log(`  Found ${filesToMigrate.length} files to migrate from tenant`);
  return filesToMigrate;
}

async function getNewsFiles(destClient, tenantId, sourceUrl) {
  console.log('\nFetching news files...');
  
  const { data, error } = await destClient
    .from('news_post')
    .select('*')
    .eq('tenant_id', tenantId);
  
  if (error) {
    console.error('Error fetching news:', error);
    return [];
  }
  
  const filesToMigrate = [];
  
  for (const news of data || []) {
    if (news.featured_image && isSourceStorageUrl(news.featured_image, sourceUrl)) {
      const parsed = parseSupabaseStorageUrl(news.featured_image);
      if (parsed) {
        filesToMigrate.push({
          id: `news-${news.id}-featured`,
          source: 'news_post',
          newsId: news.id,
          field: 'featured_image',
          originalUrl: news.featured_image,
          parsed,
          fileType: 'news_image',
          mimeType: null,
          isPrivate: false,
          context: {}
        });
      }
    }
    
    if (news.content && typeof news.content === 'string') {
      const urlMatches = news.content.match(/https?:\/\/[^\s"'<>]+/g) || [];
      for (const url of urlMatches) {
        if (isSourceStorageUrl(url, sourceUrl)) {
          const parsed = parseSupabaseStorageUrl(url);
          if (parsed) {
            filesToMigrate.push({
              id: `news-${news.id}-content-${Buffer.from(url).toString('base64').slice(0, 10)}`,
              source: 'news_content',
              newsId: news.id,
              originalUrl: url,
              parsed,
              fileType: 'news_content_image',
              mimeType: null,
              isPrivate: false,
              context: {}
            });
          }
        }
      }
    }
  }
  
  console.log(`  Found ${filesToMigrate.length} files to migrate from news`);
  return filesToMigrate;
}

async function getIEditPageFiles(destClient, tenantId, sourceUrl) {
  console.log('\nFetching i_edit_page files...');
  
  const { data, error } = await destClient
    .from('i_edit_page')
    .select('*')
    .eq('tenant_id', tenantId);
  
  if (error) {
    console.error('Error fetching i_edit_page:', error);
    return [];
  }
  
  const filesToMigrate = [];
  
  for (const page of data || []) {
    if (page.elements) {
      const elements = typeof page.elements === 'string' 
        ? JSON.parse(page.elements) 
        : page.elements;
      
      const foundUrls = findUrlsInValue(elements, sourceUrl);
      for (const { path, url } of foundUrls) {
        const parsed = parseSupabaseStorageUrl(url);
        if (parsed) {
          filesToMigrate.push({
            id: `iedit-${page.id}-${path.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30)}`,
            source: 'i_edit_page',
            pageId: page.id,
            fieldPath: path,
            originalUrl: url,
            parsed,
            fileType: 'page_image',
            mimeType: null,
            isPrivate: false,
            context: { pageId: page.id }
          });
        }
      }
    }
  }
  
  console.log(`  Found ${filesToMigrate.length} files to migrate from i_edit_page`);
  return filesToMigrate;
}

async function getResourceFiles(destClient, tenantId, sourceUrl) {
  console.log('\nFetching resource files...');
  
  const { data, error } = await destClient
    .from('resource')
    .select('*')
    .eq('tenant_id', tenantId);
  
  if (error) {
    console.error('Error fetching resource:', error);
    return [];
  }
  
  const filesToMigrate = [];
  
  for (const resource of data || []) {
    // Dynamically find URL fields
    for (const [field, value] of Object.entries(resource)) {
      if (value && typeof value === 'string' && isSourceStorageUrl(value, sourceUrl)) {
        const parsed = parseSupabaseStorageUrl(value);
        if (parsed) {
          filesToMigrate.push({
            id: `resource-${resource.id}-${field}`,
            source: 'resource',
            resourceId: resource.id,
            field,
            originalUrl: value,
            parsed,
            fileType: 'resource_file',
            mimeType: null,
            isPrivate: false,
            context: {}
          });
        }
      }
    }
  }
  
  console.log(`  Found ${filesToMigrate.length} files to migrate from resource`);
  return filesToMigrate;
}

async function getEventFiles(destClient, tenantId, sourceUrl) {
  console.log('\nFetching event files...');
  
  const { data, error } = await destClient
    .from('event')
    .select('*')
    .eq('tenant_id', tenantId);
  
  if (error) {
    console.error('Error fetching event:', error);
    return [];
  }
  
  const filesToMigrate = [];
  
  for (const event of data || []) {
    // Dynamically find URL fields
    for (const [field, value] of Object.entries(event)) {
      if (value && typeof value === 'string' && isSourceStorageUrl(value, sourceUrl)) {
        const parsed = parseSupabaseStorageUrl(value);
        if (parsed) {
          filesToMigrate.push({
            id: `event-${event.id}-${field}`,
            source: 'event',
            eventId: event.id,
            field,
            originalUrl: value,
            parsed,
            fileType: 'event_image',
            mimeType: null,
            isPrivate: false,
            context: {}
          });
        }
      }
    }
  }
  
  console.log(`  Found ${filesToMigrate.length} files to migrate from event`);
  return filesToMigrate;
}

async function getJobPostingFiles(destClient, tenantId, sourceUrl) {
  console.log('\nFetching job_posting files...');
  
  const { data, error } = await destClient
    .from('job_posting')
    .select('*')
    .eq('tenant_id', tenantId);
  
  if (error) {
    console.error('Error fetching job_posting:', error);
    return [];
  }
  
  const filesToMigrate = [];
  
  for (const job of data || []) {
    // Dynamically find URL fields
    for (const [field, value] of Object.entries(job)) {
      if (value && typeof value === 'string' && isSourceStorageUrl(value, sourceUrl)) {
        const parsed = parseSupabaseStorageUrl(value);
        if (parsed) {
          filesToMigrate.push({
            id: `job-${job.id}-${field}`,
            source: 'job_posting',
            jobId: job.id,
            field,
            originalUrl: value,
            parsed,
            fileType: 'job_image',
            mimeType: null,
            isPrivate: false,
            context: {}
          });
        }
      }
    }
  }
  
  console.log(`  Found ${filesToMigrate.length} files to migrate from job_posting`);
  return filesToMigrate;
}

async function getProjectCardFiles(destClient, tenantId, sourceUrl) {
  console.log('\nFetching project_card files...');
  
  const { data, error } = await destClient
    .from('project_card')
    .select('*')
    .eq('tenant_id', tenantId);
  
  if (error) {
    console.error('Error fetching project_card:', error);
    return [];
  }
  
  const filesToMigrate = [];
  
  for (const card of data || []) {
    if (card.attachments) {
      const attachments = typeof card.attachments === 'string'
        ? JSON.parse(card.attachments)
        : card.attachments;
      
      if (Array.isArray(attachments)) {
        for (let i = 0; i < attachments.length; i++) {
          const att = attachments[i];
          const url = att.file_url || att.url;
          if (url && isSourceStorageUrl(url, sourceUrl)) {
            const parsed = parseSupabaseStorageUrl(url);
            if (parsed) {
              filesToMigrate.push({
                id: `card-${card.id}-attachment-${i}`,
                source: 'project_card',
                cardId: card.id,
                attachmentIndex: i,
                originalUrl: url,
                parsed,
                fileType: 'card_attachment',
                mimeType: att.mime_type,
                isPrivate: true,
                context: {}
              });
            }
          }
        }
      }
    }
  }
  
  console.log(`  Found ${filesToMigrate.length} files to migrate from project_card`);
  return filesToMigrate;
}

async function getBlogPostFiles(destClient, tenantId, sourceUrl) {
  console.log('\nFetching blog_post files...');
  
  const { data, error } = await destClient
    .from('blog_post')
    .select('*')
    .eq('tenant_id', tenantId);
  
  if (error) {
    console.error('Error fetching blog_post:', error);
    return [];
  }
  
  const filesToMigrate = [];
  
  for (const post of data || []) {
    if (post.feature_image_url && isSourceStorageUrl(post.feature_image_url, sourceUrl)) {
      const parsed = parseSupabaseStorageUrl(post.feature_image_url);
      if (parsed) {
        filesToMigrate.push({
          id: `blog-${post.id}-featured`,
          source: 'blog_post',
          blogId: post.id,
          field: 'feature_image_url',
          originalUrl: post.feature_image_url,
          parsed,
          fileType: 'blog_image',
          mimeType: null,
          isPrivate: false,
          context: {}
        });
      }
    }
    
  }
  
  console.log(`  Found ${filesToMigrate.length} files to migrate from blog_post`);
  return filesToMigrate;
}

async function getPageBannerFiles(destClient, tenantId, sourceUrl) {
  console.log('\nFetching page_banner files...');
  
  const { data, error } = await destClient
    .from('page_banner')
    .select('*')
    .eq('tenant_id', tenantId);
  
  if (error) {
    console.error('Error fetching page_banner:', error);
    return [];
  }
  
  const filesToMigrate = [];
  
  for (const banner of data || []) {
    // Dynamically find URL fields
    for (const [field, value] of Object.entries(banner)) {
      if (value && typeof value === 'string' && isSourceStorageUrl(value, sourceUrl)) {
        const parsed = parseSupabaseStorageUrl(value);
        if (parsed) {
          filesToMigrate.push({
            id: `banner-${banner.id}-${field}`,
            source: 'page_banner',
            bannerId: banner.id,
            field,
            originalUrl: value,
            parsed,
            fileType: 'banner_image',
            mimeType: null,
            isPrivate: false,
            context: {}
          });
        }
      }
      // Check for JSONB config fields
      if (value && typeof value === 'object') {
        const foundUrls = findUrlsInValue(value, sourceUrl);
        for (const { path, url } of foundUrls) {
          const parsed = parseSupabaseStorageUrl(url);
          if (parsed) {
            const safePathId = path.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 20);
            filesToMigrate.push({
              id: `banner-${banner.id}-${field}-${safePathId}`,
              source: 'page_banner_config',
              bannerId: banner.id,
              configField: field,
              fieldPath: path,
              originalUrl: url,
              parsed,
              fileType: 'banner_config_image',
              mimeType: null,
              isPrivate: false,
              context: {}
            });
          }
        }
      }
    }
  }
  
  console.log(`  Found ${filesToMigrate.length} files to migrate from page_banner`);
  return filesToMigrate;
}

async function getSpeakerFiles(destClient, tenantId, sourceUrl) {
  console.log('\nFetching speaker files...');
  
  const { data, error } = await destClient
    .from('speaker')
    .select('*')
    .eq('tenant_id', tenantId);
  
  if (error) {
    console.error('Error fetching speaker:', error);
    return [];
  }
  
  const filesToMigrate = [];
  
  for (const speaker of data || []) {
    if (speaker.photo_url && isSourceStorageUrl(speaker.photo_url, sourceUrl)) {
      const parsed = parseSupabaseStorageUrl(speaker.photo_url);
      if (parsed) {
        filesToMigrate.push({
          id: `speaker-${speaker.id}-photo`,
          source: 'speaker',
          speakerId: speaker.id,
          field: 'photo_url',
          originalUrl: speaker.photo_url,
          parsed,
          fileType: 'speaker_photo',
          mimeType: null,
          isPrivate: false,
          context: {}
        });
      }
    }
  }
  
  console.log(`  Found ${filesToMigrate.length} files to migrate from speaker`);
  return filesToMigrate;
}

async function getCardDeckFiles(destClient, tenantId, sourceUrl) {
  console.log('\nFetching card_deck files...');
  
  const { data, error } = await destClient
    .from('card_deck')
    .select('*')
    .eq('tenant_id', tenantId);
  
  if (error) {
    console.error('Error fetching card_deck:', error);
    return [];
  }
  
  const filesToMigrate = [];
  
  for (const deck of data || []) {
    if (deck.cards) {
      const cards = typeof deck.cards === 'string' 
        ? JSON.parse(deck.cards) 
        : deck.cards;
      
      const foundUrls = findUrlsInValue(cards, sourceUrl);
      for (const { path, url } of foundUrls) {
        const parsed = parseSupabaseStorageUrl(url);
        if (parsed) {
          const safePathId = path.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 20);
          filesToMigrate.push({
            id: `deck-${deck.id}-${safePathId}`,
            source: 'card_deck',
            deckId: deck.id,
            fieldPath: path,
            originalUrl: url,
            parsed,
            fileType: 'card_image',
            mimeType: null,
            isPrivate: false,
            context: {}
          });
        }
      }
    }
  }
  
  console.log(`  Found ${filesToMigrate.length} files to migrate from card_deck`);
  return filesToMigrate;
}

async function getNavigationItemFiles(destClient, tenantId, sourceUrl) {
  console.log('\nFetching navigation_item files...');
  
  const { data, error } = await destClient
    .from('navigation_item')
    .select('*')
    .eq('tenant_id', tenantId);
  
  if (error) {
    console.error('Error fetching navigation_item:', error);
    return [];
  }
  
  const filesToMigrate = [];
  
  for (const item of data || []) {
    if (item.icon_url && isSourceStorageUrl(item.icon_url, sourceUrl)) {
      const parsed = parseSupabaseStorageUrl(item.icon_url);
      if (parsed) {
        filesToMigrate.push({
          id: `nav-${item.id}-icon`,
          source: 'navigation_item',
          navId: item.id,
          field: 'icon_url',
          originalUrl: item.icon_url,
          parsed,
          fileType: 'nav_icon',
          mimeType: null,
          isPrivate: false,
          context: {}
        });
      }
    }
    
    if (item.config) {
      const config = typeof item.config === 'string' ? JSON.parse(item.config) : item.config;
      const foundUrls = findUrlsInValue(config, sourceUrl);
      for (const { path, url } of foundUrls) {
        const parsed = parseSupabaseStorageUrl(url);
        if (parsed) {
          filesToMigrate.push({
            id: `nav-${item.id}-config-${path.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 15)}`,
            source: 'navigation_item_config',
            navId: item.id,
            fieldPath: path,
            originalUrl: url,
            parsed,
            fileType: 'nav_config_image',
            mimeType: null,
            isPrivate: false,
            context: {}
          });
        }
      }
    }
  }
  
  console.log(`  Found ${filesToMigrate.length} files to migrate from navigation_item`);
  return filesToMigrate;
}

async function getIEditPageElementFiles(destClient, tenantId, sourceUrl) {
  console.log('\nFetching i_edit_page_element files...');
  
  const { data, error } = await destClient
    .from('i_edit_page_element')
    .select('*')
    .eq('tenant_id', tenantId);
  
  if (error) {
    console.error('Error fetching i_edit_page_element:', error);
    return [];
  }
  
  const filesToMigrate = [];
  
  for (const element of data || []) {
    if (element.config) {
      const config = typeof element.config === 'string' ? JSON.parse(element.config) : element.config;
      const foundUrls = findUrlsInValue(config, sourceUrl);
      for (const { path, url } of foundUrls) {
        const parsed = parseSupabaseStorageUrl(url);
        if (parsed) {
          filesToMigrate.push({
            id: `element-${element.id}-${path.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 15)}`,
            source: 'i_edit_page_element',
            elementId: element.id,
            fieldPath: path,
            originalUrl: url,
            parsed,
            fileType: 'page_element_image',
            mimeType: null,
            isPrivate: false,
            context: {}
          });
        }
      }
    }
  }
  
  console.log(`  Found ${filesToMigrate.length} files to migrate from i_edit_page_element`);
  return filesToMigrate;
}

async function getWallOfFameFiles(destClient, tenantId, sourceUrl) {
  console.log('\nFetching wall_of_fame files...');
  
  const filesToMigrate = [];
  
  const { data: persons, error: personsError } = await destClient
    .from('wall_of_fame_person')
    .select('*')
    .eq('tenant_id', tenantId);
  
  if (!personsError && persons) {
    for (const person of persons) {
      if (person.photo_url && isSourceStorageUrl(person.photo_url, sourceUrl)) {
        const parsed = parseSupabaseStorageUrl(person.photo_url);
        if (parsed) {
          filesToMigrate.push({
            id: `wof-person-${person.id}-photo`,
            source: 'wall_of_fame_person',
            personId: person.id,
            field: 'photo_url',
            originalUrl: person.photo_url,
            parsed,
            fileType: 'wof_photo',
            mimeType: null,
            isPrivate: false,
            context: {}
          });
        }
      }
    }
  }
  
  const { data: sections, error: sectionsError } = await destClient
    .from('wall_of_fame_section')
    .select('*')
    .eq('tenant_id', tenantId);
  
  if (!sectionsError && sections) {
    for (const section of sections) {
      if (section.background_image_url && isSourceStorageUrl(section.background_image_url, sourceUrl)) {
        const parsed = parseSupabaseStorageUrl(section.background_image_url);
        if (parsed) {
          filesToMigrate.push({
            id: `wof-section-${section.id}-bg`,
            source: 'wall_of_fame_section',
            sectionId: section.id,
            field: 'background_image_url',
            originalUrl: section.background_image_url,
            parsed,
            fileType: 'wof_bg',
            mimeType: null,
            isPrivate: false,
            context: {}
          });
        }
      }
    }
  }
  
  console.log(`  Found ${filesToMigrate.length} files to migrate from wall_of_fame tables`);
  return filesToMigrate;
}

async function getFormDraftSubmissionFiles(destClient, tenantId, sourceUrl) {
  console.log('\nFetching form_draft_submission files...');
  
  const { data, error } = await destClient
    .from('form_draft_submission')
    .select('id, form_id, draft_data')
    .eq('tenant_id', tenantId);
  
  if (error) {
    console.error('Error fetching form_draft_submission:', error);
    return [];
  }
  
  const filesToMigrate = [];
  
  for (const draft of data || []) {
    if (draft.draft_data) {
      const draftData = typeof draft.draft_data === 'string' 
        ? JSON.parse(draft.draft_data) 
        : draft.draft_data;
      
      const foundUrls = findUrlsInValue(draftData, sourceUrl);
      for (const { path, url } of foundUrls) {
        const parsed = parseSupabaseStorageUrl(url);
        if (parsed) {
          filesToMigrate.push({
            id: `draft-${draft.id}-${path.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30)}`,
            source: 'form_draft_submission',
            draftId: draft.id,
            formId: draft.form_id,
            fieldPath: path,
            originalUrl: url,
            parsed,
            fileType: 'form_upload',
            mimeType: null,
            isPrivate: true,
            context: { formId: draft.form_id }
          });
        }
      }
    }
  }
  
  console.log(`  Found ${filesToMigrate.length} files to migrate from form_draft_submission`);
  return filesToMigrate;
}

async function updateDatabaseRecord(destClient, file, newUrl, newPath, destBucket, dryRun) {
  if (dryRun) {
    console.log(`  [DRY RUN] Would update ${file.source}/${file.id}`);
    return true;
  }
  
  try {
    switch (file.source) {
      case 'file_repository':
        await destClient
          .from('file_repository')
          .update({ 
            file_url: newUrl,
            storage_path: newPath,
            bucket: destBucket
          })
          .eq('id', file.id);
        break;
        
      case 'form_submission_nested':
        const { data: submissionNested } = await destClient
          .from('form_submission')
          .select('submission_data')
          .eq('id', file.submissionId)
          .single();
        
        if (submissionNested?.submission_data) {
          const submissionFormData = typeof submissionNested.submission_data === 'string' 
            ? JSON.parse(submissionNested.submission_data) 
            : submissionNested.submission_data;
          
          updateUrlInObject(submissionFormData, file.fieldPath, newUrl);
          
          await destClient
            .from('form_submission')
            .update({ submission_data: submissionFormData })
            .eq('id', file.submissionId);
        }
        break;
        
      case 'form_submission_attachment':
        const { data: subAtt } = await destClient
          .from('form_submission')
          .select('attachments')
          .eq('id', file.submissionId)
          .single();
        
        if (subAtt?.attachments) {
          const attachments = typeof subAtt.attachments === 'string'
            ? JSON.parse(subAtt.attachments)
            : subAtt.attachments;
          
          if (attachments[file.attachmentIndex]) {
            attachments[file.attachmentIndex].file_url = newUrl;
            attachments[file.attachmentIndex].url = newUrl;
            attachments[file.attachmentIndex].storage_path = newPath;
            attachments[file.attachmentIndex].bucket = destBucket;
          }
          
          await destClient
            .from('form_submission')
            .update({ attachments })
            .eq('id', file.submissionId);
        }
        break;
        
      case 'system_settings':
        await destClient
          .from('system_settings')
          .update({ setting_value: newUrl })
          .eq('id', file.settingId);
        break;
        
      case 'article':
        await destClient
          .from('article')
          .update({ [file.field]: newUrl })
          .eq('id', file.articleId);
        break;
        
      case 'article_content':
        const { data: article } = await destClient
          .from('article')
          .select('content')
          .eq('id', file.articleId)
          .single();
        
        if (article?.content) {
          const updatedContent = article.content.replace(file.originalUrl, newUrl);
          await destClient
            .from('article')
            .update({ content: updatedContent })
            .eq('id', file.articleId);
        }
        break;
        
      case 'member':
        await destClient
          .from('member')
          .update({ [file.field]: newUrl })
          .eq('id', file.memberId);
        break;
        
      case 'organization':
        await destClient
          .from('organization')
          .update({ [file.field]: newUrl })
          .eq('id', file.organizationId);
        break;
        
      case 'tenant':
        await destClient
          .from('tenant')
          .update({ [file.field]: newUrl })
          .eq('id', file.tenantId);
        break;
        
      case 'news_post':
        await destClient
          .from('news_post')
          .update({ [file.field]: newUrl })
          .eq('id', file.newsId);
        break;
        
      case 'news_content':
        const { data: newsItem } = await destClient
          .from('news_post')
          .select('content')
          .eq('id', file.newsId)
          .single();
        
        if (newsItem?.content) {
          const updatedNewsContent = newsItem.content.replace(file.originalUrl, newUrl);
          await destClient
            .from('news_post')
            .update({ content: updatedNewsContent })
            .eq('id', file.newsId);
        }
        break;
        
      case 'i_edit_page':
        const { data: pageData } = await destClient
          .from('i_edit_page')
          .select('elements')
          .eq('id', file.pageId)
          .single();
        
        if (pageData?.elements) {
          const elements = typeof pageData.elements === 'string'
            ? JSON.parse(pageData.elements)
            : pageData.elements;
          
          updateUrlInObject(elements, file.fieldPath, newUrl);
          
          await destClient
            .from('i_edit_page')
            .update({ elements })
            .eq('id', file.pageId);
        }
        break;
        
      case 'resource':
        await destClient
          .from('resource')
          .update({ [file.field]: newUrl })
          .eq('id', file.resourceId);
        break;
        
      case 'event':
        await destClient
          .from('event')
          .update({ [file.field]: newUrl })
          .eq('id', file.eventId);
        break;
        
      case 'job_posting':
        await destClient
          .from('job_posting')
          .update({ [file.field]: newUrl })
          .eq('id', file.jobId);
        break;
        
      case 'project_card':
        const { data: cardData } = await destClient
          .from('project_card')
          .select('attachments')
          .eq('id', file.cardId)
          .single();
        
        if (cardData?.attachments) {
          const cardAttachments = typeof cardData.attachments === 'string'
            ? JSON.parse(cardData.attachments)
            : cardData.attachments;
          
          if (cardAttachments[file.attachmentIndex]) {
            cardAttachments[file.attachmentIndex].file_url = newUrl;
            cardAttachments[file.attachmentIndex].url = newUrl;
            cardAttachments[file.attachmentIndex].storage_path = newPath;
            cardAttachments[file.attachmentIndex].bucket = destBucket;
          }
          
          await destClient
            .from('project_card')
            .update({ attachments: cardAttachments })
            .eq('id', file.cardId);
        }
        break;
        
      case 'form_draft_submission':
        const { data: draftDataRecord } = await destClient
          .from('form_draft_submission')
          .select('draft_data')
          .eq('id', file.draftId)
          .single();
        
        if (draftDataRecord?.draft_data) {
          const draftFormData = typeof draftDataRecord.draft_data === 'string'
            ? JSON.parse(draftDataRecord.draft_data)
            : draftDataRecord.draft_data;
          
          updateUrlInObject(draftFormData, file.fieldPath, newUrl);
          
          await destClient
            .from('form_draft_submission')
            .update({ draft_data: draftFormData })
            .eq('id', file.draftId);
        }
        break;
        
      case 'blog_post':
        await destClient
          .from('blog_post')
          .update({ [file.field]: newUrl })
          .eq('id', file.blogId);
        break;
        
      case 'blog_post_body':
        const { data: blogItem } = await destClient
          .from('blog_post')
          .select('body')
          .eq('id', file.blogId)
          .single();
        
        if (blogItem?.body) {
          const updatedBlogBody = blogItem.body.replace(file.originalUrl, newUrl);
          await destClient
            .from('blog_post')
            .update({ body: updatedBlogBody })
            .eq('id', file.blogId);
        }
        break;
        
      case 'page_banner':
        await destClient
          .from('page_banner')
          .update({ [file.field]: newUrl })
          .eq('id', file.bannerId);
        break;
        
      case 'page_banner_config':
        const { data: bannerData } = await destClient
          .from('page_banner')
          .select('config')
          .eq('id', file.bannerId)
          .single();
        
        if (bannerData?.config) {
          const bannerConfig = typeof bannerData.config === 'string'
            ? JSON.parse(bannerData.config)
            : bannerData.config;
          
          updateUrlInObject(bannerConfig, file.fieldPath, newUrl);
          
          await destClient
            .from('page_banner')
            .update({ config: bannerConfig })
            .eq('id', file.bannerId);
        }
        break;
        
      case 'speaker':
        await destClient
          .from('speaker')
          .update({ [file.field]: newUrl })
          .eq('id', file.speakerId);
        break;
        
      case 'card_deck':
        const { data: deckData } = await destClient
          .from('card_deck')
          .select('cards')
          .eq('id', file.deckId)
          .single();
        
        if (deckData?.cards) {
          const cardsData = typeof deckData.cards === 'string'
            ? JSON.parse(deckData.cards)
            : deckData.cards;
          
          updateUrlInObject(cardsData, file.fieldPath, newUrl);
          
          await destClient
            .from('card_deck')
            .update({ cards: cardsData })
            .eq('id', file.deckId);
        }
        break;
        
      case 'navigation_item':
        await destClient
          .from('navigation_item')
          .update({ [file.field]: newUrl })
          .eq('id', file.navId);
        break;
        
      case 'navigation_item_config':
        const { data: navData } = await destClient
          .from('navigation_item')
          .select('config')
          .eq('id', file.navId)
          .single();
        
        if (navData?.config) {
          const navConfig = typeof navData.config === 'string'
            ? JSON.parse(navData.config)
            : navData.config;
          
          updateUrlInObject(navConfig, file.fieldPath, newUrl);
          
          await destClient
            .from('navigation_item')
            .update({ config: navConfig })
            .eq('id', file.navId);
        }
        break;
        
      case 'i_edit_page_element':
        const { data: elemData } = await destClient
          .from('i_edit_page_element')
          .select('config')
          .eq('id', file.elementId)
          .single();
        
        if (elemData?.config) {
          const elemConfig = typeof elemData.config === 'string'
            ? JSON.parse(elemData.config)
            : elemData.config;
          
          updateUrlInObject(elemConfig, file.fieldPath, newUrl);
          
          await destClient
            .from('i_edit_page_element')
            .update({ config: elemConfig })
            .eq('id', file.elementId);
        }
        break;
        
      case 'wall_of_fame_person':
        await destClient
          .from('wall_of_fame_person')
          .update({ [file.field]: newUrl })
          .eq('id', file.personId);
        break;
        
      case 'wall_of_fame_section':
        await destClient
          .from('wall_of_fame_section')
          .update({ [file.field]: newUrl })
          .eq('id', file.sectionId);
        break;
        
      default:
        console.warn(`  Unknown source type: ${file.source}`);
        return false;
    }
    
    return true;
  } catch (error) {
    console.error(`  Failed to update database: ${error.message}`);
    return false;
  }
}

async function main() {
  const args = parseArgs();
  
  if (args.help) {
    showHelp();
    process.exit(0);
  }
  
  if (!args.tenantId) {
    console.error('Error: --tenant-id is required');
    showHelp();
    process.exit(1);
  }
  
  if (!SOURCE_SUPABASE_URL || !SOURCE_SUPABASE_KEY) {
    console.error('Error: SOURCE_SUPABASE_URL and SOURCE_SUPABASE_KEY must be set');
    process.exit(1);
  }
  
  if (!DEST_SUPABASE_URL || !DEST_SUPABASE_KEY) {
    console.error('Error: DEST_SUPABASE_URL and DEST_SUPABASE_KEY must be set');
    process.exit(1);
  }
  
  console.log('='.repeat(70));
  console.log('CROSS-STORAGE FILE MIGRATION');
  console.log('='.repeat(70));
  console.log();
  console.log(`Tenant ID: ${args.tenantId}`);
  console.log(`Dry Run: ${args.dryRun}`);
  console.log(`Batch Size: ${args.batchSize}`);
  console.log(`Source: ${SOURCE_SUPABASE_URL}`);
  console.log(`Destination: ${DEST_SUPABASE_URL}`);
  if (args.tables) {
    console.log(`Tables: ${args.tables.join(', ')}`);
  }
  console.log();
  
  const sourceClient = createClient(SOURCE_SUPABASE_URL, SOURCE_SUPABASE_KEY, {
    auth: { persistSession: false }
  });
  
  const destClient = createClient(DEST_SUPABASE_URL, DEST_SUPABASE_KEY, {
    auth: { persistSession: false }
  });
  
  const progress = loadProgress();
  console.log(`Previously migrated: ${progress.migratedFiles.length} files`);
  console.log(`Previously failed: ${progress.failedFiles.length} files`);
  
  const { data: destBuckets } = await destClient.storage.listBuckets();
  const bucketNames = destBuckets?.map(b => b.name) || [];
  
  if (!bucketNames.includes(NEW_BUCKETS.PUBLIC)) {
    console.log(`\nCreating bucket: ${NEW_BUCKETS.PUBLIC}`);
    if (!args.dryRun) {
      await destClient.storage.createBucket(NEW_BUCKETS.PUBLIC, { public: true });
    }
  }
  
  if (!bucketNames.includes(NEW_BUCKETS.PRIVATE)) {
    console.log(`\nCreating bucket: ${NEW_BUCKETS.PRIVATE}`);
    if (!args.dryRun) {
      await destClient.storage.createBucket(NEW_BUCKETS.PRIVATE, { public: false });
    }
  }
  
  let allFiles = [];
  
  const tableHandlers = {
    'file_repository': () => getFileRepositoryRecords(destClient, args.tenantId, SOURCE_SUPABASE_URL),
    'form_submission': () => getFormSubmissionFiles(destClient, args.tenantId, SOURCE_SUPABASE_URL),
    'system_settings': () => getBrandingFiles(destClient, args.tenantId, SOURCE_SUPABASE_URL),
    'member': () => getMemberFiles(destClient, args.tenantId, SOURCE_SUPABASE_URL),
    'organization': () => getOrganizationFiles(destClient, args.tenantId, SOURCE_SUPABASE_URL),
    'tenant': () => getTenantBrandingFiles(destClient, args.tenantId, SOURCE_SUPABASE_URL),
    'news_post': () => getNewsFiles(destClient, args.tenantId, SOURCE_SUPABASE_URL),
    'i_edit_page': () => getIEditPageFiles(destClient, args.tenantId, SOURCE_SUPABASE_URL),
    'resource': () => getResourceFiles(destClient, args.tenantId, SOURCE_SUPABASE_URL),
    'event': () => getEventFiles(destClient, args.tenantId, SOURCE_SUPABASE_URL),
    'job_posting': () => getJobPostingFiles(destClient, args.tenantId, SOURCE_SUPABASE_URL),
    'project_card': () => getProjectCardFiles(destClient, args.tenantId, SOURCE_SUPABASE_URL),
    'form_draft_submission': () => getFormDraftSubmissionFiles(destClient, args.tenantId, SOURCE_SUPABASE_URL),
    'blog_post': () => getBlogPostFiles(destClient, args.tenantId, SOURCE_SUPABASE_URL),
    'page_banner': () => getPageBannerFiles(destClient, args.tenantId, SOURCE_SUPABASE_URL),
    'speaker': () => getSpeakerFiles(destClient, args.tenantId, SOURCE_SUPABASE_URL),
    'card_deck': () => getCardDeckFiles(destClient, args.tenantId, SOURCE_SUPABASE_URL),
    'navigation_item': () => getNavigationItemFiles(destClient, args.tenantId, SOURCE_SUPABASE_URL),
    'i_edit_page_element': () => getIEditPageElementFiles(destClient, args.tenantId, SOURCE_SUPABASE_URL),
    'wall_of_fame': () => getWallOfFameFiles(destClient, args.tenantId, SOURCE_SUPABASE_URL)
  };
  
  const tablesToProcess = args.tables || Object.keys(tableHandlers);
  
  for (const table of tablesToProcess) {
    if (tableHandlers[table]) {
      const files = await tableHandlers[table]();
      allFiles = [...allFiles, ...files];
    } else {
      console.warn(`Unknown table: ${table}`);
    }
  }
  
  const filesToMigrate = allFiles.filter(f => !progress.migratedFiles.includes(f.id));
  
  console.log('\n' + '='.repeat(70));
  console.log(`Total files found: ${allFiles.length}`);
  console.log(`Already migrated: ${allFiles.length - filesToMigrate.length}`);
  console.log(`Files to migrate: ${filesToMigrate.length}`);
  console.log('='.repeat(70));
  
  if (filesToMigrate.length === 0) {
    console.log('\nNo files to migrate!');
    return;
  }
  
  let migrated = 0;
  let failed = 0;
  let skipped = 0;
  
  for (let i = 0; i < filesToMigrate.length; i += args.batchSize) {
    const batch = filesToMigrate.slice(i, i + args.batchSize);
    const batchNum = Math.floor(i / args.batchSize) + 1;
    const totalBatches = Math.ceil(filesToMigrate.length / args.batchSize);
    
    console.log(`\n--- Batch ${batchNum}/${totalBatches} ---`);
    
    for (const file of batch) {
      console.log(`\nProcessing: ${file.id}`);
      console.log(`  Source: ${file.source}`);
      console.log(`  URL: ${file.originalUrl.substring(0, 80)}...`);
      
      const result = await migrateFile(
        sourceClient,
        destClient,
        file,
        args.tenantId,
        args.dryRun
      );
      
      if (result.success) {
        const dbUpdated = await updateDatabaseRecord(
          destClient, 
          file, 
          result.newUrl, 
          result.newPath, 
          result.destBucket,
          args.dryRun
        );
        
        if (dbUpdated) {
          migrated++;
          progress.migratedFiles.push(file.id);
          progress.urlMappings[file.originalUrl] = result.newUrl;
        } else {
          failed++;
          progress.failedFiles.push({ id: file.id, error: 'Database update failed' });
        }
      } else {
        failed++;
        progress.failedFiles.push({ id: file.id, error: result.error });
      }
    }
    
    if (!args.dryRun) {
      progress.stats.totalProcessed = migrated + failed + skipped;
      progress.stats.totalMigrated = migrated;
      progress.stats.totalFailed = failed;
      saveProgress(progress);
    }
    
    console.log(`\nProgress: ${migrated + failed}/${filesToMigrate.length} (${migrated} migrated, ${failed} failed)`);
  }
  
  console.log('\n' + '='.repeat(70));
  console.log('MIGRATION SUMMARY');
  console.log('='.repeat(70));
  console.log(`Total processed: ${migrated + failed}`);
  console.log(`Successfully migrated: ${migrated}`);
  console.log(`Failed: ${failed}`);
  
  if (failed > 0) {
    console.log('\nFailed files:');
    progress.failedFiles.slice(-10).forEach(f => {
      console.log(`  - ${f.id}: ${f.error}`);
    });
  }
  
  if (!args.dryRun) {
    saveProgress(progress);
    console.log(`\nProgress saved to: ${PROGRESS_FILE}`);
  }
  
  if (args.dryRun) {
    console.log('\n[DRY RUN] No changes were made. Remove --dry-run to execute migration.');
  } else {
    console.log('\nMigration complete!');
  }
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
