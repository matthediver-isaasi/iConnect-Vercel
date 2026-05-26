import { useState, useRef, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  Upload,
  Link as LinkIcon,
  X,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  Search,
  FolderOpen,
  Home,
  ChevronRight,
  ChevronLeft,
  FileText
} from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "sonner";
import { showUploadErrorToast } from "@/lib/planQuotaError";

const FILES_PER_PAGE = 12;

export default function ImageSelector({
  value,
  onChange,
  label = "Image",
  helpText = "",
  className = ""
}) {
  const [isUploading, setIsUploading] = useState(false);
  const [activeTab, setActiveTab] = useState(value ? "preview" : "upload");
  const [urlInput, setUrlInput] = useState("");
  const [showFileBrowser, setShowFileBrowser] = useState(false);
  const [browserFolder, setBrowserFolder] = useState(null);
  const [browserSearch, setBrowserSearch] = useState("");
  const [browserPage, setBrowserPage] = useState(1);
  const [expandedFolders, setExpandedFolders] = useState({});
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (value && activeTab !== "preview") {
      setActiveTab("preview");
    }
  }, [value]);

  const handleFileSelect = async (e) => {
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
      const result = await base44.integrations.Core.UploadFile({ file });
      onChange(result.file_url);
      setActiveTab("preview");
      toast.success('Image uploaded successfully');
    } catch (error) {
      console.error('Upload error:', error);
      showUploadErrorToast(error, 'Failed to upload image');
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleUrlSubmit = () => {
    if (!urlInput.trim()) {
      toast.error('Please enter an image URL');
      return;
    }
    try {
      new URL(urlInput);
      onChange(urlInput.trim());
      setActiveTab("preview");
      setUrlInput("");
      toast.success('Image URL set successfully');
    } catch {
      toast.error('Please enter a valid URL');
    }
  };

  const handleRemove = () => {
    onChange("");
    setActiveTab("upload");
    setUrlInput("");
  };

  const handleReplace = () => {
    setActiveTab("upload");
  };

  const handleSelectFromRepo = (fileUrl) => {
    onChange(fileUrl);
    setActiveTab("preview");
    setShowFileBrowser(false);
    setBrowserFolder(null);
    setBrowserSearch("");
    setBrowserPage(1);
    toast.success('Image selected');
  };

  const openFileBrowser = () => {
    setBrowserFolder(null);
    setBrowserSearch("");
    setBrowserPage(1);
    setExpandedFolders({});
    setShowFileBrowser(true);
  };

  return (
    <div className={`space-y-2 ${className}`}>
      {label && <Label>{label}</Label>}

      {value && activeTab === "preview" ? (
        <div className="space-y-3">
          <div className="relative rounded-md overflow-hidden border">
            <img
              src={value}
              alt="Preview"
              className="w-full h-48 object-cover"
              onError={(e) => {
                e.target.onerror = null;
                e.target.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect fill="%23f1f5f9" width="100" height="100"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="%2394a3b8" font-size="12">Image failed to load</text></svg>';
              }}
              data-testid="img-cover-preview"
            />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleReplace}
              data-testid="button-replace-image"
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Replace
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={openFileBrowser}
              data-testid="button-browse-repository"
            >
              <ImageIcon className="h-4 w-4 mr-2" />
              Browse Files
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleRemove}
              data-testid="button-remove-image"
            >
              <X className="h-4 w-4 mr-2" />
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="upload" className="flex items-center gap-1.5" data-testid="tab-upload">
              <Upload className="h-3.5 w-3.5" />
              Upload
            </TabsTrigger>
            <TabsTrigger value="repository" className="flex items-center gap-1.5" data-testid="tab-repository">
              <ImageIcon className="h-3.5 w-3.5" />
              Browse Files
            </TabsTrigger>
            <TabsTrigger value="url" className="flex items-center gap-1.5" data-testid="tab-url">
              <LinkIcon className="h-3.5 w-3.5" />
              URL
            </TabsTrigger>
          </TabsList>

          <TabsContent value="upload" className="mt-3">
            <div
              className="border-2 border-dashed rounded-md p-6 text-center cursor-pointer transition-colors hover:border-primary/50 hover:bg-muted/30"
              onClick={() => fileInputRef.current?.click()}
              data-testid="dropzone-upload"
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleFileSelect}
                className="hidden"
                data-testid="input-file-upload"
              />
              {isUploading ? (
                <div className="flex flex-col items-center gap-2">
                  <Loader2 className="h-8 w-8 animate-spin text-primary" />
                  <span className="text-sm text-muted-foreground">Uploading...</span>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2">
                  <div className="p-3 bg-muted rounded-full">
                    <ImageIcon className="h-6 w-6 text-muted-foreground" />
                  </div>
                  <p className="text-sm font-medium">Click to upload an image</p>
                  <p className="text-xs text-muted-foreground">PNG, JPG, GIF, WebP, SVG up to 10MB</p>
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="repository" className="mt-3">
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={openFileBrowser}
              data-testid="button-open-file-browser"
            >
              <ImageIcon className="h-4 w-4 mr-2" />
              Browse File Repository
            </Button>
          </TabsContent>

          <TabsContent value="url" className="mt-3">
            <div className="space-y-3">
              <Input
                type="url"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="https://example.com/image.jpg"
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleUrlSubmit())}
                data-testid="input-image-url"
              />
              <Button
                type="button"
                onClick={handleUrlSubmit}
                className="w-full"
                disabled={!urlInput.trim()}
                data-testid="button-set-url"
              >
                <LinkIcon className="h-4 w-4 mr-2" />
                Set Image URL
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      )}

      {helpText && <p className="text-xs text-muted-foreground">{helpText}</p>}

      <FileBrowserDialog
        open={showFileBrowser}
        onClose={() => {
          setShowFileBrowser(false);
          setBrowserFolder(null);
          setBrowserSearch("");
          setBrowserPage(1);
        }}
        onSelect={handleSelectFromRepo}
        folder={browserFolder}
        setFolder={setBrowserFolder}
        search={browserSearch}
        setSearch={setBrowserSearch}
        page={browserPage}
        setPage={setBrowserPage}
        expandedFolders={expandedFolders}
        setExpandedFolders={setExpandedFolders}
      />
    </div>
  );
}

