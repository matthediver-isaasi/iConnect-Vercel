/**
 * Legacy File Upload Utilities
 * 
 * This module provides backward-compatible file upload functions.
 * New code should use tenantUpload.js for full tenant-scoped functionality.
 * 
 * Files uploaded through this module are now automatically tenant-scoped
 * via the new /api/storage/ endpoints.
 */

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB in bytes

export async function uploadFileWithProgress(file, onProgress, options = {}) {
  if (!file) {
    throw new Error('No file provided');
  }
  
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`File size exceeds maximum allowed size of 25MB. Your file is ${(file.size / (1024 * 1024)).toFixed(1)}MB.`);
  }
  
  const {
    type = 'document',
    entityId = null,
    isPrivate = true
  } = options;
  
  const signedUrlResponse = await fetch('/api/storage/signed-upload-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type,
      type: type,
      entityId: entityId,
      isPrivate: isPrivate
    })
  });
  
  if (!signedUrlResponse.ok) {
    const errorData = await signedUrlResponse.json().catch(() => ({}));
    if (signedUrlResponse.status === 401) {
      throw new Error('You must be logged in to upload files');
    }
    throw new Error(errorData.error || 'Failed to get upload URL');
  }
  
  const { signedUrl, fileUrl, path: storagePath, bucket, isPrivate: resultPrivate } = await signedUrlResponse.json();
  
  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) {
        const percentComplete = Math.round((e.loaded / e.total) * 100);
        onProgress(percentComplete);
      }
    });
    
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Upload failed with status ${xhr.status}`));
      }
    });
    
    xhr.addEventListener('error', () => reject(new Error('Upload failed')));
    xhr.addEventListener('abort', () => reject(new Error('Upload aborted')));
    
    xhr.open('PUT', signedUrl);
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.setRequestHeader('x-upsert', 'true');
    xhr.send(file);
  });
  
  return {
    file_url: fileUrl,
    storage_path: storagePath,
    bucket: bucket,
    file_name: file.name,
    file_size: file.size,
    mime_type: file.type,
    is_private: resultPrivate
  };
}

export { MAX_FILE_SIZE };
