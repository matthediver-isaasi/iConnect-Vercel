import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import DOMPurify from 'dompurify';
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { 
  ChevronDown, 
  ChevronUp, 
  Upload, 
  X, 
  Loader2,
  Image as ImageIcon,
  FolderOpen,
  Folder,
  Home,
  ChevronRight,
  ChevronLeft,
  Search,
  FileText,
  AlignLeft,
  AlignCenter,
  AlignRight
} from "lucide-react";
import { base44 } from "@/api/base44Client";
import TypographyStyleSelector, { applyTypographyStyle } from "../TypographyStyleSelector";

const textOverlayQuillModules = {
  toolbar: [
    [{ 'header': [1, 2, 3, false] }],
    ['bold', 'italic', 'underline', 'strike'],
    [{ 'list': 'ordered'}, { 'list': 'bullet' }],
    [{ 'indent': '-1'}, { 'indent': '+1' }],
    ['blockquote'],
    ['link'],
    ['clean']
  ]
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

export default function IEditTextOverlayImageElement({ content, variant, settings }) {
  const {
    backgroundImage,
    header = '',
    text = '',
    textPosition = 'left',
    borderStyle = 'none',
    borderColor = '#000000',
    backgroundColor = '#ffffff',
    opacity = 1,
    header_font_family = 'Poppins',
    header_font_size = 32,
    header_font_weight = 700,
    header_line_height = 1.2,
    header_letter_spacing = 0,
    header_color = '#1e293b',
    header_align = 'left',
    content_font_family = 'Poppins',
    content_font_size = 16,
    content_font_weight = 400,
    content_line_height = 1.6,
    content_letter_spacing = 0,
    content_color = '#475569',
    content_align = 'left',
    image_border_radius = 0,
    image_border_enabled = false,
    image_border_width = 2,
    image_border_color = '#e2e8f0',
    image_shadow_enabled = false,
    image_shadow_size = 'medium',
    image_shadow_color = 'rgba(0,0,0,0.15)',
    content_box_border_radius = 8,
    min_height = 400,
    overlay_enabled = false,
    overlay_color = '#000000',
    overlay_opacity = 30,
    overlay_width = 50,
    overlay_vertical_align = 'center',
    text_vertical_align = 'top'
  } = content || {};

  const getImageContainerStyles = () => {
    const styles = {
      position: 'relative',
      width: '100%',
      minHeight: `${min_height}px`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden'
    };

    if (image_border_radius > 0) {
      styles.borderRadius = `${image_border_radius}px`;
    }

    if (image_border_enabled) {
      styles.border = `${image_border_width}px solid ${image_border_color}`;
    }

    if (image_shadow_enabled) {
      const shadows = {
        small: `0 2px 4px ${image_shadow_color}`,
        medium: `0 4px 12px ${image_shadow_color}`,
        large: `0 8px 24px ${image_shadow_color}`,
        xl: `0 12px 40px ${image_shadow_color}`
      };
      styles.boxShadow = shadows[image_shadow_size] || shadows.medium;
    }

    return styles;
  };

  const getHeaderStyles = () => ({
    fontFamily: header_font_family,
    fontSize: `${header_font_size}px`,
    fontWeight: header_font_weight,
    lineHeight: header_line_height,
    letterSpacing: `${header_letter_spacing}px`,
    color: header_color,
    textAlign: header_align,
    marginBottom: '1rem'
  });

  const getContentStyles = () => ({
    fontFamily: content_font_family,
    fontSize: `${content_font_size}px`,
    fontWeight: content_font_weight,
    lineHeight: content_line_height,
    letterSpacing: `${content_letter_spacing}px`,
    color: content_color,
    textAlign: content_align
  });

  const contentBoxStyle = {
    backgroundColor: backgroundColor,
    opacity: opacity,
    border: borderStyle !== 'none' ? `2px ${borderStyle} ${borderColor}` : 'none',
    borderRadius: `${content_box_border_radius}px`
  };

  return (
    <div style={getImageContainerStyles()}>
      {backgroundImage && (
        <img 
          src={backgroundImage} 
          alt="Background" 
          className="absolute inset-0 w-full h-full"
          style={{ objectFit: 'cover' }}
        />
      )}
      
      {!backgroundImage && (
        <div className="absolute inset-0 bg-slate-200" />
      )}

      {overlay_enabled && backgroundImage && (
        <div 
          className="absolute inset-0" 
          style={{ 
            backgroundColor: overlay_color, 
            opacity: overlay_opacity / 100 
          }} 
        />
      )}

      <div 
        className="relative w-full h-full flex px-4 py-12"
        style={{
          justifyContent: textPosition === 'right' ? 'flex-end' : textPosition === 'center' ? 'center' : 'flex-start',
          alignItems: overlay_vertical_align === 'bottom' ? 'flex-end' : overlay_vertical_align === 'top' ? 'flex-start' : 'center'
        }}
      >
        <div 
          className="flex flex-col p-8"
          style={{
            ...contentBoxStyle,
            width: `${overlay_width}%`,
            maxWidth: '100%',
            justifyContent: text_vertical_align === 'bottom' ? 'flex-end' : text_vertical_align === 'center' ? 'center' : 'flex-start'
          }}
        >
          {header && (
            <h2 style={getHeaderStyles()}>
              {header}
            </h2>
          )}
          {text && (
            <div 
              className="prose max-w-none text-overlay-content"
              style={getContentStyles()}
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(text) }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export function IEditTextOverlayImageElementEditor({ element, onChange }) {
  const content = element.content || {};
  
  const [expandedSections, setExpandedSections] = useState({
    image: true,
    header: false,
    content: false,
    layout: false,
    imageEffects: false
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

  const updateMultipleContent = (updates) => {
    onChange({ ...element, content: { ...content, ...updates } });
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

  const fileSelectorTotalPages = Math.ceil(filteredRepositoryFiles.length / fileSelectorItemsPerPage);
  const fileSelectorStartIndex = (fileSelectorPage - 1) * fileSelectorItemsPerPage;
  const paginatedRepositoryFiles = filteredRepositoryFiles.slice(fileSelectorStartIndex, fileSelectorStartIndex + fileSelectorItemsPerPage);

  const handleImageUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    try {
      const { file_url } = await base44.integrations.Core.UploadFile({ file });
      updateContent('backgroundImage', file_url);
    } catch (error) {
      console.error('Failed to upload image:', error);
    } finally {
      setIsUploading(false);
    }
  };

  const handleSelectFile = (fileUrl) => {
    updateContent('backgroundImage', fileUrl);
    setShowFileSelector(false);
    setFileSelectorFolder(null);
    setFileSelectorSearch("");
    setFileSelectorPage(1);
  };

  const toggleFileSelectorFolder = (folderId) => {
    setFileSelectorExpandedFolders(prev => ({ ...prev, [folderId]: !prev[folderId] }));
  };

  const renderFileSelectorFolderTree = (folders, level = 0) => {
    return folders.map(folder => {
      const isExpanded = fileSelectorExpandedFolders[folder.id];
      const hasChildren = folder.children && folder.children.length > 0;
      const fileCount = repositoryFiles.filter(f => f.folder_id === folder.id && f.file_type === 'image').length;

      return (
        <div key={folder.id} style={{ marginLeft: `${level * 12}px` }}>
          <div
            className={`flex items-center gap-2 py-2 px-3 rounded cursor-pointer transition-all ${
              fileSelectorFolder === folder.id ? 'bg-blue-100' : 'hover:bg-slate-100'
            }`}
            onClick={() => setFileSelectorFolder(folder.id)}
          >
            {hasChildren ? (
              <button
                onClick={(e) => { e.stopPropagation(); toggleFileSelectorFolder(folder.id); }}
                className="p-0.5 hover:bg-slate-200 rounded"
              >
                {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              </button>
            ) : (
              <span className="w-4" />
            )}
            {isExpanded ? <FolderOpen className="w-4 h-4 text-slate-600" /> : <Folder className="w-4 h-4 text-slate-600" />}
            <span className="flex-1 text-sm">{folder.name}</span>
            <span className="text-xs text-slate-500">({fileCount})</span>
          </div>
          {hasChildren && isExpanded && renderFileSelectorFolderTree(folder.children, level + 1)}
        </div>
      );
    });
  };

  const AlignmentButtons = ({ value, onAlignChange, testIdPrefix = 'align' }) => (
    <div className="flex gap-1">
      {[
        { val: 'left', Icon: AlignLeft },
        { val: 'center', Icon: AlignCenter },
        { val: 'right', Icon: AlignRight }
      ].map(({ val, Icon }) => (
        <button
          key={val}
          type="button"
          onClick={() => onAlignChange(val)}
          data-testid={`button-${testIdPrefix}-${val}`}
          className={`p-2 rounded border ${
            value === val 
              ? 'bg-blue-600 text-white border-blue-600' 
              : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
          }`}
        >
          <Icon className="w-4 h-4" />
        </button>
      ))}
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Background Image Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('image')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
          data-testid="accordion-textoverlay-image"
        >
          <span className="font-semibold text-sm">Background Image</span>
          {expandedSections.image ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.image && (
          <div className="p-4 space-y-4">
            {content.backgroundImage ? (
              <div className="relative">
                <img 
                  src={content.backgroundImage} 
                  alt="Background" 
                  className="w-full h-40 object-cover rounded-lg"
                />
                <Button
                  size="sm"
                  variant="destructive"
                  className="absolute top-2 right-2"
                  onClick={() => updateContent('backgroundImage', '')}
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            ) : (
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
                  
                  <label className="cursor-pointer">
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
                    <input
                      type="file"
                      className="hidden"
                      accept="image/*"
                      onChange={handleImageUpload}
                      disabled={isUploading}
                      data-testid="input-image-upload"
                    />
                  </label>
                </div>
              </div>
            )}

            {content.backgroundImage && (
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowFileSelector(true)}
                >
                  <ImageIcon className="w-4 h-4 mr-2" />
                  Change Image
                </Button>
              </div>
            )}

            {/* Overlay */}
            <div className="p-3 bg-slate-50 rounded-md">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={content.overlay_enabled || false}
                  onChange={(e) => updateContent('overlay_enabled', e.target.checked)}
                  className="rounded border-slate-300"
                />
                <span className="text-sm font-medium">Enable Overlay</span>
              </label>
              
              {content.overlay_enabled && (
                <div className="mt-3 space-y-3">
                  <div className="flex gap-2 items-center">
                    <Label className="text-xs w-16">Color</Label>
                    <input
                      type="color"
                      value={content.overlay_color || '#000000'}
                      onChange={(e) => updateContent('overlay_color', e.target.value)}
                      className="w-10 h-8 px-1 py-1 border border-slate-300 rounded cursor-pointer"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Overlay Opacity: {content.overlay_opacity || 30}%</Label>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={content.overlay_opacity || 30}
                      onChange={(e) => updateContent('overlay_opacity', parseInt(e.target.value))}
                      className="w-full"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Min Height */}
            <div>
              <Label className="text-xs">Minimum Height: {content.min_height || 400}px</Label>
              <input
                type="range"
                min="200"
                max="800"
                value={content.min_height || 400}
                onChange={(e) => updateContent('min_height', parseInt(e.target.value))}
                className="w-full"
              />
            </div>
          </div>
        )}
      </div>

      {/* Header Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('header')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
          data-testid="accordion-textoverlay-header"
        >
          <span className="font-semibold text-sm">Header</span>
          {expandedSections.header ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.header && (
          <div className="p-4 space-y-4">
            <div>
              <Label className="text-xs mb-1 block">Header Text</Label>
              <Input
                value={content.header || ''}
                onChange={(e) => updateContent('header', e.target.value)}
                placeholder="Enter header text"
                data-testid="input-header-text"
              />
            </div>

            <div className="flex items-center justify-between">
              <Label className="text-xs">Alignment</Label>
              <AlignmentButtons
                value={content.header_align || 'left'}
                onAlignChange={(val) => updateContent('header_align', val)}
                testIdPrefix="header-align"
              />
            </div>

            <TypographyStyleSelector
              value={content.header_typography_style_id}
              onChange={(styleId, style) => {
                const updates = { header_typography_style_id: styleId };
                if (style) {
                  const mapped = applyTypographyStyle(style);
                  if (mapped.font_family) updates.header_font_family = mapped.font_family;
                  if (mapped.font_size) updates.header_font_size = mapped.font_size;
                  if (mapped.font_weight) updates.header_font_weight = mapped.font_weight;
                  if (mapped.line_height) updates.header_line_height = mapped.line_height;
                  if (mapped.letter_spacing !== undefined) updates.header_letter_spacing = mapped.letter_spacing;
                  if (mapped.color) updates.header_color = mapped.color;
                }
                updateMultipleContent(updates);
              }}
              label="Header Typography Style"
            />

            <div>
              <Label className="text-xs mb-1 block">Header Text Color</Label>
              <div className="flex gap-2 items-center">
                <input
                  type="color"
                  value={content.header_color || '#1e293b'}
                  onChange={(e) => updateContent('header_color', e.target.value)}
                  className="w-10 h-8 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                  data-testid="input-header-color"
                />
                <Input
                  type="text"
                  value={content.header_color || '#1e293b'}
                  onChange={(e) => updateContent('header_color', e.target.value)}
                  className="flex-1 font-mono text-xs h-8"
                  placeholder="#1e293b"
                />
              </div>
            </div>

            <details className="text-xs">
              <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
              <div className="mt-3 space-y-3 p-3 bg-slate-50 rounded-md">
                <div>
                  <Label className="text-xs">Font Family</Label>
                  <select
                    value={content.header_font_family || 'Poppins'}
                    onChange={(e) => updateContent('header_font_family', e.target.value)}
                    className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                  >
                    {fontFamilies.map(font => (
                      <option key={font} value={font}>{font}</option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">Font Size: {content.header_font_size || 32}px</Label>
                    <input
                      type="range"
                      min="16"
                      max="72"
                      value={content.header_font_size || 32}
                      onChange={(e) => updateContent('header_font_size', parseInt(e.target.value))}
                      className="w-full"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Font Weight</Label>
                    <select
                      value={content.header_font_weight || 700}
                      onChange={(e) => updateContent('header_font_weight', parseInt(e.target.value))}
                      className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                    >
                      {fontWeights.map(w => (
                        <option key={w.value} value={w.value}>{w.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">Line Height: {content.header_line_height || 1.2}</Label>
                    <input
                      type="range"
                      min="0.8"
                      max="2"
                      step="0.1"
                      value={content.header_line_height || 1.2}
                      onChange={(e) => updateContent('header_line_height', parseFloat(e.target.value))}
                      className="w-full"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Letter Spacing: {content.header_letter_spacing || 0}px</Label>
                    <input
                      type="range"
                      min="-2"
                      max="10"
                      step="0.5"
                      value={content.header_letter_spacing || 0}
                      onChange={(e) => updateContent('header_letter_spacing', parseFloat(e.target.value))}
                      className="w-full"
                    />
                  </div>
                </div>
              </div>
            </details>
          </div>
        )}
      </div>

      {/* Content Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('content')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
          data-testid="accordion-textoverlay-content"
        >
          <span className="font-semibold text-sm">Text Content</span>
          {expandedSections.content ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.content && (
          <div className="p-4 space-y-4">
            <div>
              <Label className="text-xs mb-1 block">Content</Label>
              <div className="text-overlay-quill-editor border border-slate-300 rounded-md overflow-hidden bg-white">
                <ReactQuill
                  theme="snow"
                  value={content.text || ''}
                  onChange={(value) => updateContent('text', value)}
                  modules={textOverlayQuillModules}
                  placeholder="Enter text content..."
                  style={{ minHeight: '120px' }}
                />
              </div>
            </div>

            <div className="flex items-center justify-between">
              <Label className="text-xs">Alignment</Label>
              <AlignmentButtons
                value={content.content_align || 'left'}
                onAlignChange={(val) => updateContent('content_align', val)}
                testIdPrefix="content-align"
              />
            </div>

            <TypographyStyleSelector
              value={content.content_typography_style_id}
              onChange={(styleId, style) => {
                const updates = { content_typography_style_id: styleId };
                if (style) {
                  const mapped = applyTypographyStyle(style);
                  if (mapped.font_family) updates.content_font_family = mapped.font_family;
                  if (mapped.font_size) updates.content_font_size = mapped.font_size;
                  if (mapped.font_weight) updates.content_font_weight = mapped.font_weight;
                  if (mapped.line_height) updates.content_line_height = mapped.line_height;
                  if (mapped.letter_spacing !== undefined) updates.content_letter_spacing = mapped.letter_spacing;
                  if (mapped.color) updates.content_color = mapped.color;
                }
                updateMultipleContent(updates);
              }}
              label="Content Typography Style"
            />

            <div>
              <Label className="text-xs mb-1 block">Content Text Color</Label>
              <div className="flex gap-2 items-center">
                <input
                  type="color"
                  value={content.content_color || '#475569'}
                  onChange={(e) => updateContent('content_color', e.target.value)}
                  className="w-10 h-8 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                  data-testid="input-content-color"
                />
                <Input
                  type="text"
                  value={content.content_color || '#475569'}
                  onChange={(e) => updateContent('content_color', e.target.value)}
                  className="flex-1 font-mono text-xs h-8"
                  placeholder="#475569"
                />
              </div>
            </div>

            <details className="text-xs">
              <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
              <div className="mt-3 space-y-3 p-3 bg-slate-50 rounded-md">
                <div>
                  <Label className="text-xs">Font Family</Label>
                  <select
                    value={content.content_font_family || 'Poppins'}
                    onChange={(e) => updateContent('content_font_family', e.target.value)}
                    className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                  >
                    {fontFamilies.map(font => (
                      <option key={font} value={font}>{font}</option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">Font Size: {content.content_font_size || 16}px</Label>
                    <input
                      type="range"
                      min="12"
                      max="32"
                      value={content.content_font_size || 16}
                      onChange={(e) => updateContent('content_font_size', parseInt(e.target.value))}
                      className="w-full"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Font Weight</Label>
                    <select
                      value={content.content_font_weight || 400}
                      onChange={(e) => updateContent('content_font_weight', parseInt(e.target.value))}
                      className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                    >
                      {fontWeights.map(w => (
                        <option key={w.value} value={w.value}>{w.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">Line Height: {content.content_line_height || 1.6}</Label>
                    <input
                      type="range"
                      min="1"
                      max="2.5"
                      step="0.1"
                      value={content.content_line_height || 1.6}
                      onChange={(e) => updateContent('content_line_height', parseFloat(e.target.value))}
                      className="w-full"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Letter Spacing: {content.content_letter_spacing || 0}px</Label>
                    <input
                      type="range"
                      min="-1"
                      max="5"
                      step="0.25"
                      value={content.content_letter_spacing || 0}
                      onChange={(e) => updateContent('content_letter_spacing', parseFloat(e.target.value))}
                      className="w-full"
                    />
                  </div>
                </div>
              </div>
            </details>
          </div>
        )}
      </div>

      {/* Layout Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('layout')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
          data-testid="accordion-textoverlay-layout"
        >
          <span className="font-semibold text-sm">Content Box & Layout</span>
          {expandedSections.layout ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.layout && (
          <div className="p-4 space-y-4">
            {/* Content Box Width */}
            <div>
              <Label className="text-xs">Content Box Width: {content.overlay_width || 50}%</Label>
              <input
                type="range"
                min="20"
                max="100"
                step="5"
                value={content.overlay_width || 50}
                onChange={(e) => updateContent('overlay_width', parseInt(e.target.value))}
                className="w-full"
                data-testid="slider-overlay-width"
              />
            </div>

            {/* Content Box Horizontal Position */}
            <div>
              <Label className="text-xs mb-1 block">Content Box Horizontal Position</Label>
              <select 
                value={content.textPosition || 'left'} 
                onChange={(e) => updateContent('textPosition', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
                data-testid="select-horizontal-position"
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </div>

            {/* Content Box Vertical Position */}
            <div>
              <Label className="text-xs mb-1 block">Content Box Vertical Position</Label>
              <select 
                value={content.overlay_vertical_align || 'center'} 
                onChange={(e) => updateContent('overlay_vertical_align', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
                data-testid="select-vertical-position"
              >
                <option value="top">Top</option>
                <option value="center">Center</option>
                <option value="bottom">Bottom</option>
              </select>
            </div>

            {/* Text Vertical Alignment within Content Box */}
            <div>
              <Label className="text-xs mb-1 block">Text Vertical Alignment (within box)</Label>
              <select 
                value={content.text_vertical_align || 'top'} 
                onChange={(e) => updateContent('text_vertical_align', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
                data-testid="select-text-vertical-align"
              >
                <option value="top">Top</option>
                <option value="center">Center</option>
                <option value="bottom">Bottom</option>
              </select>
            </div>

            <div>
              <Label className="text-xs mb-1 block">Content Box Background</Label>
              <div className="flex gap-2 items-center">
                <input
                  type="color"
                  value={content.backgroundColor || '#ffffff'}
                  onChange={(e) => updateContent('backgroundColor', e.target.value)}
                  className="w-10 h-8 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                />
                <Input
                  type="text"
                  value={content.backgroundColor || '#ffffff'}
                  onChange={(e) => updateContent('backgroundColor', e.target.value)}
                  className="flex-1 font-mono text-xs h-8"
                  placeholder="#ffffff"
                />
              </div>
            </div>

            <div>
              <Label className="text-xs">Box Opacity: {Math.round((content.opacity !== undefined ? content.opacity : 1) * 100)}%</Label>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={content.opacity !== undefined ? content.opacity : 1}
                onChange={(e) => updateContent('opacity', parseFloat(e.target.value))}
                className="w-full"
              />
            </div>

            <div>
              <Label className="text-xs">Box Corner Radius: {content.content_box_border_radius || 8}px</Label>
              <input
                type="range"
                min="0"
                max="32"
                value={content.content_box_border_radius || 8}
                onChange={(e) => updateContent('content_box_border_radius', parseInt(e.target.value))}
                className="w-full"
              />
            </div>

            <div>
              <Label className="text-xs mb-1 block">Box Border Style</Label>
              <select 
                value={content.borderStyle || 'none'} 
                onChange={(e) => updateContent('borderStyle', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
              >
                <option value="none">None</option>
                <option value="solid">Solid</option>
                <option value="dashed">Dashed</option>
                <option value="dotted">Dotted</option>
              </select>
            </div>

            {content.borderStyle && content.borderStyle !== 'none' && (
              <div>
                <Label className="text-xs mb-1 block">Box Border Color</Label>
                <div className="flex gap-2 items-center">
                  <input
                    type="color"
                    value={content.borderColor || '#000000'}
                    onChange={(e) => updateContent('borderColor', e.target.value)}
                    className="w-10 h-8 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                  />
                  <Input
                    type="text"
                    value={content.borderColor || '#000000'}
                    onChange={(e) => updateContent('borderColor', e.target.value)}
                    className="flex-1 font-mono text-xs h-8"
                    placeholder="#000000"
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Image Effects Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('imageEffects')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
          data-testid="accordion-textoverlay-effects"
        >
          <span className="font-semibold text-sm">Image Effects</span>
          {expandedSections.imageEffects ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.imageEffects && (
          <div className="p-4 space-y-4">
            {/* Border Radius */}
            <div>
              <Label className="text-xs">Image Corner Radius: {content.image_border_radius || 0}px</Label>
              <input
                type="range"
                min="0"
                max="50"
                value={content.image_border_radius || 0}
                onChange={(e) => updateContent('image_border_radius', parseInt(e.target.value))}
                className="w-full"
              />
            </div>

            {/* Border */}
            <div className="p-3 bg-slate-50 rounded-md">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={content.image_border_enabled || false}
                  onChange={(e) => updateContent('image_border_enabled', e.target.checked)}
                  className="rounded border-slate-300"
                />
                <span className="text-sm font-medium">Enable Border</span>
              </label>
              
              {content.image_border_enabled && (
                <div className="mt-3 space-y-3">
                  <div className="flex gap-2 items-center">
                    <Label className="text-xs w-16">Color</Label>
                    <input
                      type="color"
                      value={content.image_border_color || '#e2e8f0'}
                      onChange={(e) => updateContent('image_border_color', e.target.value)}
                      className="w-10 h-8 px-1 py-1 border border-slate-300 rounded cursor-pointer"
                    />
                    <Input
                      value={content.image_border_color || '#e2e8f0'}
                      onChange={(e) => updateContent('image_border_color', e.target.value)}
                      className="flex-1 font-mono text-xs h-8"
                    />
                  </div>
                  <div className="flex gap-2 items-center">
                    <Label className="text-xs w-16">Width</Label>
                    <select
                      value={content.image_border_width || 2}
                      onChange={(e) => updateContent('image_border_width', parseInt(e.target.value))}
                      className="flex-1 px-2 py-1 border border-slate-300 rounded-md text-sm"
                    >
                      <option value={1}>1px - Thin</option>
                      <option value={2}>2px - Normal</option>
                      <option value={3}>3px - Medium</option>
                      <option value={4}>4px - Thick</option>
                      <option value={5}>5px - Heavy</option>
                      <option value={6}>6px - Extra Heavy</option>
                    </select>
                  </div>
                </div>
              )}
            </div>

            {/* Drop Shadow */}
            <div className="p-3 bg-slate-50 rounded-md">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={content.image_shadow_enabled || false}
                  onChange={(e) => updateContent('image_shadow_enabled', e.target.checked)}
                  className="rounded border-slate-300"
                />
                <span className="text-sm font-medium">Enable Drop Shadow</span>
              </label>
              
              {content.image_shadow_enabled && (
                <div className="mt-3 space-y-3">
                  <div>
                    <Label className="text-xs mb-1 block">Shadow Size</Label>
                    <select
                      value={content.image_shadow_size || 'medium'}
                      onChange={(e) => updateContent('image_shadow_size', e.target.value)}
                      className="w-full px-2 py-1 border border-slate-300 rounded-md text-sm"
                    >
                      <option value="small">Small - Subtle</option>
                      <option value="medium">Medium - Normal</option>
                      <option value="large">Large - Prominent</option>
                      <option value="xl">Extra Large - Dramatic</option>
                    </select>
                  </div>
                  <div className="flex gap-2 items-center">
                    <Label className="text-xs w-16">Color</Label>
                    <select
                      value={content.image_shadow_color || 'rgba(0,0,0,0.15)'}
                      onChange={(e) => updateContent('image_shadow_color', e.target.value)}
                      className="flex-1 px-2 py-1 border border-slate-300 rounded-md text-sm"
                    >
                      <option value="rgba(0,0,0,0.1)">Light Gray</option>
                      <option value="rgba(0,0,0,0.15)">Medium Gray</option>
                      <option value="rgba(0,0,0,0.25)">Dark Gray</option>
                      <option value="rgba(0,0,0,0.4)">Very Dark</option>
                      <option value="rgba(59,130,246,0.3)">Blue Tint</option>
                      <option value="rgba(139,92,246,0.3)">Purple Tint</option>
                    </select>
                  </div>
                </div>
              )}
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
                  placeholder="Search images..."
                  value={fileSelectorSearch}
                  onChange={(e) => setFileSelectorSearch(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>
          </DialogHeader>

          <div className="grid md:grid-cols-4 gap-4 py-4 overflow-hidden min-h-0">
            <div className="md:col-span-1 border-r border-slate-200 pr-4 overflow-y-auto">
              <h3 className="text-sm font-semibold text-slate-700 mb-3">Folders</h3>
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
                      className={`text-xs ${idx === fileSelectorBreadcrumb.length - 1 ? 'text-blue-600 font-medium' : 'text-slate-600 hover:text-slate-900'}`}
                    >
                      {folder.name}
                    </button>
                  </span>
                ))}
              </div>
              <div className="border border-slate-200 rounded-lg p-2 max-h-96 overflow-y-auto">
                <div
                  className={`flex items-center gap-2 py-2 px-3 rounded cursor-pointer transition-all ${fileSelectorFolder === null ? 'bg-blue-100' : 'hover:bg-slate-100'}`}
                  onClick={() => setFileSelectorFolder(null)}
                >
                  <FolderOpen className="w-4 h-4 text-slate-600" />
                  <span className="flex-1 text-sm font-medium">Root</span>
                  <span className="text-xs text-slate-500">({repositoryFiles.filter(f => !f.folder_id && f.file_type === 'image').length})</span>
                </div>
                {renderFileSelectorFolderTree(fileSelectorFolderHierarchy)}
              </div>
            </div>

            <div className="md:col-span-3 flex flex-col min-h-0">
              <div className="flex items-center justify-between mb-3 text-sm text-slate-600">
                <span>{filteredRepositoryFiles.length} image{filteredRepositoryFiles.length !== 1 ? 's' : ''}</span>
                {fileSelectorTotalPages > 1 && <span>Page {fileSelectorPage} of {fileSelectorTotalPages}</span>}
              </div>

              <div className="flex-1 overflow-y-auto min-h-0">
                {filteredRepositoryFiles.length === 0 ? (
                  <div className="text-center py-12">
                    <FileText className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                    <p className="text-slate-600">No images found</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                    {paginatedRepositoryFiles.map((file) => (
                      <button
                        key={file.id}
                        onClick={() => handleSelectFile(file.file_url)}
                        className="text-left border-2 border-slate-200 rounded-lg hover:border-blue-500 transition-colors p-2"
                      >
                        <img src={file.file_url} alt={file.file_name} className="w-full h-32 object-cover rounded mb-2" />
                        <p className="text-sm font-medium text-slate-900 truncate">{file.file_name}</p>
                      </button>
                    ))}
                  </div>
                )}
              </div>

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
                  <span className="text-sm">{fileSelectorPage} / {fileSelectorTotalPages}</span>
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
            <Button variant="outline" onClick={() => setShowFileSelector(false)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export { IEditTextOverlayImageElement as IEditTextOverlayImageElementRenderer };
