import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { toast } from "sonner";
import { 
  ChevronUp, 
  ChevronDown, 
  Upload, 
  Loader2, 
  Image as ImageIcon, 
  Trash2, 
  FolderOpen, 
  Folder, 
  Home, 
  ChevronRight, 
  ChevronLeft,
  Search,
  X,
  FileText
} from "lucide-react";

export default function IEditImageElement({ content, variant, settings }) {
  const variants = {
    default: "rounded-lg",
    rounded: "rounded-2xl",
    circle: "rounded-full",
    none: "",
  };

  const borderClass = variants[variant] || variants.default;

  if (!content.imageUrl) {
    return (
      <div className="bg-slate-100 aspect-video rounded-lg flex items-center justify-center">
        <p className="text-slate-400">No image selected</p>
      </div>
    );
  }

  return (
    <div className="w-full">
      <img
        src={content.imageUrl}
        alt={content.altText || ""}
        className={`w-full h-auto object-cover ${borderClass}`}
      />
      {content.caption && (
        <p className="text-sm text-slate-600 mt-2 text-center italic">
          {content.caption}
        </p>
      )}
    </div>
  );
}

export function IEditImageElementEditor({ element, onChange }) {
  const content = element.content || {};
  
  const [expandedSections, setExpandedSections] = useState({
    image: true,
    details: false
  });
  const [isUploading, setIsUploading] = useState(false);
  const [showFileSelector, setShowFileSelector] = useState(false);
  const [fileSelectorFolder, setFileSelectorFolder] = useState(null);
  const [fileSelectorExpandedFolders, setFileSelectorExpandedFolders] = useState({});
  const [fileSelectorPage, setFileSelectorPage] = useState(1);
  const [fileSelectorItemsPerPage] = useState(12);
  const [fileSelectorSearch, setFileSelectorSearch] = useState("");

  const toggleSection = (section) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const updateContent = (key, value) => {
    onChange({ ...element, content: { ...content, [key]: value } });
  };

  const { data: repositoryFiles = [] } = useQuery({
    queryKey: ['file-repository'],
    queryFn: () => base44.entities.FileRepository.list(),
    staleTime: 0,
  });

  const { data: fileRepositoryFolders = [] } = useQuery({
    queryKey: ['file-repository-folders'],
    queryFn: () => base44.entities.FileRepositoryFolder.list('display_order'),
    staleTime: 0,
  });

  const fileSelectorFolderHierarchy = useMemo(() => {
    const buildTree = (parentId) => {
      return fileRepositoryFolders
        .filter(f => f.parent_folder_id === parentId)
        .sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
        .map(folder => ({
          ...folder,
          children: buildTree(folder.id)
        }));
    };
    return buildTree(null);
  }, [fileRepositoryFolders]);

  const getFileSelectorBreadcrumb = (folderId) => {
    if (!folderId) return [];
    const trail = [];
    let currentId = folderId;

    while (currentId) {
      const folder = fileRepositoryFolders.find(f => f.id === currentId);
      if (folder) {
        trail.unshift(folder);
        currentId = folder.parent_folder_id;
      } else {
        break;
      }
    }
    return trail;
  };

  const fileSelectorBreadcrumb = useMemo(() => getFileSelectorBreadcrumb(fileSelectorFolder), [fileSelectorFolder, fileRepositoryFolders]);

  const filteredRepositoryFiles = useMemo(() => {
    return repositoryFiles.filter(file => {
      const matchesFolder = fileSelectorFolder === null
        ? !file.folder_id
        : file.folder_id === fileSelectorFolder;
      
      const matchesSearch = !fileSelectorSearch || 
        file.file_name?.toLowerCase().includes(fileSelectorSearch.toLowerCase()) ||
        file.description?.toLowerCase().includes(fileSelectorSearch.toLowerCase());
      
      return matchesFolder && matchesSearch && file.file_type === 'image';
    });
  }, [repositoryFiles, fileSelectorFolder, fileSelectorSearch]);

  useEffect(() => {
    setFileSelectorPage(1);
  }, [fileSelectorFolder, fileSelectorSearch]);

  const fileSelectorTotalPages = Math.ceil(filteredRepositoryFiles.length / fileSelectorItemsPerPage);
  const fileSelectorStartIndex = (fileSelectorPage - 1) * fileSelectorItemsPerPage;
  const fileSelectorEndIndex = fileSelectorStartIndex + fileSelectorItemsPerPage;
  const paginatedRepositoryFiles = filteredRepositoryFiles.slice(fileSelectorStartIndex, fileSelectorEndIndex);

  const getFileSelectorPageNumbers = () => {
    const pages = [];
    const maxVisible = 5;
    
    if (fileSelectorTotalPages <= maxVisible) {
      for (let i = 1; i <= fileSelectorTotalPages; i++) {
        pages.push(i);
      }
    } else {
      if (fileSelectorPage <= 3) {
        for (let i = 1; i <= 4; i++) pages.push(i);
        if (fileSelectorTotalPages > 5) pages.push('...');
        pages.push(fileSelectorTotalPages);
      } else if (fileSelectorPage >= fileSelectorTotalPages - 2) {
        pages.push(1);
        if (fileSelectorTotalPages > 5) pages.push('...');
        for (let i = fileSelectorTotalPages - 3; i <= fileSelectorTotalPages; i++) pages.push(i);
      } else {
        pages.push(1);
        pages.push('...');
        for (let i = fileSelectorPage - 1; i <= fileSelectorPage + 1; i++) pages.push(i);
        pages.push('...');
        pages.push(fileSelectorTotalPages);
      }
    }
    
    return pages;
  };

  const getFileSelectorFolderFileCount = (folderId) => {
    const relevantFiles = repositoryFiles.filter(f => f.file_type === 'image');
    return relevantFiles.filter(f => f.folder_id === folderId).length;
  };

  const handleToggleFileSelectorFolder = (folderId) => {
    setFileSelectorExpandedFolders(prev => ({
      ...prev,
      [folderId]: !prev[folderId]
    }));
  };

  const handleSelectFile = (fileUrl) => {
    updateContent('imageUrl', fileUrl);
    setShowFileSelector(false);
    setFileSelectorFolder(null);
    setFileSelectorExpandedFolders({});
    setFileSelectorSearch("");
    setFileSelectorPage(1);
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
    if (!allowedTypes.includes(file.type)) {
      toast.error('Please upload a valid image file (JPEG, PNG, GIF, WebP, or SVG)');
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      toast.error('Image must be smaller than 10MB');
      return;
    }

    setIsUploading(true);

    try {
      const response = await base44.integrations.Core.UploadFile({ file });
      updateContent('imageUrl', response.file_url);
      toast.success('Image uploaded successfully');
    } catch (error) {
      toast.error('Failed to upload image: ' + error.message);
    } finally {
      setIsUploading(false);
    }
  };

  const handleRemoveImage = () => {
    updateContent('imageUrl', '');
  };

  const renderFileSelectorFolderTree = (folderList, depth = 0) => {
    return folderList.map(folder => {
      const isExpanded = fileSelectorExpandedFolders[folder.id];
      const hasChildren = folder.children && folder.children.length > 0;
      const isSelected = fileSelectorFolder === folder.id;

      return (
        <div key={folder.id}>
          <div
            className={`flex items-center gap-2 py-2 px-3 rounded cursor-pointer transition-all ${
              isSelected ? 'bg-blue-100' : 'hover:bg-slate-100'
            }`}
            style={{ paddingLeft: `${depth * 20 + 12}px` }}
          >
            {hasChildren ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleToggleFileSelectorFolder(folder.id);
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
              onClick={() => setFileSelectorFolder(folder.id)}
              className="flex-1 text-sm"
            >
              {folder.name}
            </span>

            <span className="text-xs text-slate-500">
              ({getFileSelectorFolderFileCount(folder.id)})
            </span>
          </div>

          {hasChildren && isExpanded && (
            <div>
              {renderFileSelectorFolderTree(folder.children, depth + 1)}
            </div>
          )}
        </div>
      );
    });
  };

  return (
    <div className="space-y-4">
      {/* Image Selection Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('image')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
          data-testid="accordion-image-selection"
        >
          <span className="font-semibold text-sm">Image Selection</span>
          {expandedSections.image ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.image && (
          <div className="p-4 space-y-4">
            {content.imageUrl ? (
              <div className="space-y-3">
                <div className="relative">
                  <img
                    src={content.imageUrl}
                    alt={content.altText || "Selected image"}
                    className="w-full h-40 object-cover rounded-lg border border-slate-200"
                  />
                  <button
                    onClick={handleRemoveImage}
                    className="absolute top-2 right-2 p-1.5 bg-red-500 text-white rounded-full hover:bg-red-600 transition-colors"
                    title="Remove image"
                    data-testid="button-remove-image"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setShowFileSelector(true)}
                    className="flex-1"
                    data-testid="button-replace-from-repository"
                  >
                    <ImageIcon className="w-4 h-4 mr-2" />
                    Replace from Repository
                  </Button>
                  
                  <Label htmlFor="image-upload-replace" className="cursor-pointer flex-1">
                    <div className={`flex items-center justify-center gap-2 px-4 py-2 rounded-md border transition-colors h-10 ${
                      isUploading 
                        ? 'bg-slate-300 cursor-not-allowed' 
                        : 'border-slate-200 hover:bg-slate-50'
                    }`}>
                      {isUploading ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <>
                          <Upload className="w-4 h-4" />
                          <span className="text-sm">Upload New</span>
                        </>
                      )}
                    </div>
                  </Label>
                  <input
                    id="image-upload-replace"
                    type="file"
                    accept="image/*"
                    onChange={handleFileUpload}
                    className="hidden"
                    disabled={isUploading}
                    data-testid="input-image-upload-replace"
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="border-2 border-dashed border-slate-300 rounded-lg p-8 text-center">
                  <ImageIcon className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                  <p className="text-slate-600 mb-4">No image selected</p>
                  
                  <div className="flex gap-2 justify-center">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setShowFileSelector(true)}
                      data-testid="button-select-from-repository"
                    >
                      <ImageIcon className="w-4 h-4 mr-2" />
                      Select from Repository
                    </Button>
                    
                    <Label htmlFor="image-upload" className="cursor-pointer">
                      <div className={`flex items-center gap-2 px-4 py-2 rounded-md transition-colors ${
                        isUploading 
                          ? 'bg-slate-300 cursor-not-allowed' 
                          : 'bg-blue-600 hover:bg-blue-700 text-white'
                      }`}>
                        {isUploading ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <>
                            <Upload className="w-4 h-4" />
                            <span className="text-sm">Upload Image</span>
                          </>
                        )}
                      </div>
                    </Label>
                    <input
                      id="image-upload"
                      type="file"
                      accept="image/*"
                      onChange={handleFileUpload}
                      className="hidden"
                      disabled={isUploading}
                      data-testid="input-image-upload"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Details Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('details')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
          data-testid="accordion-image-details"
        >
          <span className="font-semibold text-sm">Alt Text & Caption</span>
          {expandedSections.details ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.details && (
          <div className="p-4 space-y-4">
            <div>
              <Label htmlFor="altText" className="text-sm font-medium mb-1 block">
                Alt Text
              </Label>
              <Input
                id="altText"
                value={content.altText || ''}
                onChange={(e) => updateContent('altText', e.target.value)}
                placeholder="Describe the image for accessibility..."
                data-testid="input-alt-text"
              />
              <p className="text-xs text-slate-500 mt-1">
                Describes the image for screen readers and SEO
              </p>
            </div>

            <div>
              <Label htmlFor="caption" className="text-sm font-medium mb-1 block">
                Caption
              </Label>
              <Input
                id="caption"
                value={content.caption || ''}
                onChange={(e) => updateContent('caption', e.target.value)}
                placeholder="Optional caption displayed below the image..."
                data-testid="input-caption"
              />
            </div>
          </div>
        )}
      </div>

      {/* File Selector Dialog */}
      <Dialog open={showFileSelector} onOpenChange={() => {
        setShowFileSelector(false);
        setFileSelectorFolder(null);
        setFileSelectorExpandedFolders({});
        setFileSelectorSearch("");
        setFileSelectorPage(1);
      }}>
        <DialogContent className="max-w-6xl max-h-[90vh] grid grid-rows-[auto_1fr_auto] gap-4">
          <DialogHeader>
            <DialogTitle>Select Image from Repository</DialogTitle>
            <div className="pt-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  placeholder="Search images by name or description..."
                  value={fileSelectorSearch}
                  onChange={(e) => setFileSelectorSearch(e.target.value)}
                  className="pl-10"
                  data-testid="input-file-selector-search"
                />
                {fileSelectorSearch && (
                  <button
                    onClick={() => setFileSelectorSearch("")}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          </DialogHeader>

          <div className="grid md:grid-cols-4 gap-4 py-4 overflow-hidden min-h-0">
            {/* Folder Navigation Sidebar */}
            <div className="md:col-span-1 border-r border-slate-200 pr-4 overflow-y-auto">
              <h3 className="text-sm font-semibold text-slate-700 mb-3">Folders</h3>
              
              {/* Breadcrumb */}
              <div className="mb-3 p-2 bg-slate-50 rounded-lg">
                <button
                  onClick={() => setFileSelectorFolder(null)}
                  className="flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900"
                >
                  <Home className="w-3 h-3" />
                  Root
                </button>
                {fileSelectorBreadcrumb.map((folder, idx) => (
                  <span key={folder.id}>
                    <ChevronRight className="w-3 h-3 text-slate-400 inline-block mx-1" />
                    <button
                      onClick={() => setFileSelectorFolder(folder.id)}
                      className={`text-xs ${
                        idx === fileSelectorBreadcrumb.length - 1
                          ? 'text-blue-600 font-medium'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {folder.name}
                    </button>
                  </span>
                ))}
              </div>

              {/* Folder Tree */}
              <div className="border border-slate-200 rounded-lg p-2 max-h-96 overflow-y-auto">
                <div
                  className={`flex items-center gap-2 py-2 px-3 rounded cursor-pointer transition-all ${
                    fileSelectorFolder === null ? 'bg-blue-100' : 'hover:bg-slate-100'
                  }`}
                  onClick={() => setFileSelectorFolder(null)}
                >
                  <FolderOpen className="w-4 h-4 text-slate-600" />
                  <span className="flex-1 text-sm font-medium">Root</span>
                  <span className="text-xs text-slate-500">
                    ({repositoryFiles.filter(f => !f.folder_id && f.file_type === 'image').length})
                  </span>
                </div>
                {renderFileSelectorFolderTree(fileSelectorFolderHierarchy)}
              </div>
            </div>

            {/* Files Grid */}
            <div className="md:col-span-3 flex flex-col min-h-0">
              {/* File count and info */}
              <div className="flex items-center justify-between mb-3 text-sm text-slate-600">
                <span>
                  {filteredRepositoryFiles.length} image{filteredRepositoryFiles.length !== 1 ? 's' : ''} 
                  {fileSelectorSearch && ` matching "${fileSelectorSearch}"`}
                </span>
                {fileSelectorTotalPages > 1 && (
                  <span>
                    Page {fileSelectorPage} of {fileSelectorTotalPages}
                  </span>
                )}
              </div>

              <div className="flex-1 overflow-y-auto min-h-0">
                {filteredRepositoryFiles.length === 0 ? (
                  <div className="text-center py-12">
                    <FileText className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                    <p className="text-slate-600">
                      {fileSelectorSearch 
                        ? "No images match your search"
                        : "No images in this folder"}
                    </p>
                    <p className="text-sm text-slate-500 mt-2">
                      {fileSelectorSearch 
                        ? "Try a different search term or browse folders"
                        : fileSelectorFolder 
                          ? "Try selecting a different folder"
                          : "Upload images in the File Repository page"}
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                    {paginatedRepositoryFiles.map((file) => (
                      <button
                        key={file.id}
                        onClick={() => handleSelectFile(file.file_url)}
                        className="text-left border-2 border-slate-200 rounded-lg hover:border-blue-500 transition-colors p-2"
                        data-testid={`file-select-${file.id}`}
                      >
                        <img
                          src={file.file_url}
                          alt={file.file_name}
                          className="w-full h-32 object-cover rounded mb-2"
                        />
                        <p className="text-sm font-medium text-slate-900 truncate">
                          {file.file_name}
                        </p>
                        {file.description && (
                          <p className="text-xs text-slate-500 truncate mt-1">
                            {file.description}
                          </p>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Pagination Controls */}
              {fileSelectorTotalPages > 1 && (
                <div className="flex items-center justify-center gap-2 mt-4 pt-4 border-t border-slate-200">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setFileSelectorPage(p => Math.max(1, p - 1))}
                    disabled={fileSelectorPage === 1}
                    data-testid="button-file-selector-prev"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                  
                  {getFileSelectorPageNumbers().map((page, idx) => (
                    page === '...' ? (
                      <span key={`ellipsis-${idx}`} className="px-2 text-slate-400">...</span>
                    ) : (
                      <Button
                        key={page}
                        variant={fileSelectorPage === page ? "default" : "outline"}
                        size="sm"
                        onClick={() => setFileSelectorPage(page)}
                        className={fileSelectorPage === page ? "bg-blue-600 hover:bg-blue-700" : ""}
                        data-testid={`button-file-selector-page-${page}`}
                      >
                        {page}
                      </Button>
                    )
                  ))}
                  
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setFileSelectorPage(p => Math.min(fileSelectorTotalPages, p + 1))}
                    disabled={fileSelectorPage === fileSelectorTotalPages}
                    data-testid="button-file-selector-next"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setShowFileSelector(false);
              setFileSelectorFolder(null);
              setFileSelectorExpandedFolders({});
              setFileSelectorSearch("");
              setFileSelectorPage(1);
            }}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
