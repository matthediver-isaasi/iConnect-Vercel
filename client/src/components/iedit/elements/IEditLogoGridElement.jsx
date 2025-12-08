import { useState, useEffect } from "react";
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import DOMPurify from 'dompurify';
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronUp, Upload, X, Plus, Trash2, GripVertical, Image } from "lucide-react";
import TypographyStyleSelector, { applyTypographyStyle } from "../TypographyStyleSelector";
import { useIsMobile } from "@/hooks/use-mobile";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";

const logoGridQuillModules = {
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

const safeHexColor = (color, fallback = '#000000') => {
  if (!color || typeof color !== 'string') return fallback;
  const trimmed = color.trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(trimmed)) return trimmed;
  if (/^#[0-9A-Fa-f]{3}$/.test(trimmed)) {
    return '#' + trimmed[1] + trimmed[1] + trimmed[2] + trimmed[2] + trimmed[3] + trimmed[3];
  }
  return fallback;
};

export function IEditLogoGridElementRenderer({ content, variant, settings }) {
  const isMobile = useIsMobile();
  
  const {
    background_type = 'none',
    background_color = '#ffffff',
    gradient_start_color = '#3b82f6',
    gradient_end_color = '#8b5cf6',
    gradient_angle = 135,
    background_image_url,
    background_image_fit = 'cover',
    overlay_enabled = false,
    overlay_color = '#000000',
    overlay_opacity = 50,
    heading,
    subheading,
    body_content,
    text_alignment = 'center',
    vertical_padding = 48,
    horizontal_padding = 16,
    logos = [],
    columns_per_row = 4,
    row_alignment = 'center',
    logo_gap = 24,
    show_name_rollover = true
  } = content || {};

  const getBackgroundStyle = () => {
    if (background_type === 'color') {
      return { backgroundColor: background_color };
    }
    if (background_type === 'gradient') {
      return { 
        background: `linear-gradient(${gradient_angle}deg, ${gradient_start_color}, ${gradient_end_color})` 
      };
    }
    return {};
  };

  const hasBackground = background_type && background_type !== 'none';

  const getTextStyle = (prefix) => {
    const fontSize = content?.[`${prefix}_font_size`] || 16;
    const mobileFontSize = content?.[`${prefix}_font_size_mobile`];
    
    return {
      fontFamily: content?.[`${prefix}_font_family`] || 'Poppins',
      fontWeight: content?.[`${prefix}_font_weight`] || 400,
      fontSize: `${(isMobile && mobileFontSize) ? mobileFontSize : fontSize}px`,
      color: content?.[`${prefix}_color`] || '#1e293b',
      letterSpacing: `${content?.[`${prefix}_letter_spacing`] || 0}px`,
      lineHeight: content?.[`${prefix}_line_height`] || 1.5
    };
  };

  const alignmentClass = {
    left: 'text-left',
    center: 'text-center',
    right: 'text-right'
  }[text_alignment] || 'text-center';

  const getGridJustify = () => {
    switch (row_alignment) {
      case 'left': return 'justify-start';
      case 'right': return 'justify-end';
      default: return 'justify-center';
    }
  };

  const getGridCols = () => {
    const cols = parseInt(columns_per_row) || 4;
    switch (cols) {
      case 1: return 'grid-cols-1';
      case 2: return 'grid-cols-1 md:grid-cols-2';
      case 3: return 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3';
      case 4: return 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4';
      case 5: return 'grid-cols-2 md:grid-cols-3 lg:grid-cols-5';
      case 6: return 'grid-cols-2 md:grid-cols-3 lg:grid-cols-6';
      default: return 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4';
    }
  };

  const validLogos = (logos || []).filter(logo => logo && logo.image_url);

  return (
    <div 
      className="relative w-full"
      style={hasBackground && background_type !== 'image' ? getBackgroundStyle() : {}}
    >
      {background_type === 'image' && background_image_url && (
        <>
          <img 
            src={background_image_url} 
            alt="Background" 
            className="absolute inset-0 w-full h-full"
            style={{ objectFit: background_image_fit }}
          />
          {overlay_enabled && (
            <div 
              className="absolute inset-0" 
              style={{ 
                backgroundColor: overlay_color, 
                opacity: parseInt(overlay_opacity) / 100 
              }} 
            />
          )}
        </>
      )}

      <div 
        className="relative max-w-7xl mx-auto"
        style={{ 
          paddingTop: `${vertical_padding}px`, 
          paddingBottom: `${vertical_padding}px`,
          paddingLeft: `${horizontal_padding}px`,
          paddingRight: `${horizontal_padding}px`
        }}
      >
        {(heading || subheading || body_content) && (
          <div className={`mb-8 ${alignmentClass}`}>
            {heading && (
              <h2 style={getTextStyle('heading')} className="m-0 mb-4">
                {heading}
              </h2>
            )}
            {subheading && (
              <div 
                style={getTextStyle('subheading')} 
                className="m-0 mb-4 prose max-w-none"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(subheading) }}
              />
            )}
            {body_content && (
              <div 
                className="prose max-w-none" 
                style={getTextStyle('content')}
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(body_content) }}
              />
            )}
          </div>
        )}

        {validLogos.length > 0 && (
          <div className={`flex ${getGridJustify()}`}>
            <div 
              className={`grid ${getGridCols()} w-full`}
              style={{ gap: `${logo_gap}px` }}
            >
              {validLogos.map((logo, index) => (
                <div 
                  key={index}
                  className="relative aspect-square rounded-lg overflow-hidden bg-slate-100 flex items-center justify-center group"
                >
                  <img
                    src={logo.image_url}
                    alt={logo.name || ''}
                    className={`w-full h-full object-contain p-4 transition-all duration-300 ${
                      show_name_rollover && logo.name ? 'group-hover:opacity-20' : ''
                    }`}
                  />
                  {show_name_rollover && logo.name && (
                    <div className="absolute inset-0 flex items-center justify-center p-3 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                      <span className="text-lg font-bold text-slate-800 text-center leading-tight line-clamp-4">
                        {logo.name}
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {validLogos.length === 0 && (
          <div className="text-center py-8 text-slate-500">
            No logos added yet
          </div>
        )}
      </div>
    </div>
  );
}

export function IEditLogoGridElementEditor({ element, onChange }) {
  const content = element.content || {};
  const [expandedSections, setExpandedSections] = useState({
    background: false,
    textContent: true,
    logos: true,
    layout: false
  });
  const [isUploading, setIsUploading] = useState({});
  const [showFileSelector, setShowFileSelector] = useState(false);
  const [addingLogoIndex, setAddingLogoIndex] = useState(null);
  const [selectedFolder, setSelectedFolder] = useState(null);

  const { data: folders = [] } = useQuery({
    queryKey: ['file-repository-folders'],
    queryFn: () => base44.entities.FileRepositoryFolder.list('name')
  });

  const { data: files = [] } = useQuery({
    queryKey: ['file-repository-files', selectedFolder],
    queryFn: () => base44.entities.FileRepository.list(),
    enabled: showFileSelector
  });

  const filteredFiles = selectedFolder
    ? files.filter(f => String(f.folder_id) === String(selectedFolder))
    : files;

  const imageFiles = filteredFiles.filter(f => {
    const ext = (f.file_url || '').toLowerCase();
    return ext.endsWith('.jpg') || ext.endsWith('.jpeg') || ext.endsWith('.png') || 
           ext.endsWith('.gif') || ext.endsWith('.webp') || ext.endsWith('.svg');
  });

  const updateContent = (key, value) => {
    onChange({ ...element, content: { ...content, [key]: value } });
  };

  const updateMultipleContent = (updates) => {
    onChange({ ...element, content: { ...content, ...updates } });
  };

  const toggleSection = (section) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const handleImageUpload = async (file, field) => {
    if (!file) return;

    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
    if (!allowedTypes.includes(file.type)) {
      toast.error('Please upload a valid image file');
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      toast.error('Image must be smaller than 10MB');
      return;
    }

    setIsUploading(prev => ({ ...prev, [field]: true }));
    try {
      const response = await base44.integrations.Core.UploadFile({ file });
      updateContent(field, response.file_url);
    } catch (error) {
      toast.error('Failed to upload image: ' + error.message);
    } finally {
      setIsUploading(prev => ({ ...prev, [field]: false }));
    }
  };

  const logos = content.logos || [];

  const addLogo = () => {
    if (logos.length >= 20) {
      toast.error('Maximum of 20 logos allowed');
      return;
    }
    setAddingLogoIndex(logos.length);
    setShowFileSelector(true);
  };

  const removeLogo = (index) => {
    const updated = logos.filter((_, i) => i !== index);
    updateContent('logos', updated);
  };

  const updateLogo = (index, key, value) => {
    const updated = [...logos];
    updated[index] = { ...updated[index], [key]: value };
    updateContent('logos', updated);
  };

  const handleFileSelect = (file) => {
    if (addingLogoIndex !== null) {
      const newLogos = [...logos];
      if (addingLogoIndex >= newLogos.length) {
        newLogos.push({ image_url: file.file_url, name: file.display_name || '' });
      } else {
        newLogos[addingLogoIndex] = { ...newLogos[addingLogoIndex], image_url: file.file_url };
      }
      updateContent('logos', newLogos);
    }
    setShowFileSelector(false);
    setAddingLogoIndex(null);
  };

  const backgroundType = content.background_type || 'none';
  const gradientPreview = `linear-gradient(${content.gradient_angle || 135}deg, ${content.gradient_start_color || '#3b82f6'}, ${content.gradient_end_color || '#8b5cf6'})`;

  const renderTypographyControls = (prefix, label, defaultValues = {}) => {
    const defaults = {
      font_family: 'Poppins',
      font_weight: prefix.includes('heading') ? 700 : 400,
      font_size: prefix.includes('heading') ? 32 : (prefix.includes('subheading') ? 20 : 16),
      color: '#1e293b',
      letter_spacing: 0,
      line_height: prefix.includes('heading') ? 1.2 : 1.6,
      ...defaultValues
    };

    return (
      <div className="space-y-3 p-3 bg-white rounded-md border border-slate-200">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">Font Family</Label>
            <select
              value={content[`${prefix}_font_family`] || defaults.font_family}
              onChange={(e) => updateContent(`${prefix}_font_family`, e.target.value)}
              className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
            >
              {fontFamilies.map(font => (
                <option key={font} value={font}>{font}</option>
              ))}
            </select>
          </div>
          <div>
            <Label className="text-xs">Font Weight</Label>
            <select
              value={content[`${prefix}_font_weight`] || defaults.font_weight}
              onChange={(e) => updateContent(`${prefix}_font_weight`, parseInt(e.target.value))}
              className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
            >
              {fontWeights.map(weight => (
                <option key={weight.value} value={weight.value}>{weight.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label className="text-xs">Font Size (px)</Label>
            <Input
              type="number"
              value={content[`${prefix}_font_size`] || defaults.font_size}
              onChange={(e) => updateContent(`${prefix}_font_size`, parseInt(e.target.value) || defaults.font_size)}
              min="10"
              max="120"
              className="h-8"
            />
          </div>
          <div>
            <Label className="text-xs">Mobile Size (px)</Label>
            <Input
              type="number"
              value={content[`${prefix}_font_size_mobile`] || ''}
              onChange={(e) => updateContent(`${prefix}_font_size_mobile`, e.target.value ? parseInt(e.target.value) : '')}
              min="10"
              max="120"
              placeholder="Same"
              className="h-8"
            />
          </div>
          <div>
            <Label className="text-xs">Text Color</Label>
            <input
              type="color"
              value={safeHexColor(content[`${prefix}_color`], defaults.color)}
              onChange={(e) => updateContent(`${prefix}_color`, e.target.value)}
              className="w-full h-8 px-0.5 py-0.5 border border-slate-300 rounded cursor-pointer"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">Letter Spacing (px)</Label>
            <Input
              type="number"
              step="0.5"
              value={content[`${prefix}_letter_spacing`] || defaults.letter_spacing}
              onChange={(e) => updateContent(`${prefix}_letter_spacing`, parseFloat(e.target.value) || 0)}
              min="-2"
              max="10"
              className="h-8"
            />
          </div>
          <div>
            <Label className="text-xs">Line Height</Label>
            <Input
              type="number"
              step="0.1"
              value={content[`${prefix}_line_height`] || defaults.line_height}
              onChange={(e) => updateContent(`${prefix}_line_height`, parseFloat(e.target.value) || defaults.line_height)}
              min="0.8"
              max="3"
              className="h-8"
            />
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {/* Background Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('background')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
        >
          <span className="font-semibold text-sm">Section Background</span>
          {expandedSections.background ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.background && (
          <div className="p-4 space-y-4">
            <div>
              <Label>Background Type</Label>
              <select
                value={backgroundType}
                onChange={(e) => updateContent('background_type', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
              >
                <option value="none">None</option>
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
                    value={safeHexColor(content.background_color, '#ffffff')}
                    onChange={(e) => updateContent('background_color', e.target.value)}
                    className="w-16 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                  />
                  <Input
                    value={content.background_color || '#ffffff'}
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
                    <Label className="text-xs">Start Color</Label>
                    <div className="flex gap-2 items-center">
                      <input
                        type="color"
                        value={safeHexColor(content.gradient_start_color, '#3b82f6')}
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
                    <Label className="text-xs">End Color</Label>
                    <div className="flex gap-2 items-center">
                      <input
                        type="color"
                        value={safeHexColor(content.gradient_end_color, '#8b5cf6')}
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
                  <Label className="text-xs">Angle: {content.gradient_angle || 135}°</Label>
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
              <div className="space-y-3">
                <div>
                  <Label>Background Image</Label>
                  <label className="inline-block mt-2">
                    <div className={`px-4 py-2 rounded-md text-sm font-medium cursor-pointer inline-flex items-center gap-2 ${
                      isUploading.background_image_url 
                        ? 'bg-slate-300 cursor-not-allowed' 
                        : 'bg-blue-600 hover:bg-blue-700 text-white'
                    }`}>
                      <Upload className="w-4 h-4" />
                      {isUploading.background_image_url ? 'Uploading...' : 'Upload Image'}
                    </div>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleImageUpload(file, 'background_image_url');
                        e.target.value = '';
                      }}
                      className="hidden"
                      disabled={isUploading.background_image_url}
                    />
                  </label>
                </div>

                {content.background_image_url && (
                  <div className="relative">
                    <img
                      src={content.background_image_url}
                      alt="Background preview"
                      className="w-full h-32 object-cover rounded"
                    />
                    <button
                      onClick={() => updateContent('background_image_url', '')}
                      className="absolute top-2 right-2 p-1 bg-red-600 hover:bg-red-700 text-white rounded"
                      type="button"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                )}

                <div>
                  <Label className="text-xs">Image Fit</Label>
                  <select
                    value={content.background_image_fit || 'cover'}
                    onChange={(e) => updateContent('background_image_fit', e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                  >
                    <option value="cover">Cover</option>
                    <option value="contain">Contain</option>
                    <option value="fill">Fill</option>
                  </select>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="overlay-enabled"
                    checked={content.overlay_enabled || false}
                    onChange={(e) => updateContent('overlay_enabled', e.target.checked)}
                    className="w-4 h-4"
                  />
                  <Label htmlFor="overlay-enabled" className="cursor-pointer">Enable Overlay</Label>
                </div>

                {content.overlay_enabled && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs">Overlay Color</Label>
                      <input
                        type="color"
                        value={safeHexColor(content.overlay_color, '#000000')}
                        onChange={(e) => updateContent('overlay_color', e.target.value)}
                        className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Overlay Opacity: {content.overlay_opacity || 50}%</Label>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={content.overlay_opacity || 50}
                        onChange={(e) => updateContent('overlay_opacity', parseInt(e.target.value))}
                        className="w-full"
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Padding Controls */}
            <div className="grid grid-cols-2 gap-4 pt-3 border-t">
              <div>
                <Label className="text-xs">Vertical Padding: {content.vertical_padding || 48}px</Label>
                <input
                  type="range"
                  min="0"
                  max="120"
                  value={content.vertical_padding || 48}
                  onChange={(e) => updateContent('vertical_padding', parseInt(e.target.value))}
                  className="w-full"
                />
              </div>
              <div>
                <Label className="text-xs">Horizontal Padding: {content.horizontal_padding || 16}px</Label>
                <input
                  type="range"
                  min="0"
                  max="64"
                  value={content.horizontal_padding || 16}
                  onChange={(e) => updateContent('horizontal_padding', parseInt(e.target.value))}
                  className="w-full"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Text Content Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('textContent')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
        >
          <span className="font-semibold text-sm">Header, Subheader & Content</span>
          {expandedSections.textContent ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.textContent && (
          <div className="p-4 space-y-4">
            <div>
              <Label className="text-xs">Text Alignment</Label>
              <select
                value={content.text_alignment || 'center'}
                onChange={(e) => updateContent('text_alignment', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </div>

            {/* Heading */}
            <div className="border-b pb-4">
              <h5 className="font-medium text-sm mb-3">Heading</h5>
              <div className="space-y-3">
                <div>
                  <Label className="text-xs">Heading Text</Label>
                  <Input
                    value={content.heading || ''}
                    onChange={(e) => updateContent('heading', e.target.value)}
                    placeholder="Enter heading..."
                  />
                </div>
                <TypographyStyleSelector
                  value={content.heading_typography_style_id || null}
                  onChange={(styleId, style) => {
                    const updates = { heading_typography_style_id: styleId };
                    if (style) {
                      const mapped = applyTypographyStyle(style);
                      if (mapped.font_family) updates.heading_font_family = mapped.font_family;
                      if (mapped.font_size) updates.heading_font_size = mapped.font_size;
                      if (mapped.font_size_mobile) updates.heading_font_size_mobile = mapped.font_size_mobile;
                      if (mapped.font_weight) updates.heading_font_weight = mapped.font_weight;
                      if (mapped.line_height) updates.heading_line_height = mapped.line_height;
                      if (mapped.letter_spacing !== undefined) updates.heading_letter_spacing = mapped.letter_spacing;
                      if (mapped.color) updates.heading_color = mapped.color;
                    }
                    updateMultipleContent(updates);
                  }}
                  filterTypes={['h1', 'h2']}
                  label="Heading Typography Style"
                />
                <details className="text-xs">
                  <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
                  {renderTypographyControls('heading', 'Heading Typography')}
                </details>
              </div>
            </div>

            {/* Subheading */}
            <div className="border-b pb-4">
              <h5 className="font-medium text-sm mb-3">Subheading</h5>
              <div className="space-y-3">
                <div>
                  <Label className="text-xs">Subheading Text</Label>
                  <div className="logo-grid-quill-editor border border-slate-300 rounded-md overflow-hidden bg-white">
                    <ReactQuill
                      theme="snow"
                      value={content.subheading || ''}
                      onChange={(value) => updateContent('subheading', value)}
                      modules={logoGridQuillModules}
                      placeholder="Enter subheading..."
                      style={{ minHeight: '80px' }}
                    />
                  </div>
                </div>
                <TypographyStyleSelector
                  value={content.subheading_typography_style_id || null}
                  onChange={(styleId, style) => {
                    const updates = { subheading_typography_style_id: styleId };
                    if (style) {
                      const mapped = applyTypographyStyle(style);
                      if (mapped.font_family) updates.subheading_font_family = mapped.font_family;
                      if (mapped.font_size) updates.subheading_font_size = mapped.font_size;
                      if (mapped.font_size_mobile) updates.subheading_font_size_mobile = mapped.font_size_mobile;
                      if (mapped.font_weight) updates.subheading_font_weight = mapped.font_weight;
                      if (mapped.line_height) updates.subheading_line_height = mapped.line_height;
                      if (mapped.letter_spacing !== undefined) updates.subheading_letter_spacing = mapped.letter_spacing;
                      if (mapped.color) updates.subheading_color = mapped.color;
                    }
                    updateMultipleContent(updates);
                  }}
                  filterTypes={['h3', 'h4']}
                  label="Subheading Typography Style"
                />
                <details className="text-xs">
                  <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
                  {renderTypographyControls('subheading', 'Subheading Typography')}
                </details>
              </div>
            </div>

            {/* Content */}
            <div>
              <h5 className="font-medium text-sm mb-3">Content</h5>
              <div className="space-y-3">
                <div>
                  <Label className="text-xs">Content</Label>
                  <div className="logo-grid-quill-editor border border-slate-300 rounded-md overflow-hidden bg-white">
                    <ReactQuill
                      theme="snow"
                      value={content.body_content || ''}
                      onChange={(value) => updateContent('body_content', value)}
                      modules={logoGridQuillModules}
                      placeholder="Enter content..."
                      style={{ minHeight: '120px' }}
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
                      if (mapped.color) updates.content_color = mapped.color;
                    }
                    updateMultipleContent(updates);
                  }}
                  filterTypes={['paragraph']}
                  label="Content Typography Style"
                />
                <details className="text-xs">
                  <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
                  {renderTypographyControls('content', 'Content Typography')}
                </details>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Logo Grid Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('logos')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
        >
          <span className="font-semibold text-sm">Logos ({logos.length}/20)</span>
          {expandedSections.logos ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.logos && (
          <div className="p-4 space-y-4">
            {/* Layout options */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-xs">Logos Per Row</Label>
                <select
                  value={content.columns_per_row || 4}
                  onChange={(e) => updateContent('columns_per_row', parseInt(e.target.value))}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                >
                  <option value="1">1</option>
                  <option value="2">2</option>
                  <option value="3">3</option>
                  <option value="4">4</option>
                  <option value="5">5</option>
                  <option value="6">6</option>
                </select>
              </div>
              <div>
                <Label className="text-xs">Row Alignment</Label>
                <select
                  value={content.row_alignment || 'center'}
                  onChange={(e) => updateContent('row_alignment', e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                >
                  <option value="left">Left</option>
                  <option value="center">Center</option>
                  <option value="right">Right</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-xs">Gap Between Logos: {content.logo_gap || 24}px</Label>
                <input
                  type="range"
                  min="8"
                  max="64"
                  value={content.logo_gap || 24}
                  onChange={(e) => updateContent('logo_gap', parseInt(e.target.value))}
                  className="w-full"
                />
              </div>
              <div className="flex items-center gap-2 pt-4">
                <input
                  type="checkbox"
                  id="show-name-rollover"
                  checked={content.show_name_rollover !== false}
                  onChange={(e) => updateContent('show_name_rollover', e.target.checked)}
                  className="w-4 h-4"
                />
                <Label htmlFor="show-name-rollover" className="cursor-pointer text-xs">Show Name on Rollover</Label>
              </div>
            </div>

            {/* Logo List */}
            <div className="space-y-3">
              {logos.map((logo, index) => (
                <div key={index} className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg border">
                  <div className="w-16 h-16 bg-white rounded border flex items-center justify-center overflow-hidden shrink-0">
                    {logo.image_url ? (
                      <img src={logo.image_url} alt={logo.name || ''} className="w-full h-full object-contain p-1" />
                    ) : (
                      <Image className="w-6 h-6 text-slate-400" />
                    )}
                  </div>
                  <div className="flex-1 space-y-2">
                    <Input
                      value={logo.name || ''}
                      onChange={(e) => updateLogo(index, 'name', e.target.value)}
                      placeholder="Logo name (for rollover)"
                      className="h-8 text-sm"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setAddingLogoIndex(index);
                        setShowFileSelector(true);
                      }}
                      className="h-7 text-xs"
                    >
                      Change Image
                    </Button>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeLogo(index)}
                    className="shrink-0 text-red-500 hover:text-red-600 hover:bg-red-50"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              ))}

              {logos.length < 20 && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={addLogo}
                  className="w-full"
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Add Logo from File Repository
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* File Selector Dialog */}
      <Dialog open={showFileSelector} onOpenChange={setShowFileSelector}>
        <DialogContent className="max-w-4xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle>Select Logo from File Repository</DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4">
            <div>
              <Label className="text-xs">Filter by Folder</Label>
              <select
                value={selectedFolder || ''}
                onChange={(e) => setSelectedFolder(e.target.value || null)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
              >
                <option value="">All Folders</option>
                {folders.map(folder => (
                  <option key={folder.id} value={folder.id}>{folder.name}</option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-4 gap-4 max-h-96 overflow-y-auto">
              {imageFiles.map(file => (
                <div
                  key={file.id}
                  onClick={() => handleFileSelect(file)}
                  className="cursor-pointer p-2 border rounded-lg hover:border-blue-500 hover:bg-blue-50 transition-colors"
                >
                  <div className="aspect-square bg-slate-100 rounded overflow-hidden mb-2">
                    <img
                      src={file.file_url}
                      alt={file.display_name || file.file_name}
                      className="w-full h-full object-contain p-2"
                    />
                  </div>
                  <p className="text-xs text-center truncate text-slate-600">
                    {file.display_name || file.file_name}
                  </p>
                </div>
              ))}

              {imageFiles.length === 0 && (
                <div className="col-span-4 text-center py-8 text-slate-500">
                  No image files found in the file repository
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default IEditLogoGridElementRenderer;
