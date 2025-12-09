import React, { useState, useId, useMemo, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useIsMobile } from "@/hooks/use-mobile";
import { base44 } from "@/api/base44Client";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import ReactQuill from "react-quill";
import "react-quill/dist/quill.snow.css";
import DOMPurify from "dompurify";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { 
  ChevronDown, 
  ChevronUp, 
  ChevronLeft,
  ChevronRight,
  Plus, 
  Trash2, 
  GripVertical,
  FileText,
  ExternalLink,
  Video,
  Download,
  Mail,
  Phone,
  Link as LinkIcon,
  Image,
  Music,
  Calendar,
  MapPin,
  BookOpen,
  FolderOpen,
  Folder,
  File,
  Home,
  Search,
  X
} from "lucide-react";
import TypographyStyleSelector, { applyTypographyStyle } from "../TypographyStyleSelector";

const LINK_ICON_TYPES = [
  { value: 'external', label: 'External Link', icon: ExternalLink },
  { value: 'document', label: 'Document', icon: FileText },
  { value: 'video', label: 'Video', icon: Video },
  { value: 'download', label: 'Download', icon: Download },
  { value: 'email', label: 'Email', icon: Mail },
  { value: 'phone', label: 'Phone', icon: Phone },
  { value: 'link', label: 'Generic Link', icon: LinkIcon },
  { value: 'image', label: 'Image', icon: Image },
  { value: 'audio', label: 'Audio', icon: Music },
  { value: 'calendar', label: 'Calendar/Event', icon: Calendar },
  { value: 'location', label: 'Location', icon: MapPin },
  { value: 'resource', label: 'Resource', icon: BookOpen }
];

const getLinkIcon = (iconType) => {
  const found = LINK_ICON_TYPES.find(t => t.value === iconType);
  return found ? found.icon : ExternalLink;
};

const fontFamilies = [
  'Poppins',
  'Degular Medium', 
  'Degular Bold',
  'Degular Semibold',
  'Inter',
  'Arial',
  'Georgia',
  'Times New Roman'
];

const fontWeights = [
  { value: 300, label: 'Light' },
  { value: 400, label: 'Regular' },
  { value: 500, label: 'Medium' },
  { value: 600, label: 'Semibold' },
  { value: 700, label: 'Bold' },
  { value: 800, label: 'Extra Bold' }
];

// Quill editor modules configuration for accordion content
const accordionQuillModules = {
  toolbar: {
    container: [
      [{ 'header': [1, 2, 3, false] }],
      ['bold', 'italic', 'underline', 'strike'],
      [{ 'list': 'ordered'}, { 'list': 'bullet' }],
      [{ 'indent': '-1'}, { 'indent': '+1' }],
      ['blockquote'],
      ['link'],
      ['clean']
    ]
  }
};

// Quill editor modules configuration for section header text (matching Hero pattern)
const heroQuillModules = {
  toolbar: {
    container: [
      [{ 'header': [1, 2, 3, false] }],
      ['bold', 'italic', 'underline', 'strike'],
      [{ 'list': 'ordered'}, { 'list': 'bullet' }],
      [{ 'indent': '-1'}, { 'indent': '+1' }],
      ['blockquote'],
      ['link'],
      ['clean']
    ]
  }
};

