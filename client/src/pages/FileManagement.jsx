import React, { useState, useMemo, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Upload, FileText, Image, Video, File, Trash2, Search, X, Copy, ExternalLink, Folder, FolderOpen, FolderPlus, MoveHorizontal, ChevronRight, Home, GripVertical, Pencil, ChevronDown, ChevronLeft, Loader2 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { format } from "date-fns";
import { useMemberAccess } from "@/hooks/useMemberAccess";

export default function FileManagementPage() {
  const { isFeatureExcluded, memberInfo, isAccessReady } = useMemberAccess();
  const [uploadingFile, setUploadingFile] = useState(false);
  const [editingFile, setEditingFile] = useState(null);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [fileTypeFilter, setFileTypeFilter] = useState("all");
  const [newTag, setNewTag] = useState("");

  // Folder management states
  const [selectedFolder, setSelectedFolder] = useState(null);
  const [showFolderDialog, setShowFolderDialog] = useState(false);
  const [editingFolder, setEditingFolder] = useState(null);
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const [showMoveFolderDialog, setShowMoveFolderDialog] = useState(false);
  const [folderToMove, setFolderToMove] = useState(null);
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [bulkMoveMode, setBulkMoveMode] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState({});

  // Drag and drop states
  const [draggedFiles, setDraggedFiles] = useState([]);
  const [dragOverFolder, setDragOverFolder] = useState(null);
  const [autoExpandTimeout, setAutoExpandTimeout] = useState(null);

  // Pagination states
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(12);

  const queryClient = useQueryClient();

  const { data: files = [], isLoading } = useQuery({
    queryKey: ['file-repository'],
    queryFn: () => base44.entities.FileRepository.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  // Fetch folders (using FileRepositoryFolder entity)
  const { data: folders = [], isLoading: foldersLoading } = useQuery({
    queryKey: ['file-repository-folders'],
    queryFn: () => base44.entities.FileRepositoryFolder.list('display_order'),
    staleTime: 0,
    refetchOnMount: true,
  });

  // Build folder hierarchy
  const folderHierarchy = useMemo(() => {
    const buildTree = (parentId) => {
      return folders
        .filter(f => f.parent_folder_id === parentId)
        .sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
        .map(folder => ({
          ...folder,
          children: buildTree(folder.id)
        }));
    };
    return buildTree(null);
  }, [folders]);

  // Get breadcrumb trail
  const getBreadcrumb = (folderId) => {
    if (!folderId) return [];
    const trail = [];
    let currentId = folderId;

    while (currentId) {
      const folder = folders.find(f => f.id === currentId);
      if (folder) {
        trail.unshift(folder);
        currentId = folder.parent_folder_id;
      } else {
        break;
      }
    }
    return trail;
  };

  const breadcrumb = useMemo(() => getBreadcrumb(selectedFolder), [selectedFolder, folders]);

  // Get all subfolders recursively
  const getAllSubfolderIds = (folderId) => {
    const result = [folderId];
    const children = folders.filter(f => f.parent_folder_id === folderId);
    children.forEach(child => {
      result.push(...getAllSubfolderIds(child.id));
    });
    return result;
  };

  // Get file count for each folder
  const getFolderFileCount = (folderId) => {
    return files.filter(f => f.folder_id === folderId).length;
  };

  // Folder mutations
  const createFolderMutation = useMutation({
    mutationFn: (data) => base44.entities.FileRepositoryFolder.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['file-repository-folders'] });
      setShowFolderDialog(false);
      setEditingFolder(null);
      toast.success('Folder created successfully');
    },
    onError: (error) => {
      toast.error('Failed to create folder: ' + error.message);
    }
  });

  const updateFolderMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.FileRepositoryFolder.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['file-repository-folders'] });
      setShowFolderDialog(false);
      setEditingFolder(null);
      toast.success('Folder updated successfully');
    },
    onError: (error) => {
      toast.error('Failed to update folder: ' + error.message);
    }
  });

  const deleteFolderMutation = useMutation({
    mutationFn: async (folderId) => {
      const allFolderIds = getAllSubfolderIds(folderId);
      const filesInFolders = files.filter(f => allFolderIds.includes(f.folder_id));
      for (const file of filesInFolders) {
        await base44.entities.FileRepository.update(file.id, { folder_id: null });
      }
      const foldersToDelete = folders.filter(f => allFolderIds.includes(f.id))
                                     .sort((a, b) => getBreadcrumb(b.id).length - getBreadcrumb(a.id).length);
      for (const folder of foldersToDelete) {
        await base44.entities.FileRepositoryFolder.delete(folder.id);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['file-repository-folders'] });
      queryClient.invalidateQueries({ queryKey: ['file-repository'] });
      setSelectedFolder(null);
      toast.success('Folder and its subfolders deleted, files moved to root');
    },
    onError: (error) => {
      toast.error('Failed to delete folder: ' + error.message);
    }
  });

  const moveFolderMutation = useMutation({
    mutationFn: async ({ folderId, newParentId }) => {
      if (newParentId) {
        const wouldCreateCircle = getAllSubfolderIds(folderId).includes(newParentId);
        if (wouldCreateCircle) {
          throw new Error('Cannot move a folder into its own subfolder');
        }
      }
      await base44.entities.FileRepositoryFolder.update(folderId, { parent_folder_id: newParentId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['file-repository-folders'] });
      setShowMoveFolderDialog(false);
      setFolderToMove(null);
      toast.success('Folder moved successfully');
    },
    onError: (error) => {
      toast.error('Failed to move folder: ' + error.message);
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.FileRepository.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['file-repository'] });
      toast.success('File deleted successfully');
    },
    onError: (error) => {
      toast.error('Failed to delete file: ' + error.message);
    }
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.FileRepository.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['file-repository'] });
      setShowEditDialog(false);
      setEditingFile(null);
      toast.success('File updated successfully');
    },
    onError: (error) => {
      toast.error('Failed to update file: ' + error.message);
    }
  });

  // Move files mutation
  const moveFilesMutation = useMutation({
    mutationFn: async ({ fileIds, folderId }) => {
      for (const fileId of fileIds) {
        await base44.entities.FileRepository.update(fileId, { folder_id: folderId });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['file-repository'] });
      setShowMoveDialog(false);
      setSelectedFiles([]);
      setBulkMoveMode(false);
      toast.success('Files moved successfully');
    },
    onError: (error) => {
      toast.error('Failed to move files: ' + error.message);
    }
  });

  const filteredFiles = useMemo(() => {
    return files.filter(file => {
      const matchesFolder = selectedFolder === null
        ? !file.folder_id
        : file.folder_id === selectedFolder;
      const matchesSearch = !searchQuery ||
        file.file_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        file.description?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        file.tags?.some(tag => tag.toLowerCase().includes(searchQuery.toLowerCase()));
      const matchesType = fileTypeFilter === "all" || file.file_type === fileTypeFilter;
      return matchesFolder && matchesSearch && matchesType;
    });
  }, [files, selectedFolder, searchQuery, fileTypeFilter]);

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, fileTypeFilter, selectedFolder, itemsPerPage]);

  // Pagination calculations
  const totalPages = Math.ceil(filteredFiles.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedFiles = filteredFiles.slice(startIndex, endIndex);

  // Generate page numbers for pagination
  const getPageNumbers = () => {
    const pages = [];
    const maxVisible = 5;
    
    if (totalPages <= maxVisible) {
      for (let i = 1; i <= totalPages; i++) {
        pages.push(i);
      }
    } else {
      if (currentPage <= 3) {
        for (let i = 1; i <= 4; i++) pages.push(i);
        if (totalPages > 5) pages.push('...');
        pages.push(totalPages);
      } else if (currentPage >= totalPages - 2) {
        pages.push(1);
        if (totalPages > 5) pages.push('...');
        for (let i = totalPages - 3; i <= totalPages; i++) pages.push(i);
      } else {
        pages.push(1);
        pages.push('...');
        for (let i = currentPage - 1; i <= currentPage + 1; i++) pages.push(i);
        pages.push('...');
        pages.push(totalPages);
      }
    }
    return pages;
  };

  const handlePageChange = (page) => {
    setCurrentPage(page);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Drag and Drop Handlers
  const handleDragStart = (e, file) => {
    if (bulkMoveMode && selectedFiles.includes(file.id)) {
      setDraggedFiles(selectedFiles);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', JSON.stringify(selectedFiles));

      const dragImage = document.createElement('div');
      dragImage.className = 'bg-blue-600 text-white px-4 py-2 rounded-lg shadow-lg font-medium';
      dragImage.textContent = `Moving ${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''}`;
      dragImage.style.position = 'absolute';
      dragImage.style.top = '-1000px';
      document.body.appendChild(dragImage);
      e.dataTransfer.setDragImage(dragImage, 0, 0);
      setTimeout(() => document.body.removeChild(dragImage), 0);
    } else {
      setDraggedFiles([file.id]);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', JSON.stringify([file.id]));
    }
  };

  const handleDragEnd = () => {
    setDraggedFiles([]);
    setDragOverFolder(null);
    if (autoExpandTimeout) {
      clearTimeout(autoExpandTimeout);
      setAutoExpandTimeout(null);
    }
  };

  const handleDragOver = (e, folderId) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';

    if (dragOverFolder !== folderId) {
      setDragOverFolder(folderId);

      if (autoExpandTimeout) {
        clearTimeout(autoExpandTimeout);
      }

      if (folderId && !expandedFolders[folderId]) {
        const timeout = setTimeout(() => {
          setExpandedFolders(prev => ({ ...prev, [folderId]: true }));
        }, 800);
        setAutoExpandTimeout(timeout);
      }
    }
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;

    if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) {
      setDragOverFolder(null);
      if (autoExpandTimeout) {
        clearTimeout(autoExpandTimeout);
        setAutoExpandTimeout(null);
      }
    }
  };

  const handleDrop = async (e, folderId) => {
    e.preventDefault();
    e.stopPropagation();

    if (autoExpandTimeout) {
      clearTimeout(autoExpandTimeout);
      setAutoExpandTimeout(null);
    }

    setDragOverFolder(null);

    try {
      const fileIds = JSON.parse(e.dataTransfer.getData('text/plain'));

      if (fileIds && fileIds.length > 0) {
        await moveFilesMutation.mutateAsync({
          fileIds,
          folderId: folderId === 'root' ? null : folderId
        });
      }
    } catch (error) {
      console.error('Drop error:', error);
    }

    setDraggedFiles([]);
  };

  const handleFileUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploadingFile(true);
    try {
      const { file_url } = await base44.integrations.Core.UploadFile({ file });

      let fileType = "other";
      if (file.type.startsWith("image/")) fileType = "image";
      else if (file.type.startsWith("video/")) fileType = "video";
      else if (file.type.includes("pdf") || file.type.includes("document")) fileType = "document";

      await base44.entities.FileRepository.create({
        file_name: file.name,
        file_url: file_url,
        file_type: fileType,
        mime_type: file.type,
        file_size: file.size,
        uploaded_by: memberInfo?.email || "unknown",
        folder_id: selectedFolder
      });

      queryClient.invalidateQueries({ queryKey: ['file-repository'] });
      toast.success('File uploaded successfully');
      event.target.value = '';
    } catch (error) {
      toast.error('Failed to upload file: ' + error.message);
    } finally {
      setUploadingFile(false);
    }
  };

  const handleEdit = (file) => {
    setEditingFile({ ...file });
    setShowEditDialog(true);
  };

  const handleSaveEdit = () => {
    if (!editingFile) return;

    updateMutation.mutate({
      id: editingFile.id,
      data: {
        description: editingFile.description || "",
        tags: editingFile.tags || []
      }
    });
  };

  const handleAddTag = () => {
    if (!newTag.trim() || !editingFile) return;
    if (editingFile.tags?.includes(newTag.trim())) {
      toast.error('Tag already exists');
      return;
    }
    setEditingFile({
      ...editingFile,
      tags: [...(editingFile.tags || []), newTag.trim()]
    });
    setNewTag("");
  };

  const handleRemoveTag = (tag) => {
    if (!editingFile) return;
    setEditingFile({
      ...editingFile,
      tags: (editingFile.tags || []).filter(t => t !== tag)
    });
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    toast.success('URL copied to clipboard');
  };

  // Folder handlers
  const handleCreateFolder = () => {
    setEditingFolder({
      name: "",
      description: "",
      parent_folder_id: selectedFolder,
      display_order: folders.filter(f => f.parent_folder_id === selectedFolder).length
    });
    setShowFolderDialog(true);
  };

  const handleEditFolder = (folder) => {
    setEditingFolder(folder);
    setShowFolderDialog(true);
  };

  const handleSaveFolder = () => {
    if (!editingFolder.name.trim()) {
      toast.error('Folder name is required');
      return;
    }

    const payload = {
      name: editingFolder.name,
      description: editingFolder.description || "",
      parent_folder_id: editingFolder.parent_folder_id || null,
      display_order: editingFolder.display_order || 0
    };

    if (editingFolder.id) {
      updateFolderMutation.mutate({ id: editingFolder.id, data: payload });
    } else {
      createFolderMutation.mutate(payload);
    }
  };

  const handleDeleteFolder = (folderId) => {
    const folder = folders.find(f => f.id === folderId);
    const subfolders = folders.filter(f => f.parent_folder_id === folderId);
    const hasSubfolders = subfolders.length > 0;

    const message = hasSubfolders
      ? 'This folder contains subfolders. All subfolders and their files will be moved to root. Continue?'
      : 'Are you sure you want to delete this folder? Files will be moved to root.';

    if (confirm(message)) {
      deleteFolderMutation.mutate(folderId);
    }
  };

  const handleMoveFolder = (folder) => {
    setFolderToMove(folder);
    setShowMoveFolderDialog(true);
  };

  const handleMoveFolderToDestination = (newParentId) => {
    if (folderToMove) {
      moveFolderMutation.mutate({
        folderId: folderToMove.id,
        newParentId: newParentId === 'root' ? null : newParentId
      });
    }
  };

  const handleToggleFolder = (folderId) => {
    setExpandedFolders(prev => ({
      ...prev,
      [folderId]: !prev[folderId]
    }));
  };

  const handleToggleFileSelection = (fileId) => {
    setSelectedFiles(prev =>
      prev.includes(fileId)
        ? prev.filter(id => id !== fileId)
        : [...prev, fileId]
    );
  };

  const handleSelectAll = () => {
    if (selectedFiles.length === filteredFiles.length) {
      setSelectedFiles([]);
    } else {
      setSelectedFiles(filteredFiles.map(f => f.id));
    }
  };

  const handleBulkMove = () => {
    if (selectedFiles.length === 0) {
      toast.error('Please select files to move');
      return;
    }
    setShowMoveDialog(true);
  };

  const handleMoveFiles = (folderId) => {
    moveFilesMutation.mutate({
      fileIds: selectedFiles,
      folderId: folderId === 'root' ? null : folderId
    });
  };

  const handleMoveFileToFolder = (fileId, folderId) => {
    moveFilesMutation.mutate({
      fileIds: [fileId],
      folderId: folderId === 'root' ? null : folderId
    });
  };

  // Recursive folder tree renderer
  const renderFolderTree = (folderList, depth = 0) => {
    return folderList.map(folder => {
      const isExpanded = expandedFolders[folder.id];
      const hasChildren = folder.children && folder.children.length > 0;
      const isSelected = selectedFolder === folder.id;
      const isDragOver = dragOverFolder === folder.id;

      return (
        <div key={folder.id}>
          <div
            className="relative group"
            onDragOver={(e) => handleDragOver(e, folder.id)}
            onDrop={(e) => handleDrop(e, folder.id)}
          >
            <div
              className={`flex items-center gap-2 py-2 px-3 rounded cursor-pointer transition-all ${
                isSelected ? 'bg-blue-100' : 'hover:bg-slate-100'
              } ${
                isDragOver ? 'bg-blue-200 ring-2 ring-blue-400' : ''
              }`}
              style={{ paddingLeft: `${depth * 20 + 12}px` }}
            >
              {hasChildren ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleToggleFolder(folder.id);
                  }}
                  className="p-0.5 hover:bg-slate-200 rounded"
                >
                  <ChevronRight className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                </button>
              ) : (
                <div className="w-5 h-5 flex-shrink-0" />
              )}

              <Folder className="w-4 h-4 text-slate-600 shrink-0" />

              <span
                onClick={() => setSelectedFolder(folder.id)}
                className="flex-1 text-sm"
              >
                {folder.name}
              </span>

              <span className="text-xs text-slate-500">
                ({getFolderFileCount(folder.id)})
              </span>

              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleEditFolder(folder);
                  }}
                  className="p-1 hover:bg-slate-200 rounded"
                  title="Edit folder"
                >
                  <Pencil className="w-3 h-3 text-slate-600" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleMoveFolder(folder);
                  }}
                  className="p-1 hover:bg-blue-100 rounded"
                  title="Move folder"
                >
                  <MoveHorizontal className="w-3 h-3 text-blue-600" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteFolder(folder.id);
                  }}
                  className="p-1 hover:bg-red-100 rounded"
                  title="Delete folder"
                >
                  <Trash2 className="w-3 h-3 text-red-600" />
                </button>
              </div>
            </div>
          </div>

          {hasChildren && isExpanded && (
            <div>
              {renderFolderTree(folder.children, depth + 1)}
            </div>
          )}
        </div>
      );
    });
  };

  // Recursive folder selector for move dialogs
  const renderFolderSelector = (folderList, excludeId = null, depth = 0) => {
    return folderList.map(folder => {
      const allExcludedIds = excludeId ? getAllSubfolderIds(excludeId) : [];
      if (allExcludedIds.includes(folder.id)) return null;

      return (
        <div key={folder.id}>
          <Button
            variant="outline"
            className="w-full justify-start mb-1"
            onClick={() => {
              if (showMoveFolderDialog) {
                handleMoveFolderToDestination(folder.id);
              } else {
                handleMoveFiles(folder.id);
              }
            }}
            style={{ paddingLeft: `${depth * 20 + 16}px` }}
          >
            <Folder className="w-4 h-4 mr-2" />
            {folder.name}
          </Button>
          {folder.children && folder.children.length > 0 && (
            <div className="ml-4">
              {renderFolderSelector(folder.children, excludeId, depth + 1)}
            </div>
          )}
        </div>
      );
    });
  };

  const getFileIcon = (type) => {
    switch (type) {
      case "image": return <Image className="w-8 h-8 text-blue-600" />;
      case "video": return <Video className="w-8 h-8 text-purple-600" />;
      case "document": return <FileText className="w-8 h-8 text-green-600" />;
      default: return <File className="w-8 h-8 text-slate-600" />;
    }
  };

  const formatFileSize = (bytes) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  if (isFeatureExcluded('content.files')) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Card className="border-red-200">
          <CardContent className="p-8 text-center">
            <p className="text-red-600">You need administrator privileges to access this page.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
              File Repository
            </h1>
            <p className="text-slate-600">
              Upload and manage files • Drag files to folders
            </p>
          </div>
          <div className="flex gap-2">
            <Button onClick={handleCreateFolder} variant="outline" className="border-blue-600 text-blue-600 hover:bg-blue-50">
              <FolderPlus className="w-4 h-4 mr-2" />
              {selectedFolder ? 'New Subfolder' : 'New Folder'}
            </Button>
            <input
              type="file"
              id="file-upload"
              className="hidden"
              onChange={handleFileUpload}
              disabled={uploadingFile}
            />
            <Button
              onClick={() => document.getElementById('file-upload')?.click()}
              disabled={uploadingFile}
              className="bg-blue-600 hover:bg-blue-700"
            >
              <Upload className="w-4 h-4 mr-2" />
              {uploadingFile ? 'Uploading...' : 'Upload File'}
            </Button>
          </div>
        </div>

        {/* Bulk Move Mode Banner */}
        {bulkMoveMode && (
          <Card className="border-blue-500 bg-blue-50 shadow-md mb-6">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="bg-blue-600 text-white rounded-full p-2">
                    <MoveHorizontal className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-blue-900">Bulk Move Mode Active</h3>
                    <p className="text-sm text-blue-700">
                      {selectedFiles.length === 0
                        ? "Select files below or drag them to folders"
                        : `${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''} selected • Drag to move`}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  {filteredFiles.length > 0 && (
                    <Button
                      onClick={handleSelectAll}
                      size="sm"
                      variant="outline"
                      className="bg-white"
                    >
                      {selectedFiles.length === filteredFiles.length ? 'Deselect All' : 'Select All'}
                    </Button>
                  )}
                  {selectedFiles.length > 0 && (
                    <Button
                      onClick={handleBulkMove}
                      size="sm"
                      className="bg-blue-600 hover:bg-blue-700"
                    >
                      <MoveHorizontal className="w-4 h-4 mr-2" />
                      Move {selectedFiles.length} Selected
                    </Button>
                  )}
                  <Button
                    onClick={() => {
                      setBulkMoveMode(false);
                      setSelectedFiles([]);
                    }}
                    size="sm"
                    variant="ghost"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Folder Navigation */}
        <Card className="border-slate-200 shadow-sm mb-6">
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Folder className="w-5 h-5 text-slate-600" />
                <h3 className="font-semibold text-slate-900">Folders</h3>
                <Badge variant="outline" className="ml-2 text-xs">
                  Drag & Drop Enabled
                </Badge>
              </div>
              {!bulkMoveMode && (
                <Button
                  onClick={() => setBulkMoveMode(true)}
                  size="sm"
                  variant="outline"
                >
                  <MoveHorizontal className="w-4 h-4 mr-2" />
                  Bulk Move Mode
                </Button>
              )}
            </div>

            {/* Breadcrumb */}
            {(breadcrumb.length > 0 || selectedFolder === null) && (
              <div className="flex items-center gap-2 mb-4 p-2 bg-slate-50 rounded-lg">
                <button
                  onClick={() => setSelectedFolder(null)}
                  className="flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900"
                >
                  <Home className="w-4 h-4" />
                  Root
                </button>
                {breadcrumb.map((folder, idx) => (
                  <React.Fragment key={folder.id}>
                    <ChevronRight className="w-4 h-4 text-slate-400" />
                    <button
                      onClick={() => setSelectedFolder(folder.id)}
                      className={`text-sm ${
                        idx === breadcrumb.length - 1
                          ? 'text-blue-600 font-medium'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {folder.name}
                    </button>
                  </React.Fragment>
                ))}
              </div>
            )}

            {/* Folder Tree */}
            <div
              className="border border-slate-200 rounded-lg p-2 max-h-96 overflow-y-auto"
              onDragLeave={handleDragLeave}
            >
              <div
                className={`flex items-center gap-2 py-2 px-3 rounded cursor-pointer transition-all ${
                  selectedFolder === null ? 'bg-blue-100' : 'hover:bg-slate-100'
                } ${
                  dragOverFolder === 'root' ? 'bg-blue-200 ring-2 ring-blue-400' : ''
                }`}
                onClick={() => setSelectedFolder(null)}
                onDragOver={(e) => handleDragOver(e, 'root')}
                onDrop={(e) => handleDrop(e, 'root')}
              >
                <FolderOpen className="w-4 h-4 text-slate-600" />
                <span className="flex-1 text-sm font-medium">Root</span>
                <span className="text-xs text-slate-500">
                  ({files.filter(f => !f.folder_id).length})
                </span>
              </div>
              {renderFolderTree(folderHierarchy)}
            </div>
          </CardContent>
        </Card>

        {/* Filters */}
        <Card className="border-slate-200 shadow-sm mb-6">
          <CardContent className="p-4">
            <div className="flex flex-col md:flex-row gap-4">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  placeholder="Search files..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
              <Tabs value={fileTypeFilter} onValueChange={setFileTypeFilter} className="w-full md:w-auto">
                <TabsList>
                  <TabsTrigger value="all">All</TabsTrigger>
                  <TabsTrigger value="image">Images</TabsTrigger>
                  <TabsTrigger value="document">Documents</TabsTrigger>
                  <TabsTrigger value="video">Videos</TabsTrigger>
                  <TabsTrigger value="other">Other</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          </CardContent>
        </Card>

        {/* Files Grid */}
        {isLoading ? (
          <div className="text-center py-12">Loading files...</div>
        ) : filteredFiles.length === 0 ? (
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-12 text-center">
              <Upload className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">
                No Files Found
              </h3>
              <p className="text-slate-600 mb-6">
                {searchQuery || fileTypeFilter !== "all" || selectedFolder
                  ? "Try adjusting your filters"
                  : "Upload your first file to get started"}
              </p>
              {!searchQuery && fileTypeFilter === "all" && (
                <Button
                  onClick={() => document.getElementById('file-upload')?.click()}
                  className="bg-blue-600 hover:bg-blue-700"
                >
                  <Upload className="w-4 h-4 mr-2" />
                  Upload File
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Results Summary */}
            <div className="mb-4 text-sm text-slate-600">
              Showing {startIndex + 1}-{Math.min(endIndex, filteredFiles.length)} of {filteredFiles.length} files
            </div>

            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
              {paginatedFiles.map((file) => {
                const isSelected = selectedFiles.includes(file.id);
                const isDragging = draggedFiles.includes(file.id);

                return (
                  <Card
                    key={file.id}
                    draggable={true}
                    onDragStart={(e) => handleDragStart(e, file)}
                    onDragEnd={handleDragEnd}
                    className={`border-slate-200 shadow-sm hover:shadow-md transition-all relative ${
                      bulkMoveMode ? 'cursor-pointer' : 'cursor-grab'
                    } ${
                      isSelected ? 'ring-4 ring-blue-500 bg-blue-50' : ''
                    } ${
                      isDragging ? 'opacity-50' : ''
                    }`}
                    onClick={() => {
                      if (bulkMoveMode) {
                        handleToggleFileSelection(file.id);
                      }
                    }}
                  >
                    {/* Drag Handle */}
                    <div className="absolute top-2 right-2 z-10 p-1 bg-slate-100 rounded hover:bg-slate-200 cursor-grab">
                      <GripVertical className="w-4 h-4 text-slate-400" />
                    </div>

                    {bulkMoveMode && (
                      <div className="absolute top-3 left-3 z-10">
                        <div className={`w-6 h-6 rounded border-2 flex items-center justify-center transition-all ${
                          isSelected
                            ? 'bg-blue-600 border-blue-600'
                            : 'bg-white border-slate-300'
                        }`}>
                          {isSelected && (
                            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </div>
                      </div>
                    )}

                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between gap-2">
                        {file.file_type === "image" ? (
                          <div className="w-full h-40 mb-3 rounded-lg overflow-hidden bg-slate-100">
                            <img
                              src={file.file_url}
                              alt={file.file_name}
                              className="w-full h-full object-cover"
                            />
                          </div>
                        ) : (
                          <div className="flex items-center gap-3 mb-3">
                            {getFileIcon(file.file_type)}
                            <div className="flex-1 min-w-0">
                              <CardTitle className="text-sm truncate">{file.file_name}</CardTitle>
                              <p className="text-xs text-slate-500">{formatFileSize(file.file_size)}</p>
                            </div>
                          </div>
                        )}
                      </div>
                      {file.description && (
                        <p className="text-xs text-slate-600 line-clamp-2 mt-2">{file.description}</p>
                      )}
                      {file.tags && file.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {file.tags.map((tag, idx) => (
                            <Badge key={idx} variant="secondary" className="text-xs">
                              {tag}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </CardHeader>
                    <CardContent className="pt-0">
                      <div className="flex gap-2 mb-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            copyToClipboard(file.file_url);
                          }}
                          className="flex-1"
                        >
                          <Copy className="w-3 h-3 mr-1" />
                          Copy URL
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            window.open(file.file_url, '_blank');
                          }}
                        >
                          <ExternalLink className="w-3 h-3" />
                        </Button>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleEdit(file);
                          }}
                          className="flex-1"
                        >
                          Edit Info
                        </Button>
                        {!bulkMoveMode && (
                          <Select
                            value={file.folder_id || 'root'}
                            onValueChange={(value) => {
                              handleMoveFileToFolder(file.id, value);
                            }}
                          >
                            <SelectTrigger className="w-28" onClick={(e) => e.stopPropagation()}>
                              <MoveHorizontal className="w-3 h-3 mr-1" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="root">Root</SelectItem>
                              {folders.map(folder => (
                                <SelectItem key={folder.id} value={folder.id}>
                                  {folder.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteMutation.mutate(file.id);
                          }}
                          className="text-red-600 hover:text-red-700 hover:bg-red-50"
                        >
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                      <p className="text-xs text-slate-500 mt-2">
                        {file.created_date ? `Uploaded ${format(new Date(file.created_date), 'MMM d, yyyy')}` : 'Uploaded'}
                      </p>
                    </CardContent>
                  </Card>
                );
              })}
            </div>

            {/* Pagination Controls */}
            {filteredFiles.length > 0 && (
              <Card className="border-slate-200 shadow-sm">
                <CardContent className="p-6">
                  <div className="flex flex-col md:flex-row items-center justify-between gap-4">
                    {/* Items per page selector */}
                    <div className="flex items-center gap-3">
                      <span className="text-sm text-slate-600">Items per page:</span>
                      <Select value={itemsPerPage.toString()} onValueChange={(val) => {
                        setItemsPerPage(Number(val));
                        setCurrentPage(1);
                      }}>
                        <SelectTrigger className="w-20">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="12">12</SelectItem>
                          <SelectItem value="24">24</SelectItem>
                          <SelectItem value="48">48</SelectItem>
                          <SelectItem value="96">96</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Page info */}
                    <div className="text-sm text-slate-600">
                      Page {currentPage} of {totalPages}
                    </div>

                    {/* Page navigation */}
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handlePageChange(currentPage - 1)}
                        disabled={currentPage === 1}
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </Button>

                      {getPageNumbers().map((page, idx) => (
                        <React.Fragment key={idx}>
                          {page === '...' ? (
                            <span className="px-2 text-slate-400">...</span>
                          ) : (
                            <Button
                              variant={currentPage === page ? "default" : "outline"}
                              size="sm"
                              onClick={() => handlePageChange(page)}
                              className={currentPage === page ? "bg-blue-600 hover:bg-blue-700" : ""}
                            >
                              {page}
                            </Button>
                          )}
                        </React.Fragment>
                      ))}

                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handlePageChange(currentPage + 1)}
                        disabled={currentPage === totalPages}
                      >
                        <ChevronRight className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}
          </>
        )}

        {/* Folder Dialog */}
        <Dialog open={showFolderDialog} onOpenChange={(open) => {
          setShowFolderDialog(open);
          if (!open) setEditingFolder(null);
        }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>
                {editingFolder?.id ? 'Edit Folder' : (selectedFolder ? 'Create New Subfolder' : 'Create New Folder')}
              </DialogTitle>
            </DialogHeader>

            {editingFolder && (
              <div className="space-y-4">
                {editingFolder.parent_folder_id && (
                  <div className="p-3 bg-blue-50 rounded-lg">
                    <p className="text-sm text-blue-900">
                      <span className="font-medium">Parent Folder: </span>
                      {folders.find(f => f.id === editingFolder.parent_folder_id)?.name || 'Root'}
                    </p>
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="folder-name">Folder Name *</Label>
                  <Input
                    id="folder-name"
                    value={editingFolder.name}
                    onChange={(e) => setEditingFolder({ ...editingFolder, name: e.target.value })}
                    placeholder="e.g., Marketing Assets"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="folder-description">Description (Optional)</Label>
                  <Textarea
                    id="folder-description"
                    value={editingFolder.description || ''}
                    onChange={(e) => setEditingFolder({ ...editingFolder, description: e.target.value })}
                    placeholder="Brief description of this folder..."
                    rows={3}
                  />
                </div>
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => setShowFolderDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleSaveFolder}
                disabled={createFolderMutation.isPending || updateFolderMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
              >
                {editingFolder?.id ? 'Update Folder' : 'Create Folder'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Move Files Dialog */}
        <Dialog open={showMoveDialog} onOpenChange={(open) => {
          setShowMoveDialog(open);
        }}>
          <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Move Files to Folder</DialogTitle>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <p className="text-sm text-slate-600">
                Select a folder to move {selectedFiles.length} selected file{selectedFiles.length > 1 ? 's' : ''} to:
              </p>

              <div className="space-y-2">
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => handleMoveFiles('root')}
                >
                  <FolderOpen className="w-4 h-4 mr-2" />
                  Root (No Folder)
                </Button>

                {renderFolderSelector(folderHierarchy)}
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setShowMoveDialog(false)}>
                Cancel
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Move Folder Dialog */}
        <Dialog open={showMoveFolderDialog} onOpenChange={(open) => {
          setShowMoveFolderDialog(open);
          if (!open) {
            setFolderToMove(null);
          }
        }}>
          <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Move Folder</DialogTitle>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <p className="text-sm text-slate-600">
                Select a destination for <strong>{folderToMove?.name}</strong>:
              </p>

              <div className="space-y-2">
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => handleMoveFolderToDestination('root')}
                >
                  <FolderOpen className="w-4 h-4 mr-2" />
                  Root (Top Level)
                </Button>

                {renderFolderSelector(folderHierarchy, folderToMove?.id)}
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => {
                setShowMoveFolderDialog(false);
                setFolderToMove(null);
              }}>
                Cancel
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Edit Dialog */}
        <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Edit File Information</DialogTitle>
            </DialogHeader>

            {editingFile && (
              <div className="space-y-4">
                <div className="p-3 bg-slate-50 rounded-lg">
                  <p className="text-sm font-medium text-slate-900">{editingFile.file_name}</p>
                  <p className="text-xs text-slate-500">{formatFileSize(editingFile.file_size)}</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="file-description">Description</Label>
                  <Textarea
                    id="file-description"
                    value={editingFile.description || ''}
                    onChange={(e) => setEditingFile({ ...editingFile, description: e.target.value })}
                    placeholder="Add a description..."
                    rows={3}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Tags</Label>
                  <div className="flex gap-2">
                    <Input
                      placeholder="Add tag"
                      value={newTag}
                      onChange={(e) => setNewTag(e.target.value)}
                      onKeyPress={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddTag())}
                    />
                    <Button onClick={handleAddTag} size="sm">
                      <Upload className="w-4 h-4" />
                    </Button>
                  </div>
                  {editingFile.tags && editingFile.tags.length > 0 && (
                    <div className="flex flex-wrap gap-2 p-3 bg-slate-50 rounded-lg">
                      {editingFile.tags.map((tag, idx) => (
                        <Badge key={idx} className="bg-slate-200 text-slate-700 pr-1">
                          {tag}
                          <button
                            onClick={() => handleRemoveTag(tag)}
                            className="ml-2 hover:bg-slate-300 rounded-full p-0.5"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setShowEditDialog(false);
                  setEditingFile(null);
                  setNewTag("");
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={handleSaveEdit}
                disabled={updateMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
              >
                Save Changes
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
