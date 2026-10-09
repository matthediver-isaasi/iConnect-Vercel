import React, { useState, useRef, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { publishProjectCardUpdate } from "@/lib/projectBoardCache";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { 
  Paperclip, Upload, X, Loader2, Image, FileText, Video, 
  Music, File, MoreHorizontal, Trash2, ImagePlus, Download, Eye, Check
} from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { apiRequest } from "@/lib/queryClient";
import { throwUploadHttpError, showUploadErrorToast } from "@/lib/planQuotaError";

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
  const [uploadCount, setUploadCount] = useState(0);
  const isUploading = uploadCount > 0;
  const [uploadProgress, setUploadProgress] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [previewFile, setPreviewFile] = useState(null);
  const fileInputRef = useRef(null);
  const queryClient = useQueryClient();

  const uploadFile = async (file) => {
    setUploadCount(count => count + 1);
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
        await throwUploadHttpError(getUploadUrlResponse, 'Failed to get upload URL');
      }

      const { signedUrl, uploadToken } = await getUploadUrlResponse.json();
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
          uploadToken
        })
      });

      if (!confirmResponse.ok) {
        const error = await confirmResponse.json();
        throw new Error(error.error || 'Failed to confirm upload');
      }

      const confirmed = await confirmResponse.json();
      await publishProjectCardUpdate(queryClient, cardId, {}, { attachment: confirmed.attachment });
      setUploadProgress(100);
      toast.success('File uploaded successfully');
    } catch (error) {
      console.error('Upload error:', error);
      showUploadErrorToast(error, 'Failed to upload file');
    } finally {
      setUploadCount(count => count - 1);
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
    onSuccess: async (_data, attachmentId) => {
      const removed = attachments.find(item => item.id === attachmentId);
      await publishProjectCardUpdate(queryClient, cardId,
        removed?.url === coverImage ? { cover_image: null } : {},
        { removedAttachmentId: attachmentId });
      toast.success('Attachment deleted');
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
    onSuccess: async (data) => {
      await publishProjectCardUpdate(queryClient, cardId, { cover_image: data.coverImage });
      if (data.coverImage) {
        toast.success('Cover image set');
      } else {
        toast.success('Cover image removed');
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

export function CardCoverSection({ 
  cardId, 
  coverImage, 
  attachments = [], 
  canEdit = false,
  onCoverChange,
  presentation = "section"
}) {
  const [showCoverPicker, setShowCoverPicker] = useState(false);
  const [isUploadingCover, setIsUploadingCover] = useState(false);
  const [coverUploadError, setCoverUploadError] = useState("");
  const coverFileInputRef = useRef(null);
  const coverUploadBusyRef = useRef(false);
  const queryClient = useQueryClient();
  
  const imageAttachments = attachments.filter(a => a.file_type?.startsWith('image/'));
  
  const setCoverMutation = useMutation({
    mutationFn: async ({ attachmentId, setAsCover, clearCover }) => {
      const response = await apiRequest('PATCH', `/api/projects/cards/${cardId}/attachments/${attachmentId}`, {
        setAsCover,
        clearCover
      });
      return response;
    },
    onSuccess: async (data) => {
      await publishProjectCardUpdate(queryClient, cardId, { cover_image: data.coverImage });
      if (data.coverImage) {
        toast.success('Cover image set');
      } else {
        toast.success('Cover image removed');
      }
      setShowCoverPicker(false);
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to update cover');
    }
  });

  const removeCoverMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('PATCH', `/api/projects/cards/${cardId}`, {
        cover_image: null
      });
      return response;
    },
    onSuccess: async () => {
      await publishProjectCardUpdate(queryClient, cardId, { cover_image: null });
      toast.success('Cover removed');
      setShowCoverPicker(false);
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to remove cover');
    }
  });

  const uploadCover = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !canEdit || coverUploadBusyRef.current ||
        setCoverMutation.isPending || removeCoverMutation.isPending) return;
    setCoverUploadError("");
    if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(file.type)) {
      setCoverUploadError("Choose a JPEG, PNG, GIF or WebP image.");
      return;
    }
    if (file.size > 100 * 1024 * 1024) {
      setCoverUploadError("Cover images must be 100 MB or smaller.");
      return;
    }
    coverUploadBusyRef.current = true;
    setIsUploadingCover(true);
    try {
      const response = await fetch(`/api/projects/cards/${cardId}/attachments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          fileName: file.name, fileSize: file.size, mimeType: file.type, purpose: "cover"
        })
      });
      if (!response.ok) await throwUploadHttpError(response, "Failed to get cover upload URL");
      const { signedUrl, uploadToken } = await response.json();
      if (!signedUrl || !uploadToken) throw new Error("Failed to get cover upload URL");
      const uploadResponse = await fetch(signedUrl, {
        method: "PUT", headers: { "Content-Type": file.type }, body: file
      });
      if (!uploadResponse.ok) throw new Error("Failed to upload cover image to storage");
      const confirmResponse = await fetch(`/api/projects/cards/${cardId}/attachments/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ uploadToken })
      });
      if (!confirmResponse.ok) await throwUploadHttpError(confirmResponse, "Failed to confirm cover upload");
      const { coverImage: uploadedCoverImage } = await confirmResponse.json();
      if (!uploadedCoverImage) throw new Error("Failed to confirm cover upload");
      await publishProjectCardUpdate(queryClient, cardId, { cover_image: uploadedCoverImage });
      toast.success("Cover image uploaded");
      setShowCoverPicker(false);
    } catch (error) {
      setCoverUploadError(error.message || "Failed to upload cover image. Please try again.");
      showUploadErrorToast(error, "Failed to upload cover image");
    } finally {
      coverUploadBusyRef.current = false;
      setIsUploadingCover(false);
    }
  };

  if (!canEdit && !coverImage) return null;
  const isHeader = presentation === "header";
  const isPending = isUploadingCover || setCoverMutation.isPending || removeCoverMutation.isPending;

  return (
    <div data-testid={isHeader ? "card-cover-header" : "card-cover-section"} className={isHeader ? "shrink-0" : "mb-4"}>
      {!isHeader && <Label className="flex items-center gap-2 mb-2">
        <ImagePlus className="w-4 h-4" />
        Cover
      </Label>}
      
      {coverImage ? (
        <div className="relative group">
          <div className={isHeader ? "h-40 overflow-hidden border-b bg-muted/50 sm:h-48" : "h-24 rounded-lg overflow-hidden bg-muted"}>
            <img 
              src={coverImage} 
              alt="Card cover"
              className={isHeader ? "h-full w-full object-contain" : "w-full h-full object-cover"}
            />
          </div>
          {canEdit && (
            <div className={isHeader ? "absolute bottom-3 right-3 flex flex-wrap justify-end gap-2 pl-3" : "absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity rounded-lg flex items-center justify-center gap-2"}>
              <Button
                variant="secondary"
                size="sm"
                className={isHeader ? "border bg-background text-foreground shadow-sm hover:bg-muted" : undefined}
                onClick={() => setShowCoverPicker(true)}
                disabled={isPending}
                data-testid="button-change-cover"
              >
                {isHeader ? "Change cover" : "Change"}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className={isHeader ? "border bg-background text-foreground shadow-sm hover:bg-muted" : undefined}
                onClick={() => removeCoverMutation.mutate()}
                disabled={isPending}
                data-testid="button-remove-cover"
              >
                {removeCoverMutation.isPending ? 'Removing…' : isHeader ? 'Remove cover' : 'Remove'}
              </Button>
            </div>
          )}
        </div>
      ) : canEdit ? (
        <div className={isHeader ? "px-5 pb-1 pt-4 pr-14 md:px-8 md:pr-14" : undefined}><Button
          variant="outline"
          className={isHeader ? "h-8" : "w-full h-20 border-dashed"}
          size={isHeader ? "sm" : "default"}
          disabled={isPending}
          onClick={() => setShowCoverPicker(true)}
          data-testid="button-add-cover"
        >
          <ImagePlus className="w-5 h-5 mr-2" />
          {isHeader ? "Add cover" : "Add cover image"}
        </Button></div>
      ) : null}

      <Dialog open={canEdit && showCoverPicker} onOpenChange={(open) => {
        if (isPending) return;
        setCoverUploadError("");
        setShowCoverPicker(open);
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Choose cover image</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <input
                ref={coverFileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp"
                aria-label="Upload cover image"
                className="hidden"
                disabled={!canEdit || isPending}
                onChange={uploadCover}
                data-testid="input-cover-upload"
              />
              <Button
                variant="outline"
                className="w-full"
                disabled={!canEdit || isPending}
                onClick={() => coverFileInputRef.current?.click()}
                data-testid="button-upload-cover"
              >
                <Upload className="w-4 h-4 mr-2" />
                {isUploadingCover ? "Uploading cover…" : "Upload cover image"}
              </Button>
              <p className="text-xs text-muted-foreground">
                JPEG, PNG, GIF or WebP, up to 100 MB. Cover uploads are not added to attachments.
              </p>
              {isUploadingCover && <p role="status" className="text-sm text-muted-foreground">Uploading and saving your cover…</p>}
              {coverUploadError && <p role="alert" className="text-sm text-destructive">{coverUploadError}</p>}
            </div>
            {imageAttachments.length > 0 ? (
              <div>
                <p className="text-sm text-muted-foreground mb-2">Select from attachments:</p>
                <div className="grid grid-cols-3 gap-2">
                  {imageAttachments.map((attachment) => (
                    <button
                      type="button"
                      key={attachment.id}
                      aria-label={`Use ${attachment.name} as cover`}
                      aria-pressed={coverImage === attachment.url}
                      disabled={isPending}
                      className={`relative cursor-pointer rounded-lg overflow-hidden h-20 border-2 transition-colors ${
                        coverImage === attachment.url 
                          ? 'border-primary' 
                          : 'border-transparent hover:border-muted-foreground/50'
                      }`}
                      onClick={() => setCoverMutation.mutate({ 
                        attachmentId: attachment.id, 
                        setAsCover: true 
                      })}
                      data-testid={`cover-option-${attachment.id}`}
                    >
                      <img 
                        src={attachment.url} 
                        alt={attachment.name}
                        className="w-full h-full object-cover"
                      />
                      {coverImage === attachment.url && (
                        <div className="absolute inset-0 bg-primary/20 flex items-center justify-center">
                          <div className="w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center">
                            <Check aria-hidden="true" className="h-4 w-4" />
                          </div>
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="text-center py-6 text-muted-foreground">
                <Image className="w-12 h-12 mx-auto mb-2 opacity-50" />
                <p>No image attachments yet.</p>
                <p className="text-sm">Upload a cover image above, or add an image attachment to choose here.</p>
              </div>
            )}
            
            {coverImage && (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => removeCoverMutation.mutate()}
                disabled={isPending}
              >
                {removeCoverMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <X className="w-4 h-4 mr-2" />
                )}
                Remove cover
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
