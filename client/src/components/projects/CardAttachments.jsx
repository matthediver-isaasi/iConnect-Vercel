import React, { useState, useRef, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { 
  Paperclip, Upload, X, Loader2, Image, FileText, Video, 
  Music, File, MoreHorizontal, Trash2, ImagePlus, Download, Eye
} from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { apiRequest } from "@/lib/queryClient";

const FILE_TYPE_ICONS = {
  'image': Image,
  'video': Video,
  'audio': Music,
  'pdf': FileText,
  'document': FileText,
  'default': File
};

function getFileCategory(mimeType) {
  if (!mimeType) return 'default';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.includes('document') || mimeType.includes('word') || 
      mimeType.includes('excel') || mimeType.includes('sheet') ||
      mimeType.includes('powerpoint') || mimeType.includes('presentation')) {
    return 'document';
  }
  return 'default';
}

function formatFileSize(bytes) {
  if (!bytes) return 'Unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function CardAttachments({ 
  cardId, 
  attachments = [], 
  coverImage,
  canEdit = false,
  onCoverChange
}) {
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [previewFile, setPreviewFile] = useState(null);
  const fileInputRef = useRef(null);
  const queryClient = useQueryClient();

  const uploadFile = async (file) => {
    setIsUploading(true);
    setUploadProgress(0);

    try {
      const getUploadUrlResponse = await fetch(`/api/projects/cards/${cardId}/attachments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type
        })
      });

      if (!getUploadUrlResponse.ok) {
        const error = await getUploadUrlResponse.json();
        throw new Error(error.error || 'Failed to get upload URL');
      }

      const { signedUrl, storagePath, publicUrl, token, originalName } = await getUploadUrlResponse.json();
      setUploadProgress(30);

      const uploadResponse = await fetch(signedUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': file.type
        },
        body: file
      });

      if (!uploadResponse.ok) {
        throw new Error('Failed to upload file to storage');
      }
      setUploadProgress(70);

      const confirmResponse = await fetch(`/api/projects/cards/${cardId}/attachments/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          storagePath,
          publicUrl,
          fileName: originalName || file.name,
          fileSize: file.size,
          mimeType: file.type
        })
      });

      if (!confirmResponse.ok) {
        const error = await confirmResponse.json();
        throw new Error(error.error || 'Failed to confirm upload');
      }

      setUploadProgress(100);
      toast.success('File uploaded successfully');
      queryClient.invalidateQueries({ queryKey: ['card-detail', cardId] });
    } catch (error) {
      console.error('Upload error:', error);
      toast.error(error.message || 'Failed to upload file');
    } finally {
      setIsUploading(false);
      setUploadProgress(0);
    }
  };

  const handleFileSelect = (event) => {
    const files = event.target.files;
    if (files && files.length > 0) {
      Array.from(files).forEach(uploadFile);
    }
    event.target.value = '';
  };

  const handleDrop = useCallback((event) => {
    event.preventDefault();
    setDragOver(false);
    
    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      Array.from(files).forEach(uploadFile);
    }
  }, [cardId]);

  const handleDragOver = useCallback((event) => {
    event.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((event) => {
    event.preventDefault();
    setDragOver(false);
  }, []);

  const deleteAttachmentMutation = useMutation({
    mutationFn: async (attachmentId) => {
      const response = await apiRequest('DELETE', `/api/projects/cards/${cardId}/attachments/${attachmentId}`);
      return response;
    },
    onSuccess: () => {
      toast.success('Attachment deleted');
      queryClient.invalidateQueries({ queryKey: ['card-detail', cardId] });
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to delete attachment');
    }
  });

  const setCoverMutation = useMutation({
    mutationFn: async ({ attachmentId, setAsCover, clearCover }) => {
      const response = await apiRequest('PATCH', `/api/projects/cards/${cardId}/attachments/${attachmentId}`, {
        setAsCover,
        clearCover
      });
      return response;
    },
    onSuccess: (data) => {
      if (data.coverImage) {
        toast.success('Cover image set');
      } else {
        toast.success('Cover image removed');
      }
      queryClient.invalidateQueries({ queryKey: ['card-detail', cardId] });
      queryClient.invalidateQueries({ queryKey: ['project-board'] });
      if (onCoverChange) {
        onCoverChange(data.coverImage);
      }
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to update cover');
    }
  });

  const handlePreview = async (attachment) => {
    const category = getFileCategory(attachment.file_type);
    if (['image', 'video', 'audio', 'pdf'].includes(category)) {
      setPreviewFile(attachment);
    } else {
      window.open(attachment.url, '_blank');
    }
  };

  const handleDownload = (attachment) => {
    const link = document.createElement('a');
    link.href = attachment.url;
    link.download = attachment.name;
    link.target = '_blank';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-3">
      <Label className="flex items-center gap-2">
        <Paperclip className="w-4 h-4" />
        Attachments ({attachments.length})
      </Label>

      {canEdit && (
        <div
          className={`border-2 border-dashed rounded-lg p-4 text-center transition-colors ${
            dragOver 
              ? 'border-primary bg-primary/5' 
              : 'border-muted-foreground/20 hover:border-muted-foreground/40'
          }`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileSelect}
            className="hidden"
            data-testid="input-file-upload"
          />
          
          {isUploading ? (
            <div className="space-y-2">
              <Loader2 className="w-6 h-6 mx-auto animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">Uploading... {uploadProgress}%</p>
              <div className="w-full bg-muted rounded-full h-1.5">
                <div 
                  className="bg-primary h-1.5 rounded-full transition-all" 
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            </div>
          ) : (
            <>
              <Upload className="w-6 h-6 mx-auto text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground mb-2">
                Drag and drop files here, or
              </p>
              <Button 
                variant="outline" 
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                data-testid="button-select-files"
              >
                Select Files
              </Button>
            </>
          )}
        </div>
      )}

      <div className="space-y-2">
        {attachments.map((attachment) => {
          const category = getFileCategory(attachment.file_type);
          const IconComponent = FILE_TYPE_ICONS[category] || FILE_TYPE_ICONS.default;
          const isImage = category === 'image';
          const isCover = coverImage === attachment.url;

          return (
            <div
              key={attachment.id}
              className="flex items-center gap-3 p-2 rounded-lg border bg-card hover:bg-muted/50 transition-colors group"
            >
              {isImage ? (
                <div 
                  className="w-12 h-12 rounded overflow-hidden bg-muted flex-shrink-0 cursor-pointer"
                  onClick={() => handlePreview(attachment)}
                >
                  <img 
                    src={attachment.url} 
                    alt={attachment.name}
                    className="w-full h-full object-cover"
                  />
                </div>
              ) : (
                <div 
                  className="w-12 h-12 rounded bg-muted flex items-center justify-center flex-shrink-0 cursor-pointer"
                  onClick={() => handlePreview(attachment)}
                >
                  <IconComponent className="w-6 h-6 text-muted-foreground" />
                </div>
              )}

              <div className="flex-1 min-w-0">
                <p 
                  className="text-sm font-medium truncate cursor-pointer hover:underline"
                  onClick={() => handlePreview(attachment)}
                  data-testid={`text-attachment-name-${attachment.id}`}
                >
                  {attachment.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatFileSize(attachment.file_size)} 
                  {attachment.uploaded_at && ` • ${format(new Date(attachment.uploaded_at), 'MMM d, yyyy')}`}
                </p>
                {isCover && (
                  <span className="text-xs text-primary font-medium">Cover image</span>
                )}
              </div>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button 
                    variant="ghost" 
                    size="icon" 
                    className="opacity-0 group-hover:opacity-100 transition-opacity"
                    data-testid={`button-attachment-menu-${attachment.id}`}
                  >
                    <MoreHorizontal className="w-4 h-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => handlePreview(attachment)}>
                    <Eye className="w-4 h-4 mr-2" />
                    Preview
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleDownload(attachment)}>
                    <Download className="w-4 h-4 mr-2" />
                    Download
                  </DropdownMenuItem>
                  {isImage && canEdit && (
                    <DropdownMenuItem 
                      onClick={() => setCoverMutation.mutate({ 
                        attachmentId: attachment.id, 
                        setAsCover: !isCover,
                        clearCover: isCover
                      })}
                    >
                      <ImagePlus className="w-4 h-4 mr-2" />
                      {isCover ? 'Remove as Cover' : 'Set as Cover'}
                    </DropdownMenuItem>
                  )}
                  {canEdit && (
                    <DropdownMenuItem 
                      className="text-destructive"
                      onClick={() => deleteAttachmentMutation.mutate(attachment.id)}
                    >
                      <Trash2 className="w-4 h-4 mr-2" />
                      Delete
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        })}
      </div>

      <FilePreviewModal 
        file={previewFile} 
        open={!!previewFile} 
        onOpenChange={(open) => !open && setPreviewFile(null)} 
      />
    </div>
  );
}

function FilePreviewModal({ file, open, onOpenChange }) {
  if (!file) return null;

  const category = getFileCategory(file.file_type);

  const renderPreview = () => {
    switch (category) {
      case 'image':
        return (
          <img 
            src={file.url} 
            alt={file.name}
            className="max-w-full max-h-[70vh] object-contain rounded-lg"
          />
        );
      
      case 'video':
        return (
          <video 
            src={file.url}
            controls
            autoPlay
            className="max-w-full max-h-[70vh] rounded-lg"
          >
            Your browser does not support video playback.
          </video>
        );
      
      case 'audio':
        return (
          <div className="p-8">
            <Music className="w-16 h-16 mx-auto text-muted-foreground mb-4" />
            <audio src={file.url} controls className="w-full">
              Your browser does not support audio playback.
            </audio>
          </div>
        );
      
      case 'pdf':
        return (
          <iframe
            src={file.url}
            className="w-full h-[70vh] rounded-lg"
            title={file.name}
          />
        );
      
      default:
        return (
          <div className="p-8 text-center">
            <File className="w-16 h-16 mx-auto text-muted-foreground mb-4" />
            <p className="text-muted-foreground">Preview not available for this file type.</p>
            <Button 
              className="mt-4"
              onClick={() => window.open(file.url, '_blank')}
            >
              <Download className="w-4 h-4 mr-2" />
              Download File
            </Button>
          </div>
        );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] p-0 overflow-hidden">
        <DialogHeader className="p-4 pb-0">
          <DialogTitle className="truncate pr-8">{file.name}</DialogTitle>
        </DialogHeader>
        <div className="p-4 flex items-center justify-center bg-muted/30">
          {renderPreview()}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function CardCoverImage({ coverImage, coverColor, onRemove, canEdit }) {
  if (!coverImage && !coverColor) return null;

  return (
    <div className="relative w-full h-32 rounded-t-lg overflow-hidden">
      {coverImage ? (
        <img 
          src={coverImage} 
          alt="Card cover"
          className="w-full h-full object-cover"
        />
      ) : coverColor ? (
        <div 
          className="w-full h-full" 
          style={{ backgroundColor: coverColor }}
        />
      ) : null}
      
      {canEdit && onRemove && (
        <Button
          variant="secondary"
          size="icon"
          className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          data-testid="button-remove-cover"
        >
          <X className="w-4 h-4" />
        </Button>
      )}
    </div>
  );
}
