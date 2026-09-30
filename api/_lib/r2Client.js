/**
 * Cloudflare R2 client helper
 *
 * Constructs an S3-compatible client pointed at the Cloudflare R2 endpoint.
 * Cloudflare R2 is S3-compatible; we use @aws-sdk/client-s3 with a custom
 * endpoint derived from R2_ACCOUNT_ID (or a fully-specified R2_ENDPOINT).
 *
 * Required env vars:
 *   R2_ACCOUNT_ID      – Cloudflare account ID (used to build endpoint URL)
 *   R2_ACCESS_KEY_ID   – R2 API token "Access Key ID"
 *   R2_SECRET_ACCESS_KEY – R2 API token "Secret Access Key"
 *   R2_BUCKET          – target bucket name
 *
 * Optional:
 *   R2_ENDPOINT        – override the full endpoint URL
 *                        (defaults to https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com)
 */

import { S3Client, HeadObjectCommand, PutObjectCommand, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';

function buildEndpoint() {
  if (process.env.R2_ENDPOINT) return process.env.R2_ENDPOINT;
  const accountId = process.env.R2_ACCOUNT_ID;
  if (!accountId) return null;
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

export function createR2Client() {
  const endpoint = buildEndpoint();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    return null;
  }

  return new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });
}

export function getR2Bucket() {
  return process.env.R2_BUCKET || null;
}

/**
 * Return metadata for an R2 object, or null if it does not exist.
 * Shape: { contentLength: number, metadata: Record<string, string> }
 */
export async function headR2Object(client, bucket, key) {
  try {
    const resp = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return {
      contentLength: resp.ContentLength ?? 0,
      metadata: resp.Metadata || {},
    };
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

/**
 * List all object keys+sizes under a given prefix in R2.
 * Returns a Map<key, size>.
 */
export async function listR2Objects(client, bucket, prefix) {
  const map = new Map();
  let continuationToken;
  do {
    const resp = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    for (const obj of resp.Contents || []) {
      map.set(obj.Key, obj.Size ?? 0);
    }
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);
  return map;
}

/**
 * Upload a stream or buffer to R2.
 */
export async function putR2Object(client, bucket, key, body, { contentType, contentLength } = {}) {
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ...(contentType ? { ContentType: contentType } : {}),
    ...(contentLength != null ? { ContentLength: contentLength } : {}),
  }));
}

/**
 * Fetch the body of an R2 object as a UTF-8 string.
 * Returns null if the object does not exist.
 */
export async function getR2ObjectText(client, bucket, key) {
  try {
    const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const chunks = [];
    for await (const chunk of resp.Body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}