function FileBrowserDialog({
  open,
  onClose,
  onSelect,
  folder,
  setFolder,
  search,
  setSearch,
  page,
  setPage,
  expandedFolders,
  setExpandedFolders
}) {
  const { data: repositoryFiles = [] } = useQuery({
    queryKey: ['file-repository'],
    queryFn: async () => await base44.entities.FileRepository.list() || [],
    staleTime: 0,
    enabled: open
  });

  const { data: folders = [] } = useQuery({
    queryKey: ['file-repository-folders'],
    queryFn: async () => await base44.entities.FileRepositoryFolder.list('display_order') || [],
    staleTime: 0,
    enabled: open
  });

  const folderHierarchy = useMemo(() => {
    const buildTree = (parentId) => {
      return folders
        .filter(f => f.parent_folder_id === parentId)
        .sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
        .map(f => ({ ...f, children: buildTree(f.id) }));
    };
    return buildTree(null);
  }, [folders]);

  const getBreadcrumb = (folderId) => {
    if (!folderId) return [];
    const trail = [];
    let currentId = folderId;
    while (currentId) {
      const f = folders.find(x => x.id === currentId);
      if (f) { trail.unshift(f); currentId = f.parent_folder_id; }
      else break;
    }
    return trail;
  };

  const breadcrumb = useMemo(() => getBreadcrumb(folder), [folder, folders]);

  const filteredFiles = useMemo(() => {
    return repositoryFiles.filter(file => {
      const matchesFolder = folder === null ? !file.folder_id : file.folder_id === folder;
      const matchesSearch = !search ||
        file.file_name?.toLowerCase().includes(search.toLowerCase()) ||
        file.description?.toLowerCase().includes(search.toLowerCase());
      return matchesFolder && matchesSearch && file.file_type === 'image';
    });
  }, [repositoryFiles, folder, search]);

  useEffect(() => { setPage(1); }, [folder, search]);

  const totalPages = Math.ceil(filteredFiles.length / FILES_PER_PAGE);
  const paginatedFiles = filteredFiles.slice((page - 1) * FILES_PER_PAGE, page * FILES_PER_PAGE);

  const getFolderFileCount = (folderId) => {
    return repositoryFiles.filter(f => f.file_type === 'image' && f.folder_id === folderId).length;
  };

  const renderFolderTree = (nodes, depth = 0) => {
    return nodes.map(node => (
      <div key={node.id}>
        <div
          className={`flex items-center gap-2 py-1.5 px-2 rounded cursor-pointer transition-colors text-sm ${
            folder === node.id ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-muted'
          }`}
          style={{ paddingLeft: `${(depth * 12) + 8}px` }}
          onClick={() => setFolder(node.id)}
          data-testid={`folder-${node.id}`}
        >
          {node.children?.length > 0 ? (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setExpandedFolders(prev => ({ ...prev, [node.id]: !prev[node.id] })); }}
              className="p-0.5"
            >
              <ChevronRight className={`w-3 h-3 transition-transform ${expandedFolders[node.id] ? 'rotate-90' : ''}`} />
            </button>
          ) : <span className="w-4" />}
          <FolderOpen className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
          <span className="truncate flex-1">{node.name}</span>
          <span className="text-xs text-muted-foreground">{getFolderFileCount(node.id)}</span>
        </div>
        {expandedFolders[node.id] && node.children?.length > 0 && renderFolderTree(node.children, depth + 1)}
      </div>
    ));
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-4xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Select Image from File Repository</DialogTitle>
          <div className="pt-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search images..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
                data-testid="input-file-browser-search"
              />
            </div>
          </div>
        </DialogHeader>

        <div className="grid md:grid-cols-4 gap-4 flex-1 overflow-hidden min-h-0">
          <div className="md:col-span-1 border-r pr-3 overflow-y-auto">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Folders</h3>

            <div className="mb-2 flex items-center gap-1 text-xs text-muted-foreground flex-wrap">
              <button type="button" onClick={() => setFolder(null)} className="hover:text-foreground flex items-center gap-0.5">
                <Home className="w-3 h-3" /> Root
              </button>
              {breadcrumb.map((f, idx) => (
                <span key={f.id} className="flex items-center gap-0.5">
                  <ChevronRight className="w-3 h-3" />
                  <button
                    type="button"
                    onClick={() => setFolder(f.id)}
                    className={idx === breadcrumb.length - 1 ? 'text-primary font-medium' : 'hover:text-foreground'}
                  >
                    {f.name}
                  </button>
                </span>
              ))}
            </div>

            <div className="border rounded-md p-1.5 max-h-72 overflow-y-auto">
              <div
                className={`flex items-center gap-2 py-1.5 px-2 rounded cursor-pointer transition-colors text-sm ${
                  folder === null ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-muted'
                }`}
                onClick={() => setFolder(null)}
              >
                <FolderOpen className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="flex-1">Root</span>
                <span className="text-xs text-muted-foreground">
                  {repositoryFiles.filter(f => !f.folder_id && f.file_type === 'image').length}
                </span>
              </div>
              {renderFolderTree(folderHierarchy)}
            </div>
          </div>

          <div className="md:col-span-3 flex flex-col min-h-0">
            <div className="flex items-center justify-between mb-2 text-sm text-muted-foreground">
              <span>
                {filteredFiles.length} image{filteredFiles.length !== 1 ? 's' : ''}
                {search && ` matching "${search}"`}
              </span>
              {totalPages > 1 && <span>Page {page} of {totalPages}</span>}
            </div>

            <div className="flex-1 overflow-y-auto min-h-0">
              {filteredFiles.length === 0 ? (
                <div className="text-center py-12">
                  <FileText className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
                  <p className="text-muted-foreground">
                    {search ? "No images match your search" : "No images in this folder"}
                  </p>
                  <p className="text-sm text-muted-foreground/70 mt-1">
                    {search ? "Try a different search term" : "Upload images in the File Repository page"}
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  {paginatedFiles.map((file) => (
                    <button
                      key={file.id}
                      type="button"
                      onClick={() => onSelect(file.file_url)}
                      className="text-left border-2 rounded-md p-2 transition-colors hover:border-primary"
                      data-testid={`file-select-${file.id}`}
                    >
                      <img
                        src={file.file_url}
                        alt={file.file_name}
                        className="w-full h-28 object-cover rounded mb-1.5"
                      />
                      <p className="text-sm font-medium truncate">{file.file_name}</p>
                      {file.description && (
                        <p className="text-xs text-muted-foreground truncate mt-0.5">{file.description}</p>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 mt-3 pt-3 border-t">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  data-testid="button-file-prev"
                >
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <span className="text-sm text-muted-foreground">
                  {page} / {totalPages}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  data-testid="button-file-next"
                >
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} data-testid="button-file-browser-cancel">
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
