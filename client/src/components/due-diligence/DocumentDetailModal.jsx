import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { 
  FileText, Image, FileSpreadsheet, File, Check, X, Clock, RefreshCw, 
  Upload, Download, Send, Loader2, ChevronDown, ChevronUp, ExternalLink,
  MessageSquare, History
} from "lucide-react";
import { toast } from "sonner";
import { format } from 'date-fns';
import { uploadFileWithProgress } from "@/lib/uploadFile";

async function apiRequest(method, url, body = null) {
  const options = { method, credentials: 'include', headers: {} };
  if (body) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }
  return response.json();
}

const STATUS_CONFIG = {
  pending: { label: 'Pending', color: '#f59e0b', bgColor: '#fef3c7', icon: Clock },
  approved: { label: 'Approved', color: '#22c55e', bgColor: '#dcfce7', icon: Check },
  rejected: { label: 'Rejected', color: '#ef4444', bgColor: '#fee2e2', icon: X },
  aged: { label: 'Aged', color: '#6b7280', bgColor: '#f3f4f6', icon: RefreshCw }
};

function getFileIcon(mimeType) {
  if (!mimeType) return File;
  if (mimeType.startsWith('image/')) return Image;
  if (mimeType === 'application/pdf') return FileText;
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel') || mimeType.includes('csv')) return FileSpreadsheet;
  return File;
}

function canPreview(mimeType) {
  if (!mimeType) return false;
  return mimeType.startsWith('image/') || mimeType === 'application/pdf';
}

function FilePreview({ fileUrl, mimeType, fileName }) {
  if (!fileUrl) {
    return (
      <div className="flex items-center justify-center h-64 bg-muted rounded-lg">
        <p className="text-muted-foreground">No preview available</p>
      </div>
    );
  }

  if (mimeType?.startsWith('image/')) {
    return (
      <div className="flex items-center justify-center bg-muted rounded-lg p-4" style={{ height: '500px' }}>
        <img 
          src={fileUrl} 
          alt={fileName} 
          className="max-h-full max-w-full object-contain rounded"
        />
      </div>
    );
  }

  if (mimeType === 'application/pdf') {
    return (
      <div className="w-full rounded-lg overflow-hidden relative" style={{ height: '500px' }}>
        <iframe 
          src={fileUrl} 
          className="absolute inset-0 w-full h-full border-0"
          title={fileName}
        />
      </div>
    );
  }

  const FileIcon = getFileIcon(mimeType);
  return (
    <div className="flex flex-col items-center justify-center h-64 bg-muted rounded-lg gap-4">
      <FileIcon className="w-16 h-16 text-muted-foreground" />
      <p className="text-muted-foreground text-sm">Preview not available for this file type</p>
      <Button variant="outline" size="sm" asChild>
        <a href={fileUrl} target="_blank" rel="noopener noreferrer">
          <ExternalLink className="w-4 h-4 mr-2" />
          Open in new tab
        </a>
      </Button>
    </div>
  );
}

