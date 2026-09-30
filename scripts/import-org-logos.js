import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { parse } from 'csv-parse/sync';
import path from 'path';

const TENANT_ID = '21296ad6-1350-483a-a90c-1b06ece70501';
const BUCKET = 'public-assets';
const FOLDER = 'organisation_logos';

const supabaseUrl = process.env.DEST_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.DEST_SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL/DEST_SUPABASE_URL or SUPABASE_SERVICE_KEY/DEST_SUPABASE_KEY');
  process.exit(1);
}

console.log(`Using Supabase: ${supabaseUrl}`);

const supabase = createClient(supabaseUrl, supabaseKey);

function extractExtension(url) {
  try {
    const filepathParam = new URL(url).searchParams.get('filepath');
    if (filepathParam) {
      const ext = path.extname(filepathParam).toLowerCase();
      if (ext) return ext;
    }
  } catch {}
  return '.png';
}

function getContentType(ext) {
  const map = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
  };
  return map[ext] || 'image/png';
}

async function downloadImage(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0'
    }
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 100) {
    throw new Error(`Suspiciously small file: ${buffer.length} bytes`);
  }
  return buffer;
}

async function main() {
  const csvPath = path.resolve('attached_assets/logos_1775734082418.csv');
  let csvContent = readFileSync(csvPath, 'utf-8');
  if (csvContent.charCodeAt(0) === 0xFEFF) {
    csvContent = csvContent.slice(1);
  }

  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  const startFrom = parseInt(process.env.START_FROM || '0', 10);
  console.log(`Found ${records.length} rows in CSV, starting from row ${startFrom}`);

  let success = 0;
  let failed = 0;
  let skipped = 0;
  const failures = [];

  for (let i = startFrom; i < records.length; i++) {
    const row = records[i];
    const orgId = (row['Iconnect unique id'] || '').trim();
    const logoUrl = (row['Org logo URL'] || '').trim();

    if (!orgId || !logoUrl) {
      console.log(`[${i + 1}/${records.length}] SKIP - missing org ID or URL`);
      skipped++;
      continue;
    }

    try {
      const ext = extractExtension(logoUrl);
      const storagePath = `${TENANT_ID}/${FOLDER}/${orgId}${ext}`;

      const imageBuffer = await downloadImage(logoUrl);

      const { error: deleteError } = await supabase.storage
        .from(BUCKET)
        .remove([storagePath]);

      const { data: uploadData, error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, imageBuffer, {
          contentType: getContentType(ext),
          cacheControl: '31536000',
          upsert: true,
        });

      if (uploadError) {
        throw new Error(`Upload failed: ${uploadError.message}`);
      }

      const { data: publicUrlData } = supabase.storage
        .from(BUCKET)
        .getPublicUrl(storagePath);

      const publicUrl = publicUrlData.publicUrl;

      const { error: updateError } = await supabase
        .from('organization')
        .update({ logo_url: publicUrl })
        .eq('id', orgId);

      if (updateError) {
        throw new Error(`DB update failed: ${updateError.message}`);
      }

      console.log(`  OK`);
      success++;
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
      failures.push({ orgId, error: err.message });
      failed++;
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Total rows:  ${records.length}`);
  console.log(`Succeeded:   ${success}`);
  console.log(`Failed:      ${failed}`);
  console.log(`Skipped:     ${skipped}`);

  if (failures.length > 0) {
    console.log('\nFailed rows:');
    failures.forEach(f => console.log(`  ${f.orgId}: ${f.error}`));
  }
}

main().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
