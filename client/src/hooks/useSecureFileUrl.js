/**
 * Hook for resolving secure file URLs
 * 
 * This hook handles fetching signed URLs for private files
 * stored in the tenant-scoped private-uploads bucket.
 */

import { useState, useEffect, useCallback } from 'react';

function isSecureReference(url) {
  return url && url.startsWith('/api/storage/secure-url');
}

async function fetchSecureUrl(url) {
  if (!url) return null;
  
  if (!isSecureReference(url)) {
    return url;
  }

  const response = await fetch(url, {
    credentials: 'include'
  });

  if (!response.ok) {
    throw new Error('Failed to get file access URL');
  }

  const { signedUrl } = await response.json();
  return signedUrl;
}

export function useSecureFileUrl(fileUrl) {
  const [resolvedUrl, setResolvedUrl] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!fileUrl) {
      setResolvedUrl(null);
      setError(null);
      return;
    }

    if (!isSecureReference(fileUrl)) {
      setResolvedUrl(fileUrl);
      setError(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    fetchSecureUrl(fileUrl)
      .then(url => {
        setResolvedUrl(url);
        setIsLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setIsLoading(false);
      });
  }, [fileUrl]);

  const refetch = useCallback(() => {
    if (!fileUrl || !isSecureReference(fileUrl)) return;
    
    setIsLoading(true);
    setError(null);
    
    fetchSecureUrl(fileUrl)
      .then(url => {
        setResolvedUrl(url);
        setIsLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setIsLoading(false);
      });
  }, [fileUrl]);

  return { resolvedUrl, isLoading, error, refetch, isSecure: isSecureReference(fileUrl) };
}

export async function getSecureFileUrl(storagePath, bucket = 'private-uploads', download = false) {
  const params = new URLSearchParams({
    bucket,
    path: storagePath,
    ...(download && { download: 'true' })
  });

  const response = await fetch(`/api/storage/secure-url?${params}`, {
    credentials: 'include'
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || 'Failed to get file URL');
  }

  const { signedUrl } = await response.json();
  return signedUrl;
}

export async function resolveFileUrl(url) {
  return fetchSecureUrl(url);
}

export { isSecureReference };