function VersionItem({ version, isSelected, onSelect, showPreview = false, onApprove, onReject, isUpdating, hasApprovedVersion }) {
  const statusConfig = STATUS_CONFIG[version.status] || STATUS_CONFIG.pending;
  const StatusIcon = statusConfig.icon;
  const [expanded, setExpanded] = useState(showPreview);

  const isApproved = version.status === 'approved';
  const isRejected = version.status === 'rejected';

  return (
    <div 
      className={`border rounded-lg p-3 ${isSelected ? 'ring-2 ring-primary' : ''}`}
      data-testid={`version-item-${version.id}`}
    >
      <div 
        className="flex items-center justify-between cursor-pointer"
        onClick={() => onSelect(version)}
      >
        <div className="flex items-center gap-3">
          <div className="text-sm font-medium">v{version.version}</div>
          <Badge 
            variant="outline" 
            className="text-xs"
            style={{ borderColor: statusConfig.color, color: statusConfig.color }}
          >
            <StatusIcon className="w-3 h-3 mr-1" />
            {statusConfig.label}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={isApproved ? 'default' : 'outline'}
            size="sm"
            onClick={(e) => { e.stopPropagation(); onApprove(version); }}
            disabled={isUpdating || isApproved}
            className={`h-7 px-2 ${isApproved ? 'bg-green-600 hover:bg-green-700' : ''}`}
            data-testid={`button-approve-version-${version.id}`}
          >
            <Check className="w-3 h-3 mr-1" />
            Approve
          </Button>
          <Button
            variant={isRejected ? 'default' : 'outline'}
            size="sm"
            onClick={(e) => { e.stopPropagation(); onReject(version); }}
            disabled={isUpdating || isRejected || isApproved}
            className={`h-7 px-2 ${isRejected ? 'bg-red-600 hover:bg-red-700' : ''}`}
            data-testid={`button-reject-version-${version.id}`}
          >
            <X className="w-3 h-3 mr-1" />
            Reject
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2"
            asChild
            onClick={(e) => e.stopPropagation()}
            data-testid={`button-download-version-${version.id}`}
          >
            <a href={version.file_url} target="_blank" rel="noopener noreferrer" download>
              <Download className="w-3 h-3 mr-1" />
              Download
            </a>
          </Button>
          <span className="text-xs text-muted-foreground">
            {version.created_at ? format(new Date(version.created_at), 'MMM d, yyyy') : '--'}
          </span>
          <Button 
            variant="ghost" 
            size="icon" 
            className="h-6 w-6"
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          >
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </Button>
        </div>
      </div>
      
      {expanded && (
        <div className="mt-3 pt-3 border-t space-y-3">
          <div className="min-h-[400px]">
            <FilePreview 
              fileUrl={version.file_url} 
              mimeType={version.mime_type} 
              fileName={version.file_name}
            />
          </div>
          
          {version.comments && version.comments.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Comments</p>
              {version.comments.map(comment => (
                <div key={comment.id} className="bg-muted p-2 rounded text-sm">
                  <p>{comment.comment}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {comment.author_name} - {format(new Date(comment.created_at), 'MMM d, yyyy h:mm a')}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function DocumentDetailModal({ 
  isOpen, 
  onClose, 
  document, 
  formSubmissionId,
  onDocumentUpdated 
}) {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('preview');
  const [newComment, setNewComment] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [selectedVersion, setSelectedVersion] = useState(null);

  const { data: versionsData, isLoading: versionsLoading } = useQuery({
    queryKey: ['document-versions', formSubmissionId, document?.field_name],
    queryFn: async () => {
      const result = await apiRequest(
        'GET', 
        `/api/due-diligence/documents/get-versions?formSubmissionId=${formSubmissionId}&fieldName=${encodeURIComponent(document.field_name)}`
      );
      return result.versions || [];
    },
    enabled: isOpen && !!formSubmissionId && !!document?.field_name
  });

  const versions = versionsData || [];
  const approvedVersion = versions.find(v => v.status === 'approved') || (document?.status === 'approved' ? document : null);
  const currentVersion = selectedVersion || versions.find(v => v.is_current_version) || document;
  const statusConfig = STATUS_CONFIG[approvedVersion ? 'approved' : 'pending'] || STATUS_CONFIG.pending;
  const StatusIcon = statusConfig.icon;

  const canSupersede = currentVersion?.status !== 'approved';

  const updateStatusMutation = useMutation({
    mutationFn: async ({ status, version }) => {
      const targetVersion = version || currentVersion;
      
      if (targetVersion.isFromForm) {
        const createResult = await apiRequest('POST', '/api/due-diligence/documents/create', {
          formSubmissionId,
          fieldName: document.field_name,
          fileUrl: document.file_url,
          fileName: document.file_name,
          fileSize: document.file_size,
          mimeType: document.mime_type
        });
        
        return await apiRequest('POST', '/api/due-diligence/documents/update-status', {
          documentId: createResult.document.id,
          status
        });
      }
      
      return await apiRequest('POST', '/api/due-diligence/documents/update-status', {
        documentId: targetVersion.id,
        status
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries(['submission-documents', formSubmissionId]);
      queryClient.invalidateQueries(['document-versions', formSubmissionId, document?.field_name]);
      toast.success('Document status updated');
      onDocumentUpdated?.();
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to update status');
    }
  });

  const handleApproveVersion = useCallback(async (version) => {
    try {
      if (approvedVersion && approvedVersion.id !== version.id) {
        await apiRequest('POST', '/api/due-diligence/documents/update-status', {
          documentId: approvedVersion.id,
          status: 'aged'
        });
      }
      updateStatusMutation.mutate({ status: 'approved', version });
    } catch (error) {
      toast.error('Failed to approve version: ' + (error.message || 'Unknown error'));
    }
  }, [approvedVersion, updateStatusMutation]);

  const handleRejectVersion = useCallback((version) => {
    updateStatusMutation.mutate({ status: 'rejected', version });
  }, [updateStatusMutation]);

  const addCommentMutation = useMutation({
    mutationFn: async ({ comment }) => {
      let docId = currentVersion.id;
      
      if (currentVersion.isFromForm) {
        const createResult = await apiRequest('POST', '/api/due-diligence/documents/create', {
          formSubmissionId,
          fieldName: document.field_name,
          fileUrl: document.file_url,
          fileName: document.file_name,
          fileSize: document.file_size,
          mimeType: document.mime_type
        });
        docId = createResult.document.id;
      }
      
      return await apiRequest('POST', '/api/due-diligence/documents/add-comment', {
        documentId: docId,
        comment
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries(['document-versions', formSubmissionId, document?.field_name]);
      setNewComment('');
      toast.success('Comment added');
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to add comment');
    }
  });

  const handleSupersede = useCallback(async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    setUploadProgress(0);

    try {
      const uploadResult = await uploadFileWithProgress(file, setUploadProgress);
      
      let supersedeDocId = null;
      if (!currentVersion.isFromForm) {
        supersedeDocId = currentVersion.id;
      } else {
        const createResult = await apiRequest('POST', '/api/due-diligence/documents/create', {
          formSubmissionId,
          fieldName: document.field_name,
          fileUrl: document.file_url,
          fileName: document.file_name,
          fileSize: document.file_size,
          mimeType: document.mime_type
        });
        supersedeDocId = createResult.document.id;
        
        await apiRequest('POST', '/api/due-diligence/documents/update-status', {
          documentId: supersedeDocId,
          status: 'aged'
        });
      }
      
      await apiRequest('POST', '/api/due-diligence/documents/create', {
        formSubmissionId,
        fieldName: document.field_name,
        fileUrl: uploadResult.file_url,
        fileName: uploadResult.file_name,
        fileSize: uploadResult.file_size,
        mimeType: uploadResult.mime_type,
        supersedeDocumentId: supersedeDocId
      });

      queryClient.invalidateQueries(['submission-documents', formSubmissionId]);
      queryClient.invalidateQueries(['document-versions', formSubmissionId, document?.field_name]);
      toast.success('New version uploaded successfully');
      onDocumentUpdated?.();
      
    } catch (error) {
      console.error('Upload error:', error);
      toast.error(error.message || 'Failed to upload new version');
    } finally {
      setIsUploading(false);
      setUploadProgress(0);
    }
  }, [currentVersion, formSubmissionId, document, queryClient, onDocumentUpdated]);

  const handleAddComment = () => {
    if (!newComment.trim()) return;
    addCommentMutation.mutate({ comment: newComment.trim() });
  };

  if (!document) return null;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="w-[80vw] max-w-[80vw] h-[90vh] max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <span className="truncate">{document.original_file_name || document.file_name}</span>
            <Badge 
              style={{ backgroundColor: statusConfig.bgColor, color: statusConfig.color, borderColor: statusConfig.color }}
              className="flex-shrink-0"
            >
              <StatusIcon className="w-3 h-3 mr-1" />
              {statusConfig.label}
            </Badge>
          </DialogTitle>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 overflow-hidden flex flex-col">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="preview" data-testid="tab-preview">
              <FileText className="w-4 h-4 mr-2" />
              Preview
            </TabsTrigger>
            <TabsTrigger value="versions" data-testid="tab-versions">
              <History className="w-4 h-4 mr-2" />
              Versions ({versions.length || 1})
            </TabsTrigger>
            <TabsTrigger value="comments" data-testid="tab-comments">
              <MessageSquare className="w-4 h-4 mr-2" />
              Comments
            </TabsTrigger>
          </TabsList>

          <TabsContent value="preview" className="flex-1 overflow-auto mt-4 h-full">
            {approvedVersion ? (
              <div className="flex flex-col h-full gap-4">
                <div className="flex-1 min-h-0">
                  <FilePreview 
                    fileUrl={approvedVersion.file_url} 
                    mimeType={approvedVersion.mime_type} 
                    fileName={approvedVersion.file_name}
                  />
                </div>
                
                <div className="grid grid-cols-2 gap-4 text-sm flex-shrink-0">
                  <div>
                    <span className="text-muted-foreground">File size:</span>
                    <span className="ml-2">
                      {approvedVersion.file_size 
                        ? `${(approvedVersion.file_size / 1024).toFixed(1)} KB` 
                        : '--'}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Version:</span>
                    <span className="ml-2">{approvedVersion.version || 1}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Uploaded:</span>
                    <span className="ml-2">
                      {approvedVersion.created_at 
                        ? format(new Date(approvedVersion.created_at), 'MMM d, yyyy h:mm a') 
                        : '--'}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Type:</span>
                    <span className="ml-2">{approvedVersion.mime_type || '--'}</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center bg-muted rounded-lg gap-4" style={{ height: '500px' }}>
                <Clock className="w-12 h-12 text-muted-foreground" />
                <p className="text-muted-foreground text-center">
                  No approved version yet.<br />
                  <span className="text-sm">Go to the Versions tab to approve a version.</span>
                </p>
              </div>
            )}
          </TabsContent>

          <TabsContent value="versions" className="flex-1 overflow-auto mt-4 h-full">
            <ScrollArea className="h-full">
              <div className="space-y-3 pr-4">
                {versionsLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="w-6 h-6 animate-spin" />
                  </div>
                ) : versions.length > 0 ? (
                  versions.map((version, index) => (
                    <VersionItem 
                      key={version.id} 
                      version={version}
                      isSelected={selectedVersion?.id === version.id}
                      onSelect={setSelectedVersion}
                      showPreview={index === 0}
                      onApprove={handleApproveVersion}
                      onReject={handleRejectVersion}
                      isUpdating={updateStatusMutation.isPending}
                      hasApprovedVersion={!!approvedVersion}
                    />
                  ))
                ) : (
                  <VersionItem 
                    version={{ ...document, version: 1, is_current_version: true }}
                    isSelected={true}
                    onSelect={() => {}}
                    showPreview={true}
                    onApprove={handleApproveVersion}
                    onReject={handleRejectVersion}
                    isUpdating={updateStatusMutation.isPending}
                    hasApprovedVersion={!!approvedVersion}
                  />
                )}
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="comments" className="flex-1 overflow-auto mt-4">
            <div className="space-y-4">
              <ScrollArea className="h-[300px]">
                <div className="space-y-3 pr-4">
                  {currentVersion?.comments && currentVersion.comments.length > 0 ? (
                    currentVersion.comments.map(comment => (
                      <div key={comment.id} className="bg-muted p-3 rounded-lg">
                        <p className="text-sm">{comment.comment}</p>
                        <p className="text-xs text-muted-foreground mt-2">
                          {comment.author_name} - {format(new Date(comment.created_at), 'MMM d, yyyy h:mm a')}
                        </p>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground text-center py-8">
                      No comments yet
                    </p>
                  )}
                </div>
              </ScrollArea>
              
              <div className="flex gap-2">
                <Textarea 
                  placeholder="Add a comment..."
                  value={newComment}
                  onChange={(e) => setNewComment(e.target.value)}
                  className="min-h-[80px]"
                  data-testid="textarea-new-comment"
                />
              </div>
              <Button 
                onClick={handleAddComment}
                disabled={!newComment.trim() || addCommentMutation.isPending}
                data-testid="button-add-comment"
              >
                {addCommentMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Send className="w-4 h-4 mr-2" />
                )}
                Add Comment
              </Button>
            </div>
          </TabsContent>
        </Tabs>

        <Separator className="my-4" />

        <div className="flex items-center justify-end gap-2">
          {canSupersede && (
            <div className="relative">
              <input
                type="file"
                className="absolute inset-0 opacity-0 cursor-pointer"
                onChange={handleSupersede}
                disabled={isUploading}
                data-testid="input-supersede-file"
              />
              <Button 
                variant="outline" 
                size="sm"
                disabled={isUploading}
              >
                {isUploading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    {uploadProgress}%
                  </>
                ) : (
                  <>
                    <Upload className="w-4 h-4 mr-2" />
                    Upload New Version
                  </>
                )}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
