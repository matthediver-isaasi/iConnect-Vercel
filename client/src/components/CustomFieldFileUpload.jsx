import { useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Upload, X, FileText, FileImage, FileSpreadsheet, File, Loader2, Download, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { useSecureFileUrl, isSecureReference } from "@/hooks/useSecureFileUrl";

const ALLOWED_FILE_TYPES = {
  pdf: { extension: '.pdf', mimeTypes: ['application/pdf'], icon: FileText },
  word: { extension: '.doc,.docx', mimeTypes: ['application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], icon: FileText },
  excel: { extension: '.xls,.xlsx,.csv', mimeTypes: ['application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv'], icon: FileSpreadsheet },
  powerpoint: { extension: '.ppt,.pptx', mimeTypes: ['application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'], icon: FileText },
  images: { extension: '.jpg,.jpeg,.png,.gif,.webp,.svg', mimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'], icon: FileImage },
  text: { extension: '.txt,.rtf', mimeTypes: ['text/plain', 'application/rtf'], icon: FileText },
  zip: { extension: '.zip,.rar,.7z', mimeTypes: ['application/zip', 'application/x-rar-compressed', 'application/x-7z-compressed'], icon: File },
  video: { extension: '.mp4,.mov,.avi,.webm', mimeTypes: ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm'], icon: File },
  audio: { extension: '.mp3,.wav,.m4a,.ogg', mimeTypes: ['audio/mpeg', 'audio/wav', 'audio/x-m4a', 'audio/ogg'], icon: File }
};

function getAcceptString(allowedTypes) {
  if (!allowedTypes || allowedTypes.length === 0) return '*/*';
  
  const extensions = [];
  const mimeTypes = [];
  
  allowedTypes.forEach(type => {
    const config = ALLOWED_FILE_TYPES[type];
    if (config) {
      extensions.push(...config.extension.split(','));
      mimeTypes.push(...config.mimeTypes);
    }
  });
  
  return [...new Set([...extensions, ...mimeTypes])].join(',');
}

function validateFile(file, allowedTypes) {
  if (!allowedTypes || allowedTypes.length === 0) return true;
  
  const extension = '.' + file.name.split('.').pop().toLowerCase();
  const mimeType = file.type;
  
  for (const type of allowedTypes) {
    const config = ALLOWED_FILE_TYPES[type];
    if (config) {
      const allowedExtensions = config.extension.split(',');
      if (allowedExtensions.includes(extension)) return true;
      if (config.mimeTypes.includes(mimeType)) return true;
    }
  }
  
  return false;
}

function getFileIcon(fileName) {
  if (!fileName) return File;
  const extension = fileName.split('.').pop().toLowerCase();
  
  if (['pdf'].includes(extension)) return FileText;
  if (['doc', 'docx', 'txt', 'rtf'].includes(extension)) return FileText;
  if (['xls', 'xlsx', 'csv'].includes(extension)) return FileSpreadsheet;
  if (['ppt', 'pptx'].includes(extension)) return FileText;
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(extension)) return FileImage;
  
  return File;
}

function formatFileSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getAllowedTypesLabel(allowedTypes) {
  if (!allowedTypes || allowedTypes.length === 0) return 'All files';
  
  const typeLabels = {
    pdf: 'PDF',
    word: 'Word',
    excel: 'Excel',
    powerpoint: 'PowerPoint',
    images: 'Images',
    text: 'Text',
    zip: 'Archives',
    video: 'Videos',
    audio: 'Audio'
  };
  
  return allowedTypes.map(t => typeLabels[t] || t).join(', ');
}

export default function CustomFieldFileUpload({ 
  fieldId,
  formId,
  value, 
  onChange, 
  allowedTypes = [], 
  disabled = false,
  label = "Upload File"
}) {
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef(null);
  
  // Normalize allowedTypes - handle both array and JSON string formats
  const normalizedAllowedTypes = (() => {
    if (Array.isArray(allowedTypes)) return allowedTypes;
    if (typeof allowedTypes === 'string' && allowedTypes) {
      try {
        const parsed = JSON.parse(allowedTypes);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  })();
  
  const parsedValue = typeof value === 'string' && value ? 
    (value.startsWith('{') ? JSON.parse(value) : { file_url: value, file_name: value.split('/').pop() }) 
    : value;
  
  const handleFileSelect = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    
    if (!validateFile(file, normalizedAllowedTypes)) {
      toast.error(`Invalid file type. Allowed: ${getAllowedTypesLabel(normalizedAllowedTypes)}`);
      event.target.value = '';
      return;
    }
    
    const maxSize = 50 * 1024 * 1024;
    if (file.size > maxSize) {
      toast.error('File is too large. Maximum size is 50MB.');
      event.target.value = '';
      return;
    }
    
    setIsUploading(true);
    
    try {
      const signedUrlResponse = await fetch('/api/storage/signed-upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type,
          type: 'form-submission',
          isPrivate: true,
          formId: formId
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
      
      const uploadResponse = await fetch(signedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type, 'x-upsert': 'true' },
        body: file
      });
      
      if (!uploadResponse.ok) {
        throw new Error('Failed to upload file to storage');
      }
      
      const fileData = {
        file_url: fileUrl,
        storage_path: storagePath,
        bucket: bucket,
        file_name: file.name,
        file_size: file.size,
        mime_type: file.type,
        is_private: true,
        uploaded_at: new Date().toISOString()
      };
      
      onChange(JSON.stringify(fileData));
      toast.success('File uploaded successfully');
    } catch (error) {
      console.error('Upload error:', error);
      toast.error(error.message || 'Failed to upload file');
    } finally {
      setIsUploading(false);
      event.target.value = '';
    }
  };
  
  const handleRemove = () => {
    onChange('');
  };
  
  const FileIcon = parsedValue?.file_name ? getFileIcon(parsedValue.file_name) : File;
  
  const fileUrl = parsedValue?.file_url;
  const { resolvedUrl, isLoading: isResolvingUrl, isSecure } = useSecureFileUrl(fileUrl);
  
  const handleOpenFile = useCallback(async (e, download = false) => {
    if (!isSecure) {
      return;
    }
    
    e.preventDefault();
    
    if (!resolvedUrl) {
      toast.error('Unable to access file');
      return;
    }
    
    const link = document.createElement('a');
    link.href = resolvedUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    if (download) {
      link.download = parsedValue?.file_name || '';
    }
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [resolvedUrl, isSecure, parsedValue?.file_name]);
  
  if (parsedValue?.file_url) {
    const displayUrl = resolvedUrl || fileUrl;
    
    return (
      <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg border border-slate-200">
        <FileIcon className="w-8 h-8 text-blue-500 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-900 truncate">
            {parsedValue.file_name || 'Uploaded file'}
          </p>
          {parsedValue.file_size && (
            <p className="text-xs text-slate-500">{formatFileSize(parsedValue.file_size)}</p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {isResolvingUrl ? (
            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
          ) : (
            <>
              <Button
                variant="ghost"
                size="icon"
                onClick={isSecure ? (e) => handleOpenFile(e, true) : undefined}
                asChild={!isSecure}
                data-testid={`button-download-file-${fieldId}`}
              >
                {isSecure ? (
                  <span><Download className="w-4 h-4" /></span>
                ) : (
                  <a href={displayUrl} target="_blank" rel="noopener noreferrer" download>
                    <Download className="w-4 h-4" />
                  </a>
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={isSecure ? handleOpenFile : undefined}
                asChild={!isSecure}
                data-testid={`button-view-file-${fieldId}`}
              >
                {isSecure ? (
                  <span><ExternalLink className="w-4 h-4" /></span>
                ) : (
                  <a href={displayUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="w-4 h-4" />
                  </a>
                )}
              </Button>
            </>
          )}
          {!disabled && (
            <Button
              variant="ghost"
              size="icon"
              onClick={handleRemove}
              className="text-red-500 hover:text-red-700 hover:bg-red-50"
              data-testid={`button-remove-file-${fieldId}`}
            >
              <X className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>
    );
  }
  
  return (
    <div className="space-y-2">
      <input
        ref={fileInputRef}
        type="file"
        accept={getAcceptString(normalizedAllowedTypes)}
        onChange={handleFileSelect}
        disabled={disabled || isUploading}
        className="hidden"
        data-testid={`input-file-${fieldId}`}
      />
      
      <Button
        type="button"
        variant="outline"
        onClick={() => fileInputRef.current?.click()}
        disabled={disabled || isUploading}
        className="w-full justify-center gap-2 h-20 border-dashed"
        data-testid={`button-upload-file-${fieldId}`}
      >
        {isUploading ? (
          <>
            <Loader2 className="w-5 h-5 animate-spin" />
            <span>Uploading...</span>
          </>
        ) : (
          <>
            <Upload className="w-5 h-5" />
            <div className="text-left">
              <span className="block">{label}</span>
              <span className="text-xs text-slate-400 font-normal">
                {getAllowedTypesLabel(normalizedAllowedTypes)} (max 50MB)
              </span>
            </div>
          </>
        )}
      </Button>
    </div>
  );
}

export function CustomFieldFileDisplay({ value }) {
  if (!value) return <p className="text-sm text-slate-500">No file uploaded</p>;
  
  const parsedValue = typeof value === 'string' && value ? 
    (value.startsWith('{') ? JSON.parse(value) : { file_url: value, file_name: value.split('/').pop() }) 
    : value;
  
  if (!parsedValue?.file_url) return <p className="text-sm text-slate-500">No file uploaded</p>;
  
  const FileIcon = getFileIcon(parsedValue.file_name);
  
  return (
    <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg border border-slate-200">
      <FileIcon className="w-6 h-6 text-blue-500 flex-shrink-0" />
      <a 
        href={parsedValue.file_url} 
        target="_blank" 
        rel="noopener noreferrer"
        className="text-sm text-blue-600 hover:underline truncate flex-1"
      >
        {parsedValue.file_name || 'View file'}
      </a>
      {parsedValue.file_size && (
        <span className="text-xs text-slate-400 flex-shrink-0">
          {formatFileSize(parsedValue.file_size)}
        </span>
      )}
    </div>
  );
}
