import { useState, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { 
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
} from 'lucide-react';
import { BLOCK_TYPES } from './types';

const GOOGLE_FONT_OPTIONS = [
  { value: '', label: 'Default (inherit)' },
  { value: "'Roboto', sans-serif", label: 'Roboto' },
  { value: "'Open Sans', sans-serif", label: 'Open Sans' },
  { value: "'Lato', sans-serif", label: 'Lato' },
  { value: "'Montserrat', sans-serif", label: 'Montserrat' },
  { value: "'Poppins', sans-serif", label: 'Poppins' },
  { value: "'Raleway', sans-serif", label: 'Raleway' },
  { value: "'Oswald', sans-serif", label: 'Oswald' },
  { value: "'Playfair Display', serif", label: 'Playfair Display' },
  { value: "'Merriweather', serif", label: 'Merriweather' },
  { value: "'Source Sans Pro', sans-serif", label: 'Source Sans Pro' },
  { value: "Arial, sans-serif", label: 'Arial' },
  { value: "Georgia, serif", label: 'Georgia' },
  { value: "'Times New Roman', serif", label: 'Times New Roman' },
  { value: "Verdana, sans-serif", label: 'Verdana' },
];

function TextBlockEditor({ block, onChange }) {
  const update = (key, value) => {
    if (key === 'content') {
      onChange({ ...block, content: value });
    } else {
      onChange({ ...block, styles: { ...block.styles, [key]: value } });
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Content</Label>
        <Textarea
          value={block.content}
          onChange={(e) => update('content', e.target.value)}
          rows={4}
          placeholder="Enter text content..."
          data-testid="editor-text-content"
        />
        <p className="text-xs text-muted-foreground">
          Supports: {'{{first_name}}'}, {'{{last_name}}'}, {'{{email}}'}
        </p>
      </div>
      <div className="space-y-2">
        <Label>Font Family</Label>
        <Select 
          value={block.styles.fontFamily || '__default__'} 
          onValueChange={(v) => update('fontFamily', v === '__default__' ? '' : v)}
        >
          <SelectTrigger data-testid="editor-font-family">
            <SelectValue placeholder="Select font..." />
          </SelectTrigger>
          <SelectContent>
            {GOOGLE_FONT_OPTIONS.map(font => (
              <SelectItem 
                key={font.value || '__default__'} 
                value={font.value || '__default__'}
                style={{ fontFamily: font.value || 'inherit' }}
              >
                {font.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Google Fonts work in Gmail, Apple Mail, iOS. Outlook uses fallback.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label>Font Size</Label>
          <Select value={block.styles.fontSize} onValueChange={(v) => update('fontSize', v)}>
            <SelectTrigger data-testid="editor-font-size">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="12px">Small (12px)</SelectItem>
              <SelectItem value="14px">Normal (14px)</SelectItem>
              <SelectItem value="16px">Medium (16px)</SelectItem>
              <SelectItem value="18px">Large (18px)</SelectItem>
              <SelectItem value="24px">XL (24px)</SelectItem>
              <SelectItem value="32px">XXL (32px)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Font Weight</Label>
          <Select value={block.styles.fontWeight} onValueChange={(v) => update('fontWeight', v)}>
            <SelectTrigger data-testid="editor-font-weight">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="normal">Normal</SelectItem>
              <SelectItem value="bold">Bold</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Text Align</Label>
          <Select value={block.styles.textAlign} onValueChange={(v) => update('textAlign', v)}>
            <SelectTrigger data-testid="editor-text-align">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="left">Left</SelectItem>
              <SelectItem value="center">Center</SelectItem>
              <SelectItem value="right">Right</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Text Color</Label>
          <Input
            type="color"
            value={block.styles.color}
            onChange={(e) => update('color', e.target.value)}
            className="h-9 p-1"
            data-testid="editor-text-color"
          />
        </div>
      </div>
    </div>
  );
}

function ImageBlockEditor({ block, onChange }) {
  const [isUploading, setIsUploading] = useState(false);
  const [showFileSelector, setShowFileSelector] = useState(false);
  const [fileSelectorFolder, setFileSelectorFolder] = useState(null);
  const [fileSelectorExpandedFolders, setFileSelectorExpandedFolders] = useState({});
  const [fileSelectorPage, setFileSelectorPage] = useState(1);
  const [fileSelectorItemsPerPage] = useState(12);
  const [fileSelectorSearch, setFileSelectorSearch] = useState("");

  const update = (key, value) => {
    if (key === 'src' || key === 'alt' || key === 'href') {
      onChange({ ...block, [key]: value });
    } else {
      onChange({ ...block, styles: { ...block.styles, [key]: value } });
    }
  };

  const { data: repositoryFiles = [] } = useQuery({
    queryKey: ['file-repository'],
    queryFn: async () => await base44.entities.FileRepository.list() || [],
    staleTime: 0,
  });

  const { data: fileRepositoryFolders = [] } = useQuery({
    queryKey: ['file-repository-folders'],
    queryFn: async () => await base44.entities.FileRepositoryFolder.list('display_order') || [],
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
    update('src', fileUrl);
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
      update('src', response.file_url);
      toast.success('Image uploaded successfully');
    } catch (error) {
      toast.error('Failed to upload image: ' + error.message);
    } finally {
      setIsUploading(false);
    }
  };

  const handleRemoveImage = () => {
    update('src', '');
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
              isSelected ? 'bg-primary/10' : 'hover:bg-muted'
            }`}
            style={{ paddingLeft: `${depth * 20 + 12}px` }}
          >
            {hasChildren ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleToggleFileSelectorFolder(folder.id);
                }}
                className="p-0.5 hover:bg-muted rounded"
              >
                <ChevronRight className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
              </button>
            ) : (
              <div className="w-5 h-5 flex-shrink-0" />
            )}

            <Folder className="w-4 h-4 text-muted-foreground shrink-0" />

            <span
              onClick={() => setFileSelectorFolder(folder.id)}
              className="flex-1 text-sm"
            >
              {folder.name}
            </span>

            <span className="text-xs text-muted-foreground">
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
      <div className="space-y-2">
        <Label>Image</Label>
        {block.src ? (
          <div className="space-y-3">
            <div className="relative">
              <img
                src={block.src}
                alt={block.alt || "Selected image"}
                className="w-full h-32 object-cover rounded-lg border"
              />
              <button
                onClick={handleRemoveImage}
                className="absolute top-2 right-2 p-1.5 bg-destructive text-destructive-foreground rounded-full transition-colors"
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
                size="sm"
                onClick={() => setShowFileSelector(true)}
                className="flex-1"
                data-testid="button-replace-from-repository"
              >
                <ImageIcon className="w-4 h-4 mr-2" />
                Replace
              </Button>
              
              <Label htmlFor="image-upload-replace" className="cursor-pointer flex-1">
                <div className={`flex items-center justify-center gap-2 px-3 py-2 rounded-md border transition-colors h-8 text-sm ${
                  isUploading 
                    ? 'bg-muted cursor-not-allowed' 
                    : 'border-input hover:bg-muted'
                }`}>
                  {isUploading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <>
                      <Upload className="w-4 h-4" />
                      <span>Upload</span>
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
            <div className="border-2 border-dashed rounded-lg p-6 text-center">
              <ImageIcon className="w-10 h-10 text-muted-foreground mx-auto mb-2" />
              <p className="text-muted-foreground text-sm mb-3">No image selected</p>
              
              <div className="flex gap-2 justify-center">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowFileSelector(true)}
                  data-testid="button-select-from-repository"
                >
                  <ImageIcon className="w-4 h-4 mr-2" />
                  Repository
                </Button>
                
                <Label htmlFor="image-upload" className="cursor-pointer">
                  <div className={`flex items-center gap-2 px-3 py-2 rounded-md transition-colors h-8 text-sm ${
                    isUploading 
                      ? 'bg-muted cursor-not-allowed' 
                      : 'bg-primary hover:bg-primary/90 text-primary-foreground'
                  }`}>
                    {isUploading ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <>
                        <Upload className="w-4 h-4" />
                        <span>Upload</span>
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

      <div className="space-y-2">
        <Label>Image URL</Label>
        <Input
          value={block.src}
          onChange={(e) => update('src', e.target.value)}
          placeholder="https://example.com/image.jpg"
          data-testid="editor-image-src"
        />
      </div>

      <div className="space-y-2">
        <Label>Alt Text</Label>
        <Input
          value={block.alt}
          onChange={(e) => update('alt', e.target.value)}
          placeholder="Image description"
          data-testid="editor-image-alt"
        />
      </div>
      <div className="space-y-2">
        <Label>Link URL (optional)</Label>
        <Input
          value={block.href || ''}
          onChange={(e) => update('href', e.target.value)}
          placeholder="https://example.com"
          data-testid="editor-image-href"
        />
      </div>
      <div className="space-y-2">
        <Label>Alignment</Label>
        <Select value={block.styles.textAlign} onValueChange={(v) => update('textAlign', v)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="left">Left</SelectItem>
            <SelectItem value="center">Center</SelectItem>
            <SelectItem value="right">Right</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Dialog open={showFileSelector} onOpenChange={() => {
        setShowFileSelector(false);
        setFileSelectorFolder(null);
        setFileSelectorExpandedFolders({});
        setFileSelectorSearch("");
        setFileSelectorPage(1);
      }}>
        <DialogContent className="max-w-5xl max-h-[80vh] grid grid-rows-[auto_1fr_auto] gap-4">
          <DialogHeader>
            <DialogTitle>Select Image from Repository</DialogTitle>
            <div className="pt-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Search images..."
                  value={fileSelectorSearch}
                  onChange={(e) => setFileSelectorSearch(e.target.value)}
                  className="pl-10"
                  data-testid="input-file-selector-search"
                />
                {fileSelectorSearch && (
                  <button
                    onClick={() => setFileSelectorSearch("")}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    data-testid="button-clear-search"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          </DialogHeader>

          <div className="grid md:grid-cols-4 gap-4 py-4 overflow-hidden min-h-0">
            <div className="md:col-span-1 border-r pr-4 overflow-y-auto">
              <h3 className="text-sm font-semibold mb-3">Folders</h3>
              
              <div className="mb-3 p-2 bg-muted rounded-lg">
                <button
                  onClick={() => setFileSelectorFolder(null)}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  data-testid="button-folder-root"
                >
                  <Home className="w-3 h-3" />
                  Root
                </button>
                {fileSelectorBreadcrumb.map((folder, idx) => (
                  <span key={folder.id}>
                    <ChevronRight className="w-3 h-3 text-muted-foreground inline-block mx-1" />
                    <button
                      onClick={() => setFileSelectorFolder(folder.id)}
                      className={`text-xs ${
                        idx === fileSelectorBreadcrumb.length - 1
                          ? 'text-primary font-medium'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                      data-testid={`button-breadcrumb-${folder.id}`}
                    >
                      {folder.name}
                    </button>
                  </span>
                ))}
              </div>

              <div className="border rounded-lg p-2 max-h-64 overflow-y-auto">
                <div
                  className={`flex items-center gap-2 py-2 px-3 rounded cursor-pointer transition-all ${
                    fileSelectorFolder === null ? 'bg-primary/10' : 'hover:bg-muted'
                  }`}
                  onClick={() => setFileSelectorFolder(null)}
                >
                  <FolderOpen className="w-4 h-4 text-muted-foreground" />
                  <span className="flex-1 text-sm font-medium">Root</span>
                  <span className="text-xs text-muted-foreground">
                    ({repositoryFiles.filter(f => !f.folder_id && f.file_type === 'image').length})
                  </span>
                </div>
                {renderFileSelectorFolderTree(fileSelectorFolderHierarchy)}
              </div>
            </div>

            <div className="md:col-span-3 flex flex-col min-h-0">
              <div className="flex items-center justify-between mb-3 text-sm text-muted-foreground">
                <span>
                  {filteredRepositoryFiles.length} image{filteredRepositoryFiles.length !== 1 ? 's' : ''} 
                  {fileSelectorSearch && ` matching "${fileSelectorSearch}"`}
                </span>
                {fileSelectorTotalPages > 1 && (
                  <span>Page {fileSelectorPage} of {fileSelectorTotalPages}</span>
                )}
              </div>

              <div className="flex-1 overflow-y-auto min-h-0">
                {filteredRepositoryFiles.length === 0 ? (
                  <div className="text-center py-12">
                    <FileText className="w-16 h-16 text-muted-foreground/50 mx-auto mb-4" />
                    <p className="text-muted-foreground">
                      {fileSelectorSearch 
                        ? "No images match your search"
                        : "No images in this folder"}
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {paginatedRepositoryFiles.map((file) => (
                      <button
                        key={file.id}
                        onClick={() => handleSelectFile(file.file_url)}
                        className="text-left border-2 rounded-lg hover:border-primary transition-colors p-2"
                        data-testid={`file-select-${file.id}`}
                      >
                        <img
                          src={file.file_url}
                          alt={file.file_name}
                          className="w-full h-24 object-cover rounded mb-2"
                        />
                        <p className="text-sm font-medium truncate">
                          {file.file_name}
                        </p>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {fileSelectorTotalPages > 1 && (
                <div className="flex items-center justify-center gap-2 mt-4 pt-4 border-t">
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
                      <span key={`ellipsis-${idx}`} className="px-2 text-muted-foreground">...</span>
                    ) : (
                      <Button
                        key={page}
                        variant={fileSelectorPage === page ? "default" : "outline"}
                        size="sm"
                        onClick={() => setFileSelectorPage(page)}
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

function ButtonBlockEditor({ block, onChange }) {
  const update = (key, value) => {
    if (key === 'content' || key === 'href') {
      onChange({ ...block, [key]: value });
    } else {
      onChange({ ...block, styles: { ...block.styles, [key]: value } });
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Button Text</Label>
        <Input
          value={block.content}
          onChange={(e) => update('content', e.target.value)}
          placeholder="Click Here"
          data-testid="editor-button-text"
        />
      </div>
      <div className="space-y-2">
        <Label>Link URL</Label>
        <Input
          value={block.href}
          onChange={(e) => update('href', e.target.value)}
          placeholder="https://example.com"
          data-testid="editor-button-href"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label>Background Color</Label>
          <Input
            type="color"
            value={block.styles.backgroundColor}
            onChange={(e) => update('backgroundColor', e.target.value)}
            className="h-9 p-1"
          />
        </div>
        <div className="space-y-2">
          <Label>Text Color</Label>
          <Input
            type="color"
            value={block.styles.color}
            onChange={(e) => update('color', e.target.value)}
            className="h-9 p-1"
          />
        </div>
        <div className="space-y-2">
          <Label>Font Size</Label>
          <Select value={block.styles.fontSize} onValueChange={(v) => update('fontSize', v)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="14px">Small</SelectItem>
              <SelectItem value="16px">Medium</SelectItem>
              <SelectItem value="18px">Large</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Border Radius</Label>
          <Select value={block.styles.borderRadius} onValueChange={(v) => update('borderRadius', v)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">None</SelectItem>
              <SelectItem value="4px">Small</SelectItem>
              <SelectItem value="8px">Medium</SelectItem>
              <SelectItem value="20px">Pill</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-2">
        <Label>Alignment</Label>
        <Select value={block.styles.textAlign} onValueChange={(v) => update('textAlign', v)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="left">Left</SelectItem>
            <SelectItem value="center">Center</SelectItem>
            <SelectItem value="right">Right</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

function DividerBlockEditor({ block, onChange }) {
  const update = (key, value) => {
    onChange({ ...block, styles: { ...block.styles, [key]: value } });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Border Color</Label>
        <Input
          type="color"
          value={block.styles.borderColor}
          onChange={(e) => update('borderColor', e.target.value)}
          className="h-9 p-1"
        />
      </div>
      <div className="space-y-2">
        <Label>Border Style</Label>
        <Select value={block.styles.borderStyle} onValueChange={(v) => update('borderStyle', v)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="solid">Solid</SelectItem>
            <SelectItem value="dashed">Dashed</SelectItem>
            <SelectItem value="dotted">Dotted</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label>Border Width</Label>
        <Select value={block.styles.borderWidth} onValueChange={(v) => update('borderWidth', v)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1px">Thin (1px)</SelectItem>
            <SelectItem value="2px">Medium (2px)</SelectItem>
            <SelectItem value="4px">Thick (4px)</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

function SpacerBlockEditor({ block, onChange }) {
  const update = (key, value) => {
    onChange({ ...block, styles: { ...block.styles, [key]: value } });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Height</Label>
        <Select value={block.styles.height} onValueChange={(v) => update('height', v)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="10px">Small (10px)</SelectItem>
            <SelectItem value="20px">Medium (20px)</SelectItem>
            <SelectItem value="40px">Large (40px)</SelectItem>
            <SelectItem value="60px">XL (60px)</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

function ColumnsBlockEditor({ block, onChange }) {
  const updateColumnCount = (count) => {
    const currentCols = block.columns || [];
    const newCols = [];
    const width = `${100 / count}%`;
    
    for (let i = 0; i < count; i++) {
      if (currentCols[i]) {
        newCols.push({ ...currentCols[i], width });
      } else {
        newCols.push({ id: `col-${Date.now()}-${i}`, blocks: [], width });
      }
    }
    
    onChange({ ...block, columns: newCols });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Number of Columns</Label>
        <Select 
          value={String(block.columns?.length || 2)} 
          onValueChange={(v) => updateColumnCount(parseInt(v))}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="2">2 Columns</SelectItem>
            <SelectItem value="3">3 Columns</SelectItem>
            <SelectItem value="4">4 Columns</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p className="text-xs text-muted-foreground">
        Column content editing coming soon. For now, columns provide layout structure.
      </p>
    </div>
  );
}

function SectionBlockEditor({ block, onChange }) {
  const update = (key, value) => {
    onChange({ ...block, styles: { ...block.styles, [key]: value } });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Background Color</Label>
        <Input
          type="color"
          value={block.styles.backgroundColor || '#ffffff'}
          onChange={(e) => update('backgroundColor', e.target.value)}
          className="h-9 p-1"
          data-testid="editor-section-bg-color"
        />
      </div>
      <div className="space-y-2">
        <Label>Padding</Label>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">Top</span>
            <Select value={block.styles.paddingTop || '20px'} onValueChange={(v) => update('paddingTop', v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">0</SelectItem>
                <SelectItem value="10px">10px</SelectItem>
                <SelectItem value="20px">20px</SelectItem>
                <SelectItem value="30px">30px</SelectItem>
                <SelectItem value="40px">40px</SelectItem>
                <SelectItem value="60px">60px</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">Bottom</span>
            <Select value={block.styles.paddingBottom || '20px'} onValueChange={(v) => update('paddingBottom', v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">0</SelectItem>
                <SelectItem value="10px">10px</SelectItem>
                <SelectItem value="20px">20px</SelectItem>
                <SelectItem value="30px">30px</SelectItem>
                <SelectItem value="40px">40px</SelectItem>
                <SelectItem value="60px">60px</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">Left</span>
            <Select value={block.styles.paddingLeft || '20px'} onValueChange={(v) => update('paddingLeft', v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">0</SelectItem>
                <SelectItem value="10px">10px</SelectItem>
                <SelectItem value="20px">20px</SelectItem>
                <SelectItem value="30px">30px</SelectItem>
                <SelectItem value="40px">40px</SelectItem>
                <SelectItem value="60px">60px</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">Right</span>
            <Select value={block.styles.paddingRight || '20px'} onValueChange={(v) => update('paddingRight', v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">0</SelectItem>
                <SelectItem value="10px">10px</SelectItem>
                <SelectItem value="20px">20px</SelectItem>
                <SelectItem value="30px">30px</SelectItem>
                <SelectItem value="40px">40px</SelectItem>
                <SelectItem value="60px">60px</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Drag content blocks into this section to build your email layout.
      </p>
    </div>
  );
}

const blockEditors = {
  [BLOCK_TYPES.SECTION]: SectionBlockEditor,
  [BLOCK_TYPES.TEXT]: TextBlockEditor,
  [BLOCK_TYPES.IMAGE]: ImageBlockEditor,
  [BLOCK_TYPES.BUTTON]: ButtonBlockEditor,
  [BLOCK_TYPES.DIVIDER]: DividerBlockEditor,
  [BLOCK_TYPES.SPACER]: SpacerBlockEditor,
  [BLOCK_TYPES.COLUMNS]: ColumnsBlockEditor,
};

export default function BlockEditor({ block, onChange }) {
  if (!block) {
    return (
      <div className="p-4 text-center text-muted-foreground">
        <p>Select a block to edit its properties</p>
      </div>
    );
  }

  const EditorComponent = blockEditors[block.type];
  const blockTypeLabel = block.type.charAt(0).toUpperCase() + block.type.slice(1);

  return (
    <div className="p-4">
      <h3 className="text-sm font-medium mb-4">{blockTypeLabel} Settings</h3>
      {EditorComponent && <EditorComponent block={block} onChange={onChange} />}
    </div>
  );
}