export function IEditAccordionElementEditor({ element, onChange }) {
  const [isUploading, setIsUploading] = useState(false);
  const [expandedItem, setExpandedItem] = useState(null);
  
  // File selector dialog states
  const [showFilePicker, setShowFilePicker] = useState(null); // { itemIndex, linkIndex }
  const [fileSelectorFolder, setFileSelectorFolder] = useState(null);
  const [fileSelectorExpandedFolders, setFileSelectorExpandedFolders] = useState({});
  const [fileSelectorSearch, setFileSelectorSearch] = useState('');
  const [fileSelectorPage, setFileSelectorPage] = useState(1);
  const fileSelectorItemsPerPage = 12;

  const content = element.content || {};
  const backgroundType = content.background_type || 'none';
  const items = content.items || [];

  // Fetch files from repository
  const { data: repositoryFiles = [], isLoading: filesLoading } = useQuery({
    queryKey: ['file-repository-for-accordion'],
    queryFn: () => base44.entities.FileRepository.list(),
    staleTime: 60000
  });

  // Fetch folders for file repository
  const { data: fileRepositoryFolders = [] } = useQuery({
    queryKey: ['file-repository-folders-for-accordion'],
    queryFn: () => base44.entities.FileRepositoryFolder.list('display_order'),
    staleTime: 60000
  });

  // Build folder hierarchy for file selector
  const buildFolderHierarchy = (folders, parentId = null) => {
    return folders
      .filter(f => f.parent_folder_id === parentId)
      .sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
      .map(folder => ({
        ...folder,
        children: buildFolderHierarchy(folders, folder.id)
      }));
  };

  const fileSelectorFolderHierarchy = useMemo(() => 
    buildFolderHierarchy(fileRepositoryFolders), 
    [fileRepositoryFolders]
  );

  // Get breadcrumb for file selector
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

  const fileSelectorBreadcrumb = useMemo(() => 
    getFileSelectorBreadcrumb(fileSelectorFolder), 
    [fileSelectorFolder, fileRepositoryFolders]
  );

  // Filter files based on folder and search
  // When no folder selected (root view), show ALL files to make selection easier
  // When a folder is selected, show only files in that folder
  const filteredRepositoryFiles = useMemo(() => {
    return repositoryFiles.filter(file => {
      // When at root (null), show ALL files; when folder selected, filter by folder
      // Use string comparison to handle potential type mismatches (number vs string IDs)
      const matchesFolder = fileSelectorFolder === null 
        ? true  // Show all files when at root
        : String(file.folder_id) === String(fileSelectorFolder);
      
      const matchesSearch = !fileSelectorSearch || 
        file.file_name?.toLowerCase().includes(fileSelectorSearch.toLowerCase()) ||
        file.description?.toLowerCase().includes(fileSelectorSearch.toLowerCase());
      
      return matchesFolder && matchesSearch;
    });
  }, [repositoryFiles, fileSelectorFolder, fileSelectorSearch]);

  // Pagination calculations
  const fileSelectorTotalPages = Math.ceil(filteredRepositoryFiles.length / fileSelectorItemsPerPage);
  const fileSelectorStartIndex = (fileSelectorPage - 1) * fileSelectorItemsPerPage;
  const paginatedRepositoryFiles = filteredRepositoryFiles.slice(
    fileSelectorStartIndex, 
    fileSelectorStartIndex + fileSelectorItemsPerPage
  );

  // Get page numbers for pagination
  const getFileSelectorPageNumbers = () => {
    const pages = [];
    const maxVisible = 5;
    
    if (fileSelectorTotalPages <= maxVisible) {
      for (let i = 1; i <= fileSelectorTotalPages; i++) {
        pages.push(i);
      }
    } else {
      if (fileSelectorPage <= 3) {
        pages.push(1, 2, 3, 4, '...', fileSelectorTotalPages);
      } else if (fileSelectorPage >= fileSelectorTotalPages - 2) {
        pages.push(1, '...', fileSelectorTotalPages - 3, fileSelectorTotalPages - 2, fileSelectorTotalPages - 1, fileSelectorTotalPages);
      } else {
        pages.push(1, '...', fileSelectorPage - 1, fileSelectorPage, fileSelectorPage + 1, '...', fileSelectorTotalPages);
      }
    }
    return pages;
  };

  // Get file count per folder - use string comparison for ID matching
  const getFileSelectorFolderFileCount = (folderId) => {
    return repositoryFiles.filter(f => String(f.folder_id) === String(folderId)).length;
  };

  // Toggle folder expansion in file selector
  const handleToggleFileSelectorFolder = (folderId) => {
    setFileSelectorExpandedFolders(prev => ({
      ...prev,
      [folderId]: !prev[folderId]
    }));
  };

  // Reset file selector when folder or search changes
  const resetFileSelectorPage = () => {
    setFileSelectorPage(1);
  };

  const updateContent = (key, value) => {
    onChange({
      ...element,
      content: {
        ...(element.content || {}),
        [key]: value
      }
    });
  };

  const updateMultipleContent = (updates) => {
    onChange({
      ...element,
      content: {
        ...(element.content || {}),
        ...updates
      }
    });
  };

  // Helper to strip HTML tags and decode entities for preview display
  const stripHtmlTags = (html) => {
    if (!html) return '';
    // Use DOMParser to properly strip HTML and decode entities
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return doc.body.textContent || '';
  };

  const handleImageUpload = async (file) => {
    if (!file) return;

    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      alert('Please upload a valid image file');
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      alert('Image must be smaller than 10MB');
      return;
    }

    setIsUploading(true);
    try {
      const response = await base44.integrations.Core.UploadFile({ file });
      updateContent('background_image_url', response.file_url);
    } catch (error) {
      alert('Failed to upload image: ' + error.message);
    } finally {
      setIsUploading(false);
    }
  };

  const addItem = () => {
    const newItems = [...items, { 
      id: Date.now().toString(),
      title: 'New Section',
      content: 'Enter your content here...'
    }];
    updateContent('items', newItems);
    setExpandedItem(newItems.length - 1);
  };

  const updateItem = (index, field, value) => {
    const newItems = [...items];
    newItems[index] = { ...newItems[index], [field]: value };
    updateContent('items', newItems);
  };

  const removeItem = (index) => {
    const newItems = items.filter((_, i) => i !== index);
    updateContent('items', newItems);
    if (expandedItem === index) {
      setExpandedItem(null);
    }
  };

  const moveItem = (index, direction) => {
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= items.length) return;
    
    const newItems = [...items];
    [newItems[index], newItems[newIndex]] = [newItems[newIndex], newItems[index]];
    updateContent('items', newItems);
    setExpandedItem(newIndex);
  };

  const addLinkToItem = (itemIndex) => {
    const newItems = [...items];
    const links = newItems[itemIndex].links || [];
    newItems[itemIndex] = {
      ...newItems[itemIndex],
      links: [...links, {
        id: Date.now().toString(),
        icon_type: 'external',
        label: 'New Link',
        url: '',
        open_in_new_tab: true
      }]
    };
    updateContent('items', newItems);
  };

  const updateItemLink = (itemIndex, linkIndex, field, value) => {
    const newItems = [...items];
    const links = [...(newItems[itemIndex].links || [])];
    links[linkIndex] = { ...links[linkIndex], [field]: value };
    newItems[itemIndex] = { ...newItems[itemIndex], links };
    updateContent('items', newItems);
  };

  const removeItemLink = (itemIndex, linkIndex) => {
    const newItems = [...items];
    const links = (newItems[itemIndex].links || []).filter((_, i) => i !== linkIndex);
    newItems[itemIndex] = { ...newItems[itemIndex], links };
    updateContent('items', newItems);
  };

  const moveLinkInItem = (itemIndex, linkIndex, direction) => {
    const newLinkIndex = linkIndex + direction;
    const links = [...(items[itemIndex].links || [])];
    if (newLinkIndex < 0 || newLinkIndex >= links.length) return;
    
    [links[linkIndex], links[newLinkIndex]] = [links[newLinkIndex], links[linkIndex]];
    const newItems = [...items];
    newItems[itemIndex] = { ...newItems[itemIndex], links };
    updateContent('items', newItems);
  };

  const handleFileSelect = (file) => {
    if (!showFilePicker) return;
    
    const { itemIndex, linkIndex } = showFilePicker;
    const newItems = [...items];
    const links = [...(newItems[itemIndex].links || [])];
    
    // Update the link with file info
    links[linkIndex] = { 
      ...links[linkIndex], 
      url: file.file_url,
      file_id: file.id,
      file_name: file.file_name,
      // Auto-set icon based on file type
      icon_type: file.file_type === 'video' ? 'video' : 
                 file.file_type === 'image' ? 'image' : 
                 file.file_type === 'document' ? 'document' : 'download',
      // If no label set, use file name
      label: links[linkIndex].label === 'New Link' ? file.file_name : links[linkIndex].label
    };
    newItems[itemIndex] = { ...newItems[itemIndex], links };
    updateContent('items', newItems);
    
    // Close dialog and reset states
    setShowFilePicker(null);
    setFileSelectorFolder(null);
    setFileSelectorExpandedFolders({});
    setFileSelectorSearch('');
    setFileSelectorPage(1);
  };

  const clearFileSelection = (itemIndex, linkIndex) => {
    const newItems = [...items];
    const links = [...(newItems[itemIndex].links || [])];
    links[linkIndex] = { 
      ...links[linkIndex], 
      file_id: null,
      file_name: null
    };
    newItems[itemIndex] = { ...newItems[itemIndex], links };
    updateContent('items', newItems);
  };

  const closeFileSelectorDialog = () => {
    setShowFilePicker(null);
    setFileSelectorFolder(null);
    setFileSelectorExpandedFolders({});
    setFileSelectorSearch('');
    setFileSelectorPage(1);
  };

  const getFileTypeIcon = (fileType) => {
    switch (fileType) {
      case 'video': return Video;
      case 'image': return Image;
      case 'document': return FileText;
      default: return File;
    }
  };

  // Render folder tree for file selector
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
            style={{ paddingLeft: `${depth * 16 + 12}px` }}
          >
            {hasChildren ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleToggleFileSelectorFolder(folder.id);
                }}
                className="p-0.5 hover:bg-slate-200 rounded"
              >
                {isExpanded ? (
                  <ChevronDown className="w-3 h-3" />
                ) : (
                  <ChevronRight className="w-3 h-3" />
                )}
              </button>
            ) : (
              <span className="w-4" />
            )}
            <div
              className="flex items-center gap-2 flex-1"
              onClick={() => {
                setFileSelectorFolder(folder.id);
                resetFileSelectorPage();
              }}
            >
              {isSelected ? (
                <FolderOpen className="w-4 h-4 text-blue-600" />
              ) : (
                <Folder className="w-4 h-4 text-slate-600" />
              )}
              <span className={`flex-1 text-sm ${isSelected ? 'font-medium text-blue-700' : ''}`}>
                {folder.name}
              </span>
              <span className="text-xs text-slate-500">
                ({getFileSelectorFolderFileCount(folder.id)})
              </span>
            </div>
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

  const gradientPreview = `linear-gradient(${content.gradient_angle || 135}deg, ${content.gradient_start_color || '#3b82f6'}, ${content.gradient_end_color || '#8b5cf6'})`;

  return (
    <div className="space-y-4">
      {/* Section Header Settings */}
      <div className="border-b pb-4">
        <h4 className="font-semibold text-sm mb-3">Section Header</h4>
        
        <div className="space-y-4">
          {/* Header Title - Rich Text */}
          <div>
            <Label className="block text-sm font-medium mb-1">Header Title</Label>
            <div className="border border-slate-300 rounded-md overflow-hidden bg-white">
              <ReactQuill
                theme="snow"
                value={content.header_title || ''}
                onChange={(value) => updateContent('header_title', value)}
                modules={heroQuillModules}
                placeholder="e.g., Frequently Asked Questions"
                style={{ minHeight: '80px' }}
              />
            </div>
          </div>
          <TypographyStyleSelector
            value={content.header_typography_style_id || null}
            onChange={(styleId, style) => {
              const updates = { header_typography_style_id: styleId };
              if (style) {
                const mapped = applyTypographyStyle(style);
                if (mapped.font_family) updates.header_font_family = mapped.font_family;
                if (mapped.font_size) updates.header_font_size = mapped.font_size;
                if (mapped.font_size_mobile) updates.header_font_size_mobile = mapped.font_size_mobile;
                if (mapped.font_weight) updates.header_font_weight = mapped.font_weight;
                if (mapped.line_height) updates.header_line_height = mapped.line_height;
                if (mapped.letter_spacing !== undefined) updates.header_letter_spacing = mapped.letter_spacing;
                if (mapped.color) updates.header_color = mapped.color;
              }
              updateMultipleContent(updates);
            }}
            label="Header Typography Style"
          />
          <details className="text-xs">
            <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Header Font Settings</summary>
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Title Font Family</Label>
                  <select
                    value={content.header_font_family || 'Poppins'}
                    onChange={(e) => updateContent('header_font_family', e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                  >
                    {fontFamilies.map(font => (
                      <option key={font} value={font}>{font}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label>Title Font Weight</Label>
                  <select
                    value={content.header_font_weight || 700}
                    onChange={(e) => updateContent('header_font_weight', parseInt(e.target.value))}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                  >
                    {fontWeights.map(weight => (
                      <option key={weight.value} value={weight.value}>{weight.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Title Font Size (px)</Label>
                  <Input
                    type="number"
                    value={content.header_font_size || 32}
                    onChange={(e) => updateContent('header_font_size', parseInt(e.target.value) || 32)}
                    min="12"
                    max="96"
                  />
                </div>
                <div>
                  <Label>Title Color</Label>
                  <div className="flex gap-2 items-center">
                    <input
                      type="color"
                      value={content.header_color || '#1e293b'}
                      onChange={(e) => updateContent('header_color', e.target.value)}
                      className="w-12 h-9 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                    />
                    <Input
                      value={content.header_color || '#1e293b'}
                      onChange={(e) => updateContent('header_color', e.target.value)}
                      className="flex-1 font-mono text-xs"
                    />
                  </div>
                </div>
              </div>
            </div>
          </details>

          {/* Header Subtitle - Rich Text */}
          <div className="pt-4 border-t border-slate-100">
            <Label className="block text-sm font-medium mb-1">Header Subtitle</Label>
            <div className="border border-slate-300 rounded-md overflow-hidden bg-white">
              <ReactQuill
                theme="snow"
                value={content.header_subtitle || ''}
                onChange={(value) => updateContent('header_subtitle', value)}
                modules={heroQuillModules}
                placeholder="Optional subtitle text"
                style={{ minHeight: '80px' }}
              />
            </div>
          </div>
          <TypographyStyleSelector
            value={content.subtitle_typography_style_id || null}
            onChange={(styleId, style) => {
              const updates = { subtitle_typography_style_id: styleId };
              if (style) {
                const mapped = applyTypographyStyle(style);
                if (mapped.font_family) updates.subtitle_font_family = mapped.font_family;
                if (mapped.font_size) updates.subtitle_font_size = mapped.font_size;
                if (mapped.font_size_mobile) updates.subtitle_font_size_mobile = mapped.font_size_mobile;
                if (mapped.font_weight) updates.subtitle_font_weight = mapped.font_weight;
                if (mapped.line_height) updates.subtitle_line_height = mapped.line_height;
                if (mapped.letter_spacing !== undefined) updates.subtitle_letter_spacing = mapped.letter_spacing;
                if (mapped.color) updates.subtitle_color = mapped.color;
              }
              updateMultipleContent(updates);
            }}
            label="Subtitle Typography Style"
          />
          <details className="text-xs">
            <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Subtitle Font Settings</summary>
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Subtitle Font Family</Label>
                  <select
                    value={content.subtitle_font_family || 'Poppins'}
                    onChange={(e) => updateContent('subtitle_font_family', e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                  >
                    {fontFamilies.map(font => (
                      <option key={font} value={font}>{font}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label>Subtitle Font Weight</Label>
                  <select
                    value={content.subtitle_font_weight || 400}
                    onChange={(e) => updateContent('subtitle_font_weight', parseInt(e.target.value))}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                  >
                    {fontWeights.map(weight => (
                      <option key={weight.value} value={weight.value}>{weight.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Subtitle Font Size (px)</Label>
                  <Input
                    type="number"
                    value={content.subtitle_font_size || 18}
                    onChange={(e) => updateContent('subtitle_font_size', parseInt(e.target.value) || 18)}
                    min="12"
                    max="48"
                  />
                </div>
                <div>
                  <Label>Subtitle Color</Label>
                  <div className="flex gap-2 items-center">
                    <input
                      type="color"
                      value={content.subtitle_color || '#64748b'}
                      onChange={(e) => updateContent('subtitle_color', e.target.value)}
                      className="w-12 h-9 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                    />
                    <Input
                      value={content.subtitle_color || '#64748b'}
                      onChange={(e) => updateContent('subtitle_color', e.target.value)}
                      className="flex-1 font-mono text-xs"
                    />
                  </div>
                </div>
              </div>
            </div>
          </details>

          {/* Header Content - Rich Text */}
          <div className="pt-4 border-t border-slate-100">
            <Label className="block text-sm font-medium mb-1">Header Content</Label>
            <div className="border border-slate-300 rounded-md overflow-hidden bg-white">
              <ReactQuill
                theme="snow"
                value={content.header_content || ''}
                onChange={(value) => updateContent('header_content', value)}
                modules={heroQuillModules}
                placeholder="Optional content/body text for the header section"
                style={{ minHeight: '100px' }}
              />
            </div>
          </div>
          <TypographyStyleSelector
            value={content.content_typography_style_id || null}
            onChange={(styleId, style) => {
              const updates = { content_typography_style_id: styleId };
              if (style) {
                const mapped = applyTypographyStyle(style);
                if (mapped.font_family) updates.content_font_family = mapped.font_family;
                if (mapped.font_size) updates.content_font_size = mapped.font_size;
                if (mapped.font_size_mobile) updates.content_font_size_mobile = mapped.font_size_mobile;
                if (mapped.font_weight) updates.content_font_weight = mapped.font_weight;
                if (mapped.line_height) updates.content_line_height = mapped.line_height;
                if (mapped.letter_spacing !== undefined) updates.content_letter_spacing = mapped.letter_spacing;
                if (mapped.color) updates.content_color = mapped.color;
              }
              updateMultipleContent(updates);
            }}
            label="Content Typography Style"
          />
          <details className="text-xs">
            <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Content Font Settings</summary>
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Content Font Family</Label>
                  <select
                    value={content.content_font_family || 'Poppins'}
                    onChange={(e) => updateContent('content_font_family', e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                  >
                    {fontFamilies.map(font => (
                      <option key={font} value={font}>{font}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label>Content Font Weight</Label>
                  <select
                    value={content.content_font_weight || 400}
                    onChange={(e) => updateContent('content_font_weight', parseInt(e.target.value))}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                  >
                    {fontWeights.map(weight => (
                      <option key={weight.value} value={weight.value}>{weight.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Content Font Size (px)</Label>
                  <Input
                    type="number"
                    value={content.content_font_size || 16}
                    onChange={(e) => updateContent('content_font_size', parseInt(e.target.value) || 16)}
                    min="12"
                    max="32"
                  />
                </div>
                <div>
                  <Label>Content Color</Label>
                  <div className="flex gap-2 items-center">
                    <input
                      type="color"
                      value={content.content_color || '#475569'}
                      onChange={(e) => updateContent('content_color', e.target.value)}
                      className="w-12 h-9 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                    />
                    <Input
                      value={content.content_color || '#475569'}
                      onChange={(e) => updateContent('content_color', e.target.value)}
                      className="flex-1 font-mono text-xs"
                    />
                  </div>
                </div>
              </div>
            </div>
          </details>

          {/* Text Alignment */}
          <div className="pt-4 border-t border-slate-100">
            <Label>Header Alignment</Label>
            <select
              value={content.header_align || 'center'}
              onChange={(e) => updateContent('header_align', e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
            >
              <option value="left">Left</option>
              <option value="center">Center</option>
              <option value="right">Right</option>
            </select>
          </div>
        </div>
      </div>

      {/* Background Settings */}
      <div className="border-b pb-4">
        <h4 className="font-semibold text-sm mb-3">Background</h4>
        
        <div className="space-y-3">
          <div>
            <Label>Background Type</Label>
            <select
              value={backgroundType}
              onChange={(e) => updateContent('background_type', e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
            >
              <option value="none">None (Transparent)</option>
              <option value="color">Solid Color</option>
              <option value="gradient">Gradient</option>
              <option value="image">Image</option>
            </select>
          </div>

          {backgroundType === 'color' && (
            <div>
              <Label>Background Color</Label>
              <div className="flex gap-2 items-center">
                <input
                  type="color"
                  value={content.background_color || '#f8fafc'}
                  onChange={(e) => updateContent('background_color', e.target.value)}
                  className="w-16 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                />
                <Input
                  value={content.background_color || '#f8fafc'}
                  onChange={(e) => updateContent('background_color', e.target.value)}
                  className="flex-1 font-mono text-sm"
                />
              </div>
            </div>
          )}

          {backgroundType === 'gradient' && (
            <div className="space-y-3 p-3 bg-slate-50 rounded-md">
              <div 
                className="w-full h-16 rounded-md border border-slate-300"
                style={{ background: gradientPreview }}
              />
              
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Start Color</Label>
                  <div className="flex gap-2 items-center">
                    <input
                      type="color"
                      value={content.gradient_start_color || '#3b82f6'}
                      onChange={(e) => updateContent('gradient_start_color', e.target.value)}
                      className="w-12 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                    />
                    <Input
                      value={content.gradient_start_color || '#3b82f6'}
                      onChange={(e) => updateContent('gradient_start_color', e.target.value)}
                      className="flex-1 font-mono text-xs"
                    />
                  </div>
                </div>
                <div>
                  <Label>End Color</Label>
                  <div className="flex gap-2 items-center">
                    <input
                      type="color"
                      value={content.gradient_end_color || '#8b5cf6'}
                      onChange={(e) => updateContent('gradient_end_color', e.target.value)}
                      className="w-12 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                    />
                    <Input
                      value={content.gradient_end_color || '#8b5cf6'}
                      onChange={(e) => updateContent('gradient_end_color', e.target.value)}
                      className="flex-1 font-mono text-xs"
                    />
                  </div>
                </div>
              </div>
              
              <div>
                <Label>Angle: {content.gradient_angle || 135}°</Label>
                <input
                  type="range"
                  min="0"
                  max="360"
                  value={content.gradient_angle || 135}
                  onChange={(e) => updateContent('gradient_angle', parseInt(e.target.value))}
                  className="w-full"
                />
              </div>
            </div>
          )}

          {backgroundType === 'image' && (
            <>
              <div>
                <Label>Background Image</Label>
                <div className="space-y-2">
                  <label className="inline-block">
                    <div className={`px-4 py-2 rounded-md text-sm font-medium cursor-pointer ${
                      isUploading 
                        ? 'bg-slate-300 cursor-not-allowed' 
                        : 'bg-blue-600 hover:bg-blue-700 text-white'
                    }`}>
                      {isUploading ? 'Uploading...' : 'Upload Image'}
                    </div>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleImageUpload(file);
                        e.target.value = '';
                      }}
                      className="hidden"
                      disabled={isUploading}
                    />
                  </label>
                </div>
                {content.background_image_url && (
                  <div className="mt-2 relative">
                    <img
                      src={content.background_image_url}
                      alt="Preview"
                      className="w-full h-32 object-cover rounded"
                      onError={(e) => { e.target.style.display = 'none'; }}
                    />
                    <button
                      onClick={() => updateContent('background_image_url', '')}
                      className="absolute bottom-2 right-2 px-2 py-1 bg-red-600 hover:bg-red-700 text-white text-xs rounded"
                      type="button"
                    >
                      Remove
                    </button>
                  </div>
                )}
              </div>

              <div>
                <Label>Image Fit</Label>
                <select
                  value={content.background_image_fit || 'cover'}
                  onChange={(e) => updateContent('background_image_fit', e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                >
                  <option value="cover">Cover (fill, may crop)</option>
                  <option value="contain">Contain (show all)</option>
                </select>
              </div>

              <div className="space-y-3 p-3 bg-slate-50 rounded-md">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="accordion_overlay_enabled"
                    checked={content.overlay_enabled || false}
                    onChange={(e) => updateContent('overlay_enabled', e.target.checked)}
                    className="rounded"
                  />
                  <label htmlFor="accordion_overlay_enabled" className="text-sm font-medium">Enable Overlay</label>
                </div>
                
                {content.overlay_enabled && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>Overlay Color</Label>
                      <input
                        type="color"
                        value={content.overlay_color || '#000000'}
                        onChange={(e) => updateContent('overlay_color', e.target.value)}
                        className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                      />
                    </div>
                    <div>
                      <Label>Opacity (%)</Label>
                      <Input
                        type="number"
                        value={content.overlay_opacity || 50}
                        onChange={(e) => updateContent('overlay_opacity', parseInt(e.target.value) || 50)}
                        min="0"
                        max="100"
                      />
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Accordion Item Header Styles */}
      <div className="border-b pb-4">
        <h4 className="font-semibold text-sm mb-3">Accordion Header Style</h4>
        
        <div className="space-y-3">
          <TypographyStyleSelector
            value={content.item_header_typography_style_id}
            onChange={(styleId, style) => {
              const updates = { item_header_typography_style_id: styleId };
              if (style) {
                const mapped = applyTypographyStyle(style);
                if (mapped.font_family) updates.item_header_font_family = mapped.font_family;
                if (mapped.font_size) updates.item_header_font_size = mapped.font_size;
                if (mapped.font_size_mobile) updates.item_header_font_size_mobile = mapped.font_size_mobile;
                if (mapped.font_weight) updates.item_header_font_weight = mapped.font_weight;
                if (mapped.line_height) updates.item_header_line_height = mapped.line_height;
                if (mapped.letter_spacing !== undefined) updates.item_header_letter_spacing = mapped.letter_spacing;
                if (mapped.color) updates.item_header_color = mapped.color;
              }
              updateMultipleContent(updates);
            }}
            label="Accordion Header Typography Style"
          />

          <details className="text-xs">
            <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Font Family</Label>
                  <select
                    value={content.item_header_font_family || 'Poppins'}
                    onChange={(e) => updateContent('item_header_font_family', e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                  >
                    {fontFamilies.map(font => (
                      <option key={font} value={font}>{font}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label>Font Weight</Label>
                  <select
                    value={content.item_header_font_weight || 600}
                    onChange={(e) => updateContent('item_header_font_weight', parseInt(e.target.value))}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                  >
                    {fontWeights.map(weight => (
                      <option key={weight.value} value={weight.value}>{weight.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label>Font Size (px)</Label>
                  <Input
                    type="number"
                    value={content.item_header_font_size || 18}
                    onChange={(e) => updateContent('item_header_font_size', parseInt(e.target.value) || 18)}
                    min="12"
                    max="48"
                  />
                </div>
                <div>
                  <Label>Mobile Size (px)</Label>
                  <Input
                    type="number"
                    value={content.item_header_font_size_mobile || ''}
                    onChange={(e) => updateContent('item_header_font_size_mobile', e.target.value ? parseInt(e.target.value) : '')}
                    min="12"
                    max="48"
                    placeholder="Same"
                  />
                </div>
                <div>
                  <Label>Text Color</Label>
                  <input
                    type="color"
                    value={content.item_header_color || '#1e293b'}
                    onChange={(e) => updateContent('item_header_color', e.target.value)}
                    className="w-full h-9 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Letter Spacing (px)</Label>
                  <Input
                    type="number"
                    step="0.5"
                    value={content.item_header_letter_spacing || 0}
                    onChange={(e) => updateContent('item_header_letter_spacing', parseFloat(e.target.value) || 0)}
                    min="-2"
                    max="10"
                  />
                </div>
                <div>
                  <Label>Line Height</Label>
                  <Input
                    type="number"
                    step="0.1"
                    value={content.item_header_line_height || 1.4}
                    onChange={(e) => updateContent('item_header_line_height', parseFloat(e.target.value) || 1.4)}
                    min="0.8"
                    max="3"
                  />
                </div>
              </div>
            </div>
          </details>

          <div>
            <Label>Header Background</Label>
            <div className="flex gap-2 items-center">
              <input
                type="color"
                value={content.item_header_bg || '#ffffff'}
                onChange={(e) => updateContent('item_header_bg', e.target.value)}
                className="w-12 h-9 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
              />
              <Input
                value={content.item_header_bg || '#ffffff'}
                onChange={(e) => updateContent('item_header_bg', e.target.value)}
                className="flex-1 font-mono text-xs"
                placeholder="#ffffff"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Accordion Content Styles */}
      <div className="border-b pb-4">
        <h4 className="font-semibold text-sm mb-3">Accordion Content Style</h4>
        
        <div className="space-y-3">
          <TypographyStyleSelector
            value={content.item_content_typography_style_id}
            onChange={(styleId, style) => {
              const updates = { item_content_typography_style_id: styleId };
              if (style) {
                const mapped = applyTypographyStyle(style);
                if (mapped.font_family) updates.item_content_font_family = mapped.font_family;
                if (mapped.font_size) updates.item_content_font_size = mapped.font_size;
                if (mapped.font_size_mobile) updates.item_content_font_size_mobile = mapped.font_size_mobile;
                if (mapped.font_weight) updates.item_content_font_weight = mapped.font_weight;
                if (mapped.line_height) updates.item_content_line_height = mapped.line_height;
                if (mapped.letter_spacing !== undefined) updates.item_content_letter_spacing = mapped.letter_spacing;
                if (mapped.color) updates.item_content_color = mapped.color;
              }
              updateMultipleContent(updates);
            }}
            label="Accordion Content Typography Style"
          />

          <details className="text-xs">
            <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Font Family</Label>
                  <select
                    value={content.item_content_font_family || 'Poppins'}
                    onChange={(e) => updateContent('item_content_font_family', e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                  >
                    {fontFamilies.map(font => (
                      <option key={font} value={font}>{font}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label>Font Weight</Label>
                  <select
                    value={content.item_content_font_weight || 400}
                    onChange={(e) => updateContent('item_content_font_weight', parseInt(e.target.value))}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                  >
                    {fontWeights.map(weight => (
                      <option key={weight.value} value={weight.value}>{weight.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label>Font Size (px)</Label>
                  <Input
                    type="number"
                    value={content.item_content_font_size || 16}
                    onChange={(e) => updateContent('item_content_font_size', parseInt(e.target.value) || 16)}
                    min="12"
                    max="32"
                  />
                </div>
                <div>
                  <Label>Mobile Size (px)</Label>
                  <Input
                    type="number"
                    value={content.item_content_font_size_mobile || ''}
                    onChange={(e) => updateContent('item_content_font_size_mobile', e.target.value ? parseInt(e.target.value) : '')}
                    min="12"
                    max="32"
                    placeholder="Same"
                  />
                </div>
                <div>
                  <Label>Text Color</Label>
                  <input
                    type="color"
                    value={content.item_content_color || '#475569'}
                    onChange={(e) => updateContent('item_content_color', e.target.value)}
                    className="w-full h-9 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Letter Spacing (px)</Label>
                  <Input
                    type="number"
                    step="0.5"
                    value={content.item_content_letter_spacing || 0}
                    onChange={(e) => updateContent('item_content_letter_spacing', parseFloat(e.target.value) || 0)}
                    min="-2"
                    max="10"
                  />
                </div>
                <div>
                  <Label>Line Height</Label>
                  <Input
                    type="number"
                    step="0.1"
                    value={content.item_content_line_height || 1.6}
                    onChange={(e) => updateContent('item_content_line_height', parseFloat(e.target.value) || 1.6)}
                    min="1"
                    max="3"
                  />
                </div>
              </div>
            </div>
          </details>

          <div>
            <Label>Content Background</Label>
            <div className="flex gap-2 items-center">
              <input
                type="color"
                value={content.item_content_bg || '#f8fafc'}
                onChange={(e) => updateContent('item_content_bg', e.target.value)}
                className="w-12 h-9 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
              />
              <Input
                value={content.item_content_bg || '#f8fafc'}
                onChange={(e) => updateContent('item_content_bg', e.target.value)}
                className="flex-1 font-mono text-xs"
                placeholder="#f8fafc"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Accordion Items */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h4 className="font-semibold text-sm">Accordion Items</h4>
          <Button
            type="button"
            size="sm"
            onClick={addItem}
            className="bg-blue-600 hover:bg-blue-700"
          >
            <Plus className="w-4 h-4 mr-1" />
            Add Item
          </Button>
        </div>
        
        {items.length === 0 ? (
          <div className="text-center py-8 bg-slate-50 rounded-lg border-2 border-dashed border-slate-200">
            <p className="text-slate-500 text-sm">No accordion items yet. Click "Add Item" to create one.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((item, index) => (
              <div key={item.id || index} className="border border-slate-200 rounded-lg overflow-hidden">
                <div 
                  className="flex items-center gap-2 p-3 bg-slate-50 cursor-pointer hover:bg-slate-100"
                  onClick={() => setExpandedItem(expandedItem === index ? null : index)}
                >
                  <div className="flex flex-col gap-0.5">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); moveItem(index, -1); }}
                      disabled={index === 0}
                      className="p-0.5 hover:bg-slate-200 rounded disabled:opacity-30"
                    >
                      <ChevronUp className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); moveItem(index, 1); }}
                      disabled={index === items.length - 1}
                      className="p-0.5 hover:bg-slate-200 rounded disabled:opacity-30"
                    >
                      <ChevronDown className="w-3 h-3" />
                    </button>
                  </div>
                  <span className="flex-1 font-medium text-sm truncate">
                    {stripHtmlTags(item.title) || 'Untitled'}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); removeItem(index); }}
                    className="p-1 hover:bg-red-100 rounded text-red-600"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                  <ChevronDown className={`w-4 h-4 transition-transform ${expandedItem === index ? 'rotate-180' : ''}`} />
                </div>
                
                {expandedItem === index && (
                  <div className="p-3 space-y-4 border-t">
                    <div>
                      <Label>Title / Question</Label>
                      <div className="accordion-quill-editor border rounded-md overflow-hidden">
                        <ReactQuill
                          theme="snow"
                          value={item.title || ''}
                          onChange={(value) => updateItem(index, 'title', value)}
                          modules={heroQuillModules}
                          placeholder="Enter the accordion header text..."
                          style={{ minHeight: '60px' }}
                        />
                      </div>
                    </div>
                    <div>
                      <Label>Content / Answer</Label>
                      <div className="accordion-quill-editor border rounded-md overflow-hidden">
                        <ReactQuill
                          theme="snow"
                          value={item.content || ''}
                          onChange={(value) => updateItem(index, 'content', value)}
                          modules={heroQuillModules}
                          placeholder="Enter the accordion content..."
                          style={{ minHeight: '150px' }}
                        />
                      </div>
                    </div>
                    
                    {/* Links Section */}
                    <div className="border-t pt-3">
                      <div className="flex items-center justify-between mb-2">
                        <Label className="text-sm font-semibold">Links</Label>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => addLinkToItem(index)}
                          className="h-7 text-xs"
                        >
                          <Plus className="w-3 h-3 mr-1" />
                          Add Link
                        </Button>
                      </div>
                      
                      {(item.links || []).length === 0 ? (
                        <p className="text-xs text-slate-500 italic">No links added yet</p>
                      ) : (
                        <div className="space-y-2">
                          {(item.links || []).map((link, linkIndex) => {
                            const IconComponent = getLinkIcon(link.icon_type);
                            return (
                              <div 
                                key={link.id || linkIndex} 
                                className="bg-slate-50 rounded-lg p-3 border border-slate-200"
                              >
                                <div className="flex items-start gap-2">
                                  <div className="flex flex-col gap-0.5 mt-1">
                                    <button
                                      type="button"
                                      onClick={() => moveLinkInItem(index, linkIndex, -1)}
                                      disabled={linkIndex === 0}
                                      className="p-0.5 hover:bg-slate-200 rounded disabled:opacity-30"
                                    >
                                      <ChevronUp className="w-3 h-3" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => moveLinkInItem(index, linkIndex, 1)}
                                      disabled={linkIndex === (item.links || []).length - 1}
                                      className="p-0.5 hover:bg-slate-200 rounded disabled:opacity-30"
                                    >
                                      <ChevronDown className="w-3 h-3" />
                                    </button>
                                  </div>
                                  
                                  <div className="flex-1 space-y-2">
                                    <div className="grid grid-cols-2 gap-2">
                                      <div>
                                        <Label className="text-xs">Icon Type</Label>
                                        <select
                                          value={link.icon_type || 'external'}
                                          onChange={(e) => updateItemLink(index, linkIndex, 'icon_type', e.target.value)}
                                          className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                                        >
                                          {LINK_ICON_TYPES.map(type => (
                                            <option key={type.value} value={type.value}>
                                              {type.label}
                                            </option>
                                          ))}
                                        </select>
                                      </div>
                                      <div>
                                        <Label className="text-xs">Link Label</Label>
                                        <Input
                                          value={link.label || ''}
                                          onChange={(e) => updateItemLink(index, linkIndex, 'label', e.target.value)}
                                          placeholder="Display text"
                                          className="h-8 text-sm"
                                        />
                                      </div>
                                    </div>
                                    
                                    {/* URL or File Selection */}
                                    <div className="space-y-2">
                                      <Label className="text-xs">Link Target</Label>
                                      
                                      {/* Show selected file info */}
                                      {link.file_id && link.file_name ? (
                                        <div className="flex items-center gap-2 p-2 bg-blue-50 border border-blue-200 rounded-md text-xs">
                                          <File className="w-4 h-4 text-blue-600 flex-shrink-0" />
                                          <span className="flex-1 truncate text-blue-800">{link.file_name}</span>
                                          <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            onClick={() => setShowFilePicker({ itemIndex: index, linkIndex })}
                                            className="h-6 text-xs px-2"
                                          >
                                            Change
                                          </Button>
                                          <button
                                            type="button"
                                            onClick={() => clearFileSelection(index, linkIndex)}
                                            className="p-0.5 hover:bg-blue-100 rounded text-blue-600"
                                          >
                                            <Trash2 className="w-3 h-3" />
                                          </button>
                                        </div>
                                      ) : (
                                        <Button
                                          type="button"
                                          variant="outline"
                                          size="sm"
                                          onClick={() => setShowFilePicker({ itemIndex: index, linkIndex })}
                                          className="w-full h-8 text-xs"
                                        >
                                          <FolderOpen className="w-3 h-3 mr-2" />
                                          Select from File Repository
                                        </Button>
                                      )}
                                      
                                      {/* Manual URL input */}
                                      <div>
                                        <Label className="text-xs text-slate-500">Or enter URL manually:</Label>
                                        <Input
                                          value={link.url || ''}
                                          onChange={(e) => {
                                            updateItemLink(index, linkIndex, 'url', e.target.value);
                                            // Clear file selection if manually entering URL
                                            if (link.file_id) {
                                              clearFileSelection(index, linkIndex);
                                            }
                                          }}
                                          placeholder="https://..."
                                          className="h-8 text-sm"
                                        />
                                      </div>
                                    </div>
                                    
                                    <div className="flex items-center gap-2">
                                      <Checkbox
                                        id={`link-newtab-${index}-${linkIndex}`}
                                        checked={link.open_in_new_tab !== false}
                                        onCheckedChange={(checked) => updateItemLink(index, linkIndex, 'open_in_new_tab', checked)}
                                      />
                                      <label 
                                        htmlFor={`link-newtab-${index}-${linkIndex}`}
                                        className="text-xs text-slate-600 cursor-pointer"
                                      >
                                        Open in new tab
                                      </label>
                                    </div>
                                  </div>
                                  
                                  <button
                                    type="button"
                                    onClick={() => removeItemLink(index, linkIndex)}
                                    className="p-1 hover:bg-red-100 rounded text-red-600"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                </div>
                                
                                {/* Link Preview */}
                                <div className="mt-2 pt-2 border-t border-slate-200">
                                  <p className="text-xs text-slate-500 mb-1">Preview:</p>
                                  <div className="flex items-center gap-2 text-sm text-blue-600">
                                    <IconComponent className="w-4 h-4" />
                                    <span>{link.label || 'Link text'}</span>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* File Selector Dialog */}
      <Dialog open={!!showFilePicker} onOpenChange={(open) => !open && closeFileSelectorDialog()}>
        <DialogContent className="max-w-5xl max-h-[85vh] grid grid-rows-[auto_1fr_auto] gap-4">
          <DialogHeader>
            <DialogTitle>Select File from Repository</DialogTitle>
            <div className="pt-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  placeholder="Search files by name or description..."
                  value={fileSelectorSearch}
                  onChange={(e) => {
                    setFileSelectorSearch(e.target.value);
                    resetFileSelectorPage();
                  }}
                  className="pl-10"
                />
                {fileSelectorSearch && (
                  <button
                    onClick={() => {
                      setFileSelectorSearch('');
                      resetFileSelectorPage();
                    }}
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
                  onClick={() => {
                    setFileSelectorFolder(null);
                    resetFileSelectorPage();
                  }}
                  className="flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900"
                >
                  <Home className="w-3 h-3" />
                  All Files
                </button>
                {fileSelectorBreadcrumb.map((folder, idx) => (
                  <span key={folder.id} className="inline-flex items-center">
                    <ChevronRight className="w-3 h-3 text-slate-400 mx-1" />
                    <button
                      onClick={() => {
                        setFileSelectorFolder(folder.id);
                        resetFileSelectorPage();
                      }}
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
              <div className="border border-slate-200 rounded-lg p-2 max-h-80 overflow-y-auto">
                <div
                  className={`flex items-center gap-2 py-2 px-3 rounded cursor-pointer transition-all ${
                    fileSelectorFolder === null ? 'bg-blue-100' : 'hover:bg-slate-100'
                  }`}
                  onClick={() => {
                    setFileSelectorFolder(null);
                    resetFileSelectorPage();
                  }}
                >
                  <FolderOpen className="w-4 h-4 text-slate-600" />
                  <span className="flex-1 text-sm font-medium">All Files</span>
                  <span className="text-xs text-slate-500">
                    ({repositoryFiles.length})
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
                  {filteredRepositoryFiles.length} file{filteredRepositoryFiles.length !== 1 ? 's' : ''} 
                  {fileSelectorSearch && ` matching "${fileSelectorSearch}"`}
                </span>
                {fileSelectorTotalPages > 1 && (
                  <span>Page {fileSelectorPage} of {fileSelectorTotalPages}</span>
                )}
              </div>

              <div className="flex-1 overflow-y-auto min-h-0">
                {filteredRepositoryFiles.length === 0 ? (
                  <div className="text-center py-12">
                    <FileText className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                    <p className="text-slate-600">
                      {fileSelectorSearch 
                        ? "No files match your search"
                        : "No files in this folder"}
                    </p>
                    <p className="text-sm text-slate-500 mt-2">
                      {fileSelectorSearch 
                        ? "Try a different search term or browse folders"
                        : fileSelectorFolder 
                          ? "Try selecting a different folder"
                          : "Upload files in the File Repository page"}
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                    {paginatedRepositoryFiles.map((file) => {
                      const FileIcon = getFileTypeIcon(file.file_type);
                      return (
                        <button
                          key={file.id}
                          onClick={() => handleFileSelect(file)}
                          className="text-left border-2 border-slate-200 rounded-lg hover:border-blue-500 transition-colors p-2"
                        >
                          {file.file_type === 'image' ? (
                            <img
                              src={file.file_url}
                              alt={file.file_name}
                              className="w-full h-28 object-cover rounded mb-2"
                            />
                          ) : (
                            <div className="w-full h-28 bg-slate-100 rounded flex items-center justify-center mb-2">
                              <FileIcon className="w-10 h-10 text-slate-400" />
                            </div>
                          )}
                          <p className="text-sm font-medium text-slate-900 truncate">
                            {file.file_name}
                          </p>
                          {file.description && (
                            <p className="text-xs text-slate-500 truncate mt-1">
                              {file.description}
                            </p>
                          )}
                        </button>
                      );
                    })}
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
                  >
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeFileSelectorDialog}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function IEditAccordionElementRenderer({ element, content: contentProp, variant, settings }) {
  const [openItems, setOpenItems] = useState([]);
  const rawId = useId();
  const uniqueId = rawId.replace(/:/g, '');
  const isMobile = useIsMobile();
  
  // Use contentProp as primary source (fresh from editor state), fall back to element.content (persisted)
  // This matches IEditFiftyFiftyElement pattern where content prop takes precedence
  const content = contentProp || element?.content || {};
  const items = content.items || [];
  const backgroundType = content.background_type || 'none';

  const toggleItem = (index) => {
    setOpenItems(prev => 
      prev.includes(index) 
        ? prev.filter(i => i !== index)
        : [...prev, index]
    );
  };

  // Helper to get font size with mobile fallback
  const getFontSize = (desktopSize, mobileSize, defaultSize) => {
    const desktop = desktopSize || defaultSize;
    const mobile = mobileSize || desktop;
    return isMobile ? mobile : desktop;
  };

  // Section header styles
  const headerStyle = {
    fontFamily: content.header_font_family || 'Poppins',
    fontWeight: content.header_font_weight || 700,
    fontSize: `${getFontSize(content.header_font_size, content.header_font_size_mobile, 32)}px`,
    color: content.header_color || '#1e293b',
    textAlign: content.header_align || 'center',
    lineHeight: content.header_line_height || 1.2,
    letterSpacing: content.header_letter_spacing ? `${content.header_letter_spacing}px` : undefined
  };

  // Section subtitle styles
  const subtitleStyle = {
    fontFamily: content.subtitle_font_family || 'Poppins',
    fontWeight: content.subtitle_font_weight || 400,
    fontSize: `${getFontSize(content.subtitle_font_size, content.subtitle_font_size_mobile, 18)}px`,
    color: content.subtitle_color || '#64748b',
    textAlign: content.header_align || 'center',
    lineHeight: content.subtitle_line_height || 1.5,
    letterSpacing: content.subtitle_letter_spacing ? `${content.subtitle_letter_spacing}px` : undefined
  };

  // Section content styles
  const sectionContentStyle = {
    fontFamily: content.content_font_family || 'Poppins',
    fontWeight: content.content_font_weight || 400,
    fontSize: `${getFontSize(content.content_font_size, content.content_font_size_mobile, 16)}px`,
    color: content.content_color || '#475569',
    textAlign: content.header_align || 'center',
    lineHeight: content.content_line_height || 1.6,
    letterSpacing: content.content_letter_spacing ? `${content.content_letter_spacing}px` : undefined
  };

  // Accordion item header styles
  const itemHeaderStyle = {
    fontFamily: content.item_header_font_family || 'Poppins',
    fontWeight: content.item_header_font_weight || 600,
    fontSize: `${getFontSize(content.item_header_font_size, content.item_header_font_size_mobile, 18)}px`,
    color: content.item_header_color || '#1e293b',
    backgroundColor: content.item_header_bg || '#ffffff',
    lineHeight: content.item_header_line_height || 1.4,
    letterSpacing: content.item_header_letter_spacing ? `${content.item_header_letter_spacing}px` : undefined
  };

  // Accordion item content styles
  const itemContentStyle = {
    fontFamily: content.item_content_font_family || 'Poppins',
    fontWeight: content.item_content_font_weight || 400,
    fontSize: `${getFontSize(content.item_content_font_size, content.item_content_font_size_mobile, 16)}px`,
    color: content.item_content_color || '#475569',
    lineHeight: content.item_content_line_height || 1.6,
    letterSpacing: content.item_content_letter_spacing ? `${content.item_content_letter_spacing}px` : undefined,
    backgroundColor: content.item_content_bg || '#f8fafc'
  };

  // Background style
  const getBackgroundStyle = () => {
    if (backgroundType === 'color') {
      return { backgroundColor: content.background_color || '#f8fafc' };
    }
    if (backgroundType === 'gradient') {
      return { 
        background: `linear-gradient(${content.gradient_angle || 135}deg, ${content.gradient_start_color || '#3b82f6'}, ${content.gradient_end_color || '#8b5cf6'})` 
      };
    }
    return {};
  };

  const hasBackground = backgroundType && backgroundType !== 'none';

  if (items.length === 0) {
    return (
      <div className="bg-slate-100 border-2 border-dashed border-slate-300 rounded-lg p-12 text-center">
        <p className="text-slate-600">Add accordion items to display the FAQ section</p>
      </div>
    );
  }

  return (
    <>
      <style>{`
        .accordion-${uniqueId} .accordion-content {
          max-height: 0;
          overflow: hidden;
          transition: max-height 0.3s ease-out;
        }
        .accordion-${uniqueId} .accordion-content.open {
          max-height: 1000px;
          transition: max-height 0.5s ease-in;
        }
        .accordion-${uniqueId} .accordion-icon {
          transition: transform 0.3s ease;
        }
        .accordion-${uniqueId} .accordion-icon.open {
          transform: rotate(180deg);
        }
      `}</style>
      
      <div 
        className={`accordion-${uniqueId} relative py-12`}
        style={hasBackground && backgroundType !== 'image' ? getBackgroundStyle() : {}}
      >
        {/* Background image layer */}
        {backgroundType === 'image' && content.background_image_url && (
          <>
            <img 
              src={content.background_image_url} 
              alt="Background" 
              className="absolute inset-0 w-full h-full"
              style={{ objectFit: content.background_image_fit || 'cover' }}
            />
            {content.overlay_enabled && (
              <div 
                className="absolute inset-0" 
                style={{ 
                  backgroundColor: content.overlay_color || '#000000', 
                  opacity: parseInt(content.overlay_opacity || 50) / 100 
                }} 
              />
            )}
          </>
        )}

        {/* Content */}
        <div className="relative max-w-4xl mx-auto px-4">
          {/* Section Header */}
          {(content.header_title || content.header_subtitle || content.header_content) && (
            <div className="mb-8">
              {content.header_title && (
                <div 
                  style={headerStyle} 
                  className="accordion-header-title mb-2"
                  dangerouslySetInnerHTML={{ 
                    __html: DOMPurify.sanitize(content.header_title) 
                  }}
                />
              )}
              {content.header_subtitle && (
                <div 
                  className="accordion-header-subtitle mb-3"
                  style={subtitleStyle}
                  dangerouslySetInnerHTML={{ 
                    __html: DOMPurify.sanitize(content.header_subtitle) 
                  }}
                />
              )}
              {content.header_content && (
                <div 
                  className="accordion-header-content prose prose-sm max-w-none"
                  style={sectionContentStyle}
                  dangerouslySetInnerHTML={{ 
                    __html: DOMPurify.sanitize(content.header_content) 
                  }}
                />
              )}
            </div>
          )}

          {/* Accordion Items */}
          <div className="space-y-3">
            {items.map((item, index) => (
              <div 
                key={item.id || index}
                className="rounded-lg overflow-hidden shadow-sm border border-slate-200"
              >
                <button
                  type="button"
                  onClick={() => toggleItem(index)}
                  className="w-full flex items-center justify-between p-4 text-left hover:opacity-90 transition-opacity"
                  style={itemHeaderStyle}
                  data-testid={`accordion-header-${index}`}
                >
                  <div 
                    className="accordion-item-title prose prose-sm max-w-none flex-1"
                    dangerouslySetInnerHTML={{ 
                      __html: DOMPurify.sanitize(item.title || '') 
                    }}
                  />
                  <ChevronDown 
                    className={`accordion-icon w-5 h-5 flex-shrink-0 ml-4 ${openItems.includes(index) ? 'open' : ''}`}
                  />
                </button>
                
                <div 
                  className={`accordion-content ${openItems.includes(index) ? 'open' : ''}`}
                  data-testid={`accordion-content-${index}`}
                >
                  <div 
                    className="p-4 border-t"
                    style={itemContentStyle}
                  >
                    {/* Render rich text content with proper HTML sanitization */}
                    <div 
                      className="accordion-content-html prose prose-sm max-w-none"
                      dangerouslySetInnerHTML={{ 
                        __html: DOMPurify.sanitize(item.content || '') 
                      }}
                    />
                    
                    {/* Render Links */}
                    {item.links && item.links.length > 0 && (
                      <div className="mt-4 pt-3 border-t border-slate-200/50">
                        <div className="flex flex-wrap gap-3">
                          {item.links.map((link, linkIndex) => {
                            const IconComponent = getLinkIcon(link.icon_type);
                            return (
                              <a
                                key={link.id || linkIndex}
                                href={link.url || '#'}
                                target={link.open_in_new_tab !== false ? '_blank' : '_self'}
                                rel={link.open_in_new_tab !== false ? 'noopener noreferrer' : undefined}
                                className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-white/80 border border-slate-200 text-blue-600 hover:bg-blue-50 hover:border-blue-300 transition-colors text-sm font-medium"
                                data-testid={`accordion-link-${index}-${linkIndex}`}
                              >
                                <IconComponent className="w-4 h-4 flex-shrink-0" />
                                <span>{link.label || 'Link'}</span>
                              </a>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

export default IEditAccordionElementRenderer;
