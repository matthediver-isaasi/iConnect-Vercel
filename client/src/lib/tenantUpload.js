/**
 * Tenant-Scoped File Upload Utilities
 * 
 * This module provides secure file upload functions that enforce tenant isolation.
 * All uploads are automatically scoped to the current user's tenant.
 * 
 * Use these functions instead of the legacy uploadFile.js for new implementations.
 */

const MAX_FILE_SIZES = {
  public: 10 * 1024 * 1024, // 10MB for public assets
  private: 25 * 1024 * 1024 // 25MB for private uploads
};

/**
 * Upload types that determine storage bucket and path structure
 */
export const UPLOAD_TYPES = {
  BRANDING: 'branding',       // Logos, favicons, branding assets
  PAGE: 'page',               // Page images, hero images
  FORM_SUBMISSION: 'form-submission', // Form file uploads (private)
  ATTACHMENT: 'attachment',   // General attachments (private)
  DOCUMENT: 'document',       // Documents (private)
  UPLOAD: 'upload'            // Generic uploads
};

/**
 * Check if an upload type is private
 */
function isPrivateUpload(uploadType) {
  const privateTypes = [
    UPLOAD_TYPES.FORM_SUBMISSION,
    UPLOAD_TYPES.ATTACHMENT,
    UPLOAD_TYPES.DOCUMENT
  ];
  return privateTypes.includes(uploadType);
}

/**
 * Upload a file with progress tracking using tenant-scoped storage
 * 
 * @param {File} file - The file to upload
 * @param {Object} options - Upload options
 * @param {string} options.type - Upload type (see UPLOAD_TYPES)
 * @param {string} options.entityId - Optional entity ID for path organization
 * @param {boolean} options.isPrivate - Force private upload (auto-detected from type)
 * @param {function} options.onProgress - Progress callback (0-100)
 * @returns {Promise<Object>} Upload result with file_url, storage_path, etc.
 */
export async function uploadFileWithProgress(file, options = {}) {
  const {
    type = UPLOAD_TYPES.UPLOAD,
    entityId = null,
    isPrivate = isPrivateUpload(type),
    onProgress = null
  } = options;

  if (!file) {
    throw new Error('No file provided');
  }

  // Check file size based on privacy
  const maxSize = isPrivate ? MAX_FILE_SIZES.private : MAX_FILE_SIZES.public;
  if (file.size > maxSize) {
    const maxMB = maxSize / (1024 * 1024);
    const fileMB = (file.size / (1024 * 1024)).toFixed(1);
    throw new Error(`File size exceeds maximum allowed size of ${maxMB}MB. Your file is ${fileMB}MB.`);
  }

  // Step 1: Get signed upload URL from tenant-scoped API
  const signedUrlResponse = await fetch('/api/storage/signed-upload-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include', // Important: include cookies for session auth
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

  const { signedUrl, fileUrl, path: storagePath, bucket } = await signedUrlResponse.json();

  // Step 2: Upload file directly to Supabase Storage using signed URL
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
    
    xhr.addEventListener('error', () => reject(new Error('Upload failed - network error')));
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
    is_private: isPrivate
  };
}

/**
 * Simple file upload without progress tracking
 * 
 * @param {File} file - The file to upload
 * @param {Object} options - Upload options (same as uploadFileWithProgress)
 * @returns {Promise<Object>} Upload result
 */
export async function uploadFile(file, options = {}) {
  return uploadFileWithProgress(file, options);
}

/**
 * Upload a file for form submission (automatically private)
 * 
 * @param {File} file - The file to upload
 * @param {string} formId - The form ID for path organization
 * @param {function} onProgress - Optional progress callback
 * @returns {Promise<Object>} Upload result
 */
export async function uploadFormSubmissionFile(file, formId, onProgress = null) {
  return uploadFileWithProgress(file, {
    type: UPLOAD_TYPES.FORM_SUBMISSION,
    entityId: formId,
    isPrivate: true,
    onProgress
  });
}

/**
 * Upload a branding asset (logo, favicon) - automatically public
 * 
 * @param {File} file - The file to upload
 * @param {function} onProgress - Optional progress callback
 * @returns {Promise<Object>} Upload result
 */
export async function uploadBrandingAsset(file, onProgress = null) {
  return uploadFileWithProgress(file, {
    type: UPLOAD_TYPES.BRANDING,
    isPrivate: false,
    onProgress
  });
}

/**
 * Upload a page asset (images for pages) - automatically public
 * 
 * @param {File} file - The file to upload
 * @param {string} pageId - The page ID for path organization
 * @param {function} onProgress - Optional progress callback
 * @returns {Promise<Object>} Upload result
 */
export async function uploadPageAsset(file, pageId, onProgress = null) {
  return uploadFileWithProgress(file, {
    type: UPLOAD_TYPES.PAGE,
    entityId: pageId,
    isPrivate: false,
    onProgress
  });
}

/**
 * Get a secure URL for accessing a private file
 * 
 * @param {string} storagePath - The storage path of the file
 * @param {string} bucket - The bucket name (default: private-uploads)
 * @param {boolean} download - Whether to force download
 * @returns {Promise<string>} Signed URL for file access
 */
export async function getSecureFileUrl(storagePath, bucket = 'private-uploads', download = false) {
  const params = new URLSearchParams({
    bucket,
    path: storagePath,
    ...(download && { download: 'true' })
  });

  const response = await fetch(`/api/storage/secure-url?${params}`, {
    credentials: 'include' // Include cookies for session auth
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    
    if (response.status === 401) {
      throw new Error('You must be logged in to access this file');
    }
    if (response.status === 403) {
      throw new Error('You do not have permission to access this file');
    }
    if (response.status === 404) {
      throw new Error('File not found');
    }
    
    throw new Error(errorData.error || 'Failed to get file URL');
  }

  const { signedUrl } = await response.json();
  return signedUrl;
}

/**
 * Check if a URL is a secure reference (needs to be resolved to signed URL)
 * 
 * @param {string} url - The URL to check
 * @returns {boolean}
 */
export function isSecureReference(url) {
  return url && url.startsWith('/api/storage/secure-url');
}

/**
 * Resolve a file URL - returns the URL directly for public files,
 * or fetches a signed URL for secure references
 * 
 * @param {string} url - The file URL or secure reference
 * @returns {Promise<string>} Resolved URL for file access
 */
export async function resolveFileUrl(url) {
  if (!url) return null;
  
  if (isSecureReference(url)) {
    // Parse the secure reference and get signed URL
    const urlObj = new URL(url, window.location.origin);
    const bucket = urlObj.searchParams.get('bucket');
    const path = urlObj.searchParams.get('path');
    return getSecureFileUrl(path, bucket);
  }
  
  // Regular URL, return as-is
  return url;
}

// Export max file sizes for validation in forms
export { MAX_FILE_SIZES };
