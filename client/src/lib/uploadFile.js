const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB in bytes

export async function uploadFileWithProgress(file, onProgress) {
  if (!file) {
    throw new Error('No file provided');
  }
  
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`File size exceeds maximum allowed size of 25MB. Your file is ${(file.size / (1024 * 1024)).toFixed(1)}MB.`);
  }
  
  const signedUrlResponse = await fetch('/api/integrations/signed-upload-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type
    })
  });
  
  if (!signedUrlResponse.ok) {
    const errorData = await signedUrlResponse.json();
    throw new Error(errorData.error || 'Failed to get upload URL');
  }
  
  const { signedUrl, publicUrl, token } = await signedUrlResponse.json();
  
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
    file_url: publicUrl,
    file_name: file.name,
    file_size: file.size,
    mime_type: file.type
  };
}

export { MAX_FILE_SIZE };
