import React, { useState, useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { useIsMobile } from "@/hooks/use-mobile";
import { base44 } from "@/api/base44Client";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { 
  ChevronDown, 
  ChevronUp, 
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
  File
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

export function IEditAccordionElementEditor({ element, onChange }) {
  const [isUploading, setIsUploading] = useState(false);
  const [expandedItem, setExpandedItem] = useState(null);
  const [showFilePicker, setShowFilePicker] = useState(null); // { itemIndex, linkIndex }
  const [fileSearchQuery, setFileSearchQuery] = useState('');

  const content = element.content || {};
  const backgroundType = content.background_type || 'none';
  const items = content.items || [];

  // Fetch files from repository
  const { data: files = [], isLoading: filesLoading } = useQuery({
    queryKey: ['file-repository-for-accordion'],
    queryFn: () => base44.entities.FileRepository.list('-created_date'),
    staleTime: 60000
  });

  // Fetch folders for context
  const { data: folders = [] } = useQuery({
    queryKey: ['file-repository-folders-for-accordion'],
    queryFn: () => base44.entities.FileRepositoryFolder.list('display_order'),
    staleTime: 60000
  });

  // Get folder name by ID
  const getFolderName = (folderId) => {
    const folder = folders.find(f => f.id === folderId);
    return folder ? folder.name : 'Root';
  };

  // Filter files based on search
  const filteredFiles = files.filter(file => {
    if (!fileSearchQuery) return true;
    const query = fileSearchQuery.toLowerCase();
    return file.file_name?.toLowerCase().includes(query) ||
           file.description?.toLowerCase().includes(query);
  });

  const updateContent = (key, value) => {
    onChange({
      ...element,
      content: {
        ...content,
        [key]: value
      }
    });
  };

  const updateMultipleContent = (updates) => {
    onChange({
      ...element,
      content: {
        ...content,
        ...updates
      }
    });
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

  const handleFileSelect = (file, itemIndex, linkIndex) => {
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
    setShowFilePicker(null);
    setFileSearchQuery('');
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

  const getFileTypeIcon = (fileType) => {
    switch (fileType) {
      case 'video': return Video;
      case 'image': return Image;
      case 'document': return FileText;
      default: return File;
    }
  };

  const gradientPreview = `linear-gradient(${content.gradient_angle || 135}deg, ${content.gradient_start_color || '#3b82f6'}, ${content.gradient_end_color || '#8b5cf6'})`;

  return (
    <div className="space-y-4">
      {/* Section Header Settings */}
      <div className="border-b pb-4">
        <h4 className="font-semibold text-sm mb-3">Section Header</h4>
        
        <div className="space-y-3">
          <div>
            <Label>Header Title</Label>
            <Input
              value={content.header_title || ''}
              onChange={(e) => updateContent('header_title', e.target.value)}
              placeholder="e.g., Frequently Asked Questions"
            />
          </div>

          <div>
            <Label>Header Subtitle</Label>
            <Input
              value={content.header_subtitle || ''}
              onChange={(e) => updateContent('header_subtitle', e.target.value)}
              placeholder="Optional subtitle text"
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
                if (mapped.font_size_mobile) updates.header_font_size_mobile = mapped.font_size_mobile;
                if (mapped.font_weight) updates.header_font_weight = mapped.font_weight;
                if (mapped.line_height) updates.header_line_height = mapped.line_height;
                if (mapped.letter_spacing !== undefined) updates.header_letter_spacing = mapped.letter_spacing;
                if (mapped.color) updates.header_color = mapped.color;
              }
              updateMultipleContent(updates);
            }}
            filterTypes={['h1', 'h2', 'h3']}
            label="Section Title Typography Style"
          />

          <details className="text-xs">
            <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
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

          <div>
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
            filterTypes={['h3', 'h4']}
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
            filterTypes={['paragraph']}
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
                    {item.title || 'Untitled'}
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
                      <Input
                        value={item.title || ''}
                        onChange={(e) => updateItem(index, 'title', e.target.value)}
                        placeholder="Enter the accordion header text"
                      />
                    </div>
                    <div>
                      <Label>Content / Answer</Label>
                      <Textarea
                        value={item.content || ''}
                        onChange={(e) => updateItem(index, 'content', e.target.value)}
                        placeholder="Enter the accordion content"
                        rows={4}
                      />
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
                                      <div className="flex items-center justify-between">
                                        <Label className="text-xs">Link Target</Label>
                                        <Button
                                          type="button"
                                          variant="outline"
                                          size="sm"
                                          onClick={() => {
                                            setShowFilePicker(
                                              showFilePicker?.itemIndex === index && showFilePicker?.linkIndex === linkIndex
                                                ? null
                                                : { itemIndex: index, linkIndex }
                                            );
                                            setFileSearchQuery('');
                                          }}
                                          className="h-6 text-xs px-2"
                                        >
                                          <FolderOpen className="w-3 h-3 mr-1" />
                                          {link.file_id ? 'Change File' : 'Select File'}
                                        </Button>
                                      </div>
                                      
                                      {/* Show selected file info */}
                                      {link.file_id && link.file_name && (
                                        <div className="flex items-center gap-2 p-2 bg-blue-50 border border-blue-200 rounded-md text-xs">
                                          <File className="w-4 h-4 text-blue-600 flex-shrink-0" />
                                          <span className="flex-1 truncate text-blue-800">{link.file_name}</span>
                                          <button
                                            type="button"
                                            onClick={() => clearFileSelection(index, linkIndex)}
                                            className="p-0.5 hover:bg-blue-100 rounded text-blue-600"
                                          >
                                            <Trash2 className="w-3 h-3" />
                                          </button>
                                        </div>
                                      )}
                                      
                                      {/* File Picker Dropdown */}
                                      {showFilePicker?.itemIndex === index && showFilePicker?.linkIndex === linkIndex && (
                                        <div className="border border-slate-300 rounded-md bg-white shadow-lg max-h-60 overflow-hidden">
                                          <div className="p-2 border-b sticky top-0 bg-white">
                                            <Input
                                              value={fileSearchQuery}
                                              onChange={(e) => setFileSearchQuery(e.target.value)}
                                              placeholder="Search files..."
                                              className="h-7 text-xs"
                                            />
                                          </div>
                                          <div className="max-h-48 overflow-y-auto">
                                            {filesLoading ? (
                                              <p className="p-3 text-xs text-slate-500 text-center">Loading files...</p>
                                            ) : filteredFiles.length === 0 ? (
                                              <p className="p-3 text-xs text-slate-500 text-center">No files found</p>
                                            ) : (
                                              filteredFiles.slice(0, 50).map(file => {
                                                const FileIcon = getFileTypeIcon(file.file_type);
                                                return (
                                                  <button
                                                    key={file.id}
                                                    type="button"
                                                    onClick={() => handleFileSelect(file, index, linkIndex)}
                                                    className="w-full flex items-center gap-2 p-2 hover:bg-slate-50 text-left border-b border-slate-100 last:border-b-0"
                                                  >
                                                    <FileIcon className="w-4 h-4 text-slate-500 flex-shrink-0" />
                                                    <div className="flex-1 min-w-0">
                                                      <p className="text-xs font-medium truncate">{file.file_name}</p>
                                                      <p className="text-[10px] text-slate-400">{getFolderName(file.folder_id)}</p>
                                                    </div>
                                                  </button>
                                                );
                                              })
                                            )}
                                          </div>
                                        </div>
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
          {(content.header_title || content.header_subtitle) && (
            <div className="mb-8">
              {content.header_title && (
                <h2 style={headerStyle} className="mb-2">
                  {content.header_title}
                </h2>
              )}
              {content.header_subtitle && (
                <p 
                  className="text-slate-600"
                  style={{ textAlign: content.header_align || 'center' }}
                >
                  {content.header_subtitle}
                </p>
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
                  <span>{item.title}</span>
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
                    {/* Render content with line breaks preserved */}
                    {item.content?.split('\n').map((line, i) => (
                      <p key={i} className={i > 0 ? 'mt-2' : ''}>
                        {line || '\u00A0'}
                      </p>
                    ))}
                    
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
