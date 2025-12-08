import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { ChevronUp, ChevronDown, Upload, X } from "lucide-react";
import WallOfFameDisplay from "../../walloffame/WallOfFameDisplay";
import TypographyStyleSelector, { applyTypographyStyle } from "../TypographyStyleSelector";
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';

const wallOfFameQuillModules = {
  toolbar: [
    [{ 'header': [1, 2, 3, false] }],
    ['bold', 'italic', 'underline', 'strike'],
    [{ 'color': [] }, { 'background': [] }],
    [{ 'align': [] }],
    ['link'],
    ['clean']
  ]
};

export function IEditWallOfFameElementEditor({ element, onChange }) {
  const [isUploading, setIsUploading] = useState(false);
  const [expandedSections, setExpandedSections] = useState({
    section: true,
    background: false,
    textContent: false,
    titleSettings: false,
    cardLayout: false
  });

  const toggleSection = (section) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const { data: sections = [] } = useQuery({
    queryKey: ['wall-of-fame-sections-selector'],
    queryFn: () => base44.entities.WallOfFameSection.list(),
  });

  const activeSections = sections.filter(s => s.is_active).sort((a, b) => (a.display_order || 0) - (b.display_order || 0));

  const content = element.content || {};
  const backgroundType = content.background_type || 'none';

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

  const renderTypographyControls = (prefix, label) => {
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

    return (
      <div className="space-y-3 mt-3 p-3 bg-slate-50 rounded-md">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">Font Family</Label>
            <select
              value={content[`${prefix}_font_family`] || 'Poppins'}
              onChange={(e) => updateContent(`${prefix}_font_family`, e.target.value)}
              className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-xs"
            >
              {fontFamilies.map(font => (
                <option key={font} value={font}>{font}</option>
              ))}
            </select>
          </div>
          <div>
            <Label className="text-xs">Font Weight</Label>
            <select
              value={content[`${prefix}_font_weight`] || 400}
              onChange={(e) => updateContent(`${prefix}_font_weight`, parseInt(e.target.value))}
              className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-xs"
            >
              {fontWeights.map(weight => (
                <option key={weight.value} value={weight.value}>{weight.label}</option>
              ))}
            </select>
          </div>
        </div>
        
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">Font Size (px)</Label>
            <Input
              type="number"
              value={content[`${prefix}_font_size`] || 16}
              onChange={(e) => updateContent(`${prefix}_font_size`, parseInt(e.target.value) || 16)}
              min="8"
              max="120"
              className="text-xs h-8"
            />
          </div>
          <div>
            <Label className="text-xs">Mobile Font Size (px)</Label>
            <Input
              type="number"
              value={content[`${prefix}_font_size_mobile`] || ''}
              onChange={(e) => updateContent(`${prefix}_font_size_mobile`, e.target.value ? parseInt(e.target.value) : null)}
              min="8"
              max="120"
              placeholder="Auto"
              className="text-xs h-8"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">Line Height</Label>
            <Input
              type="number"
              step="0.1"
              value={content[`${prefix}_line_height`] || 1.5}
              onChange={(e) => updateContent(`${prefix}_line_height`, parseFloat(e.target.value) || 1.5)}
              min="0.8"
              max="3"
              className="text-xs h-8"
            />
          </div>
          <div>
            <Label className="text-xs">Letter Spacing (px)</Label>
            <Input
              type="number"
              step="0.5"
              value={content[`${prefix}_letter_spacing`] || 0}
              onChange={(e) => updateContent(`${prefix}_letter_spacing`, parseFloat(e.target.value) || 0)}
              min="-5"
              max="20"
              className="text-xs h-8"
            />
          </div>
        </div>

        <div>
          <Label className="text-xs">Text Color</Label>
          <div className="flex gap-2 items-center">
            <input
              type="color"
              value={content[`${prefix}_color`] || '#1e293b'}
              onChange={(e) => updateContent(`${prefix}_color`, e.target.value)}
              className="w-10 h-8 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
            />
            <Input
              value={content[`${prefix}_color`] || '#1e293b'}
              onChange={(e) => updateContent(`${prefix}_color`, e.target.value)}
              className="flex-1 font-mono text-xs h-8"
              placeholder="#1e293b"
            />
          </div>
        </div>
      </div>
    );
  };

  const gradientPreview = `linear-gradient(${content.gradient_angle || 135}deg, ${content.gradient_start_color || '#3b82f6'}, ${content.gradient_end_color || '#8b5cf6'})`;

  return (
    <div className="space-y-3">
      {/* Section Selection Accordion */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('section')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
          data-testid="accordion-wof-section"
        >
          <span className="font-semibold text-sm">Section Selection</span>
          {expandedSections.section ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.section && (
          <div className="p-4 space-y-3">
            <div>
              <Label>Wall of Fame Section</Label>
              <Select
                value={content.section_id || ''}
                onValueChange={(value) => updateContent('section_id', value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a section to display" />
                </SelectTrigger>
                <SelectContent>
                  {activeSections.length === 0 ? (
                    <div className="p-2 text-sm text-slate-500">No sections available</div>
                  ) : (
                    activeSections.map(section => (
                      <SelectItem key={section.id} value={section.id}>
                        {section.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              <p className="text-xs text-slate-500 mt-1">
                Choose which Wall of Fame section to display on this page
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Background Settings Accordion */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('background')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
          data-testid="accordion-wof-background"
        >
          <span className="font-semibold text-sm">Background & Layout</span>
          {expandedSections.background ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.background && (
          <div className="p-4 space-y-4">
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
              <div className="space-y-3">
                <div>
                  <Label>Background Image</Label>
                  <div className="space-y-2">
                    <label className="inline-block">
                      <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium cursor-pointer ${
                        isUploading 
                          ? 'bg-slate-300 cursor-not-allowed' 
                          : 'bg-blue-600 hover:bg-blue-700 text-white'
                      }`}>
                        <Upload className="w-4 h-4" />
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
                        className="absolute top-2 right-2 p-1 bg-red-600 hover:bg-red-700 text-white rounded"
                        type="button"
                      >
                        <X className="w-4 h-4" />
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
                      id="wof_overlay_enabled"
                      checked={content.overlay_enabled || false}
                      onChange={(e) => updateContent('overlay_enabled', e.target.checked)}
                      className="rounded"
                    />
                    <label htmlFor="wof_overlay_enabled" className="text-sm font-medium">Enable Overlay</label>
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
              </div>
            )}
          </div>
        )}
      </div>

      {/* Header, Subheader & Content Accordion */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('textContent')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
          data-testid="accordion-wof-text-content"
        >
          <span className="font-semibold text-sm">Header, Subheader & Content</span>
          {expandedSections.textContent ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.textContent && (
          <div className="p-4 space-y-6">
            {/* Heading */}
            <div>
              <h5 className="font-medium text-sm mb-3">Heading</h5>
              <div className="space-y-3">
                <div>
                  <Label className="text-xs">Heading</Label>
                  <div className="wall-of-fame-quill-editor border border-slate-300 rounded-md overflow-hidden bg-white">
                    <ReactQuill
                      theme="snow"
                      value={content.heading_text || ''}
                      onChange={(value) => updateContent('heading_text', value)}
                      modules={wallOfFameQuillModules}
                      placeholder="Enter heading..."
                      style={{ minHeight: '80px' }}
                    />
                  </div>
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
                  label="Typography Style"
                />
                <details className="text-xs">
                  <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
                  {renderTypographyControls('heading', 'Heading Typography')}
                </details>
              </div>
            </div>

            {/* Subheading */}
            <div>
              <h5 className="font-medium text-sm mb-3">Subheading</h5>
              <div className="space-y-3">
                <div>
                  <Label className="text-xs">Subheading</Label>
                  <div className="wall-of-fame-quill-editor border border-slate-300 rounded-md overflow-hidden bg-white">
                    <ReactQuill
                      theme="snow"
                      value={content.subheading_text || ''}
                      onChange={(value) => updateContent('subheading_text', value)}
                      modules={wallOfFameQuillModules}
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
                  label="Typography Style"
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
                  <div className="wall-of-fame-quill-editor border border-slate-300 rounded-md overflow-hidden bg-white">
                    <ReactQuill
                      theme="snow"
                      value={content.body_content || ''}
                      onChange={(value) => updateContent('body_content', value)}
                      modules={wallOfFameQuillModules}
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
                      if (mapped.letter_spacing !== undefined) updates.content_letter_spacing = mapped.letter_spacing;
                      if (mapped.color) updates.content_color = mapped.color;
                    }
                    updateMultipleContent(updates);
                  }}
                  label="Typography Style"
                />
                <details className="text-xs">
                  <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
                  {renderTypographyControls('content', 'Content Typography')}
                </details>
              </div>
            </div>

            {/* Text Alignment */}
            <div>
              <Label>Text Alignment</Label>
              <select
                value={content.text_align || 'center'}
                onChange={(e) => updateContent('text_align', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </div>
          </div>
        )}
      </div>

      {/* Title Settings Accordion (Category Name) */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('titleSettings')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
          data-testid="accordion-wof-title-settings"
        >
          <span className="font-semibold text-sm">Category Title Settings</span>
          {expandedSections.titleSettings ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.titleSettings && (
          <div className="p-4 space-y-4">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="show_category_name"
                checked={content.show_category_name !== false}
                onChange={(e) => updateContent('show_category_name', e.target.checked)}
                className="w-4 h-4 rounded"
              />
              <label htmlFor="show_category_name" className="text-sm font-medium cursor-pointer">
                Show category name
              </label>
            </div>
            <p className="text-xs text-slate-500">
              When enabled, displays the category name (or custom title) above the people cards
            </p>

            <div>
              <Label>Custom Title (Optional)</Label>
              <Input
                value={content.custom_title || ''}
                onChange={(e) => updateContent('custom_title', e.target.value)}
                placeholder="Leave empty to use category name"
                disabled={content.show_category_name === false}
              />
              <p className="text-xs text-slate-500 mt-1">
                If set, this title will be used instead of the category name
              </p>
            </div>

            <TypographyStyleSelector
              value={content.title_typography_style_id || null}
              onChange={(styleId, style) => {
                const updates = { title_typography_style_id: styleId };
                if (style) {
                  const mapped = applyTypographyStyle(style);
                  if (mapped.font_family) updates.title_font_family = mapped.font_family;
                  if (mapped.font_size) updates.title_font_size = mapped.font_size;
                  if (mapped.font_weight) updates.title_font_weight = mapped.font_weight;
                  if (mapped.color) updates.title_color = mapped.color;
                }
                updateMultipleContent(updates);
              }}
              label="Typography Style"
            />

            <details className="text-xs">
              <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
              {renderTypographyControls('title', 'Title Typography')}
            </details>

            <div>
              <Label>Title Alignment</Label>
              <select
                value={content.title_align || 'center'}
                onChange={(e) => updateContent('title_align', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </div>
          </div>
        )}
      </div>

      {/* Card Layout Settings Accordion */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('cardLayout')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
          data-testid="accordion-wof-card-layout"
        >
          <span className="font-semibold text-sm">Card Layout</span>
          {expandedSections.cardLayout ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.cardLayout && (
          <div className="p-4 space-y-4">
            <div>
              <Label>Cards Per Row</Label>
              <select
                value={content.cards_per_row || 4}
                onChange={(e) => updateContent('cards_per_row', parseInt(e.target.value))}
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
              >
                <option value={1}>1 Card</option>
                <option value={2}>2 Cards</option>
                <option value={3}>3 Cards</option>
                <option value={4}>4 Cards</option>
                <option value={5}>5 Cards</option>
                <option value={6}>6 Cards</option>
              </select>
              <p className="text-xs text-slate-500 mt-1">
                Number of cards to display per row on desktop
              </p>
            </div>

            <div>
              <Label>Row Alignment</Label>
              <select
                value={content.row_align || 'center'}
                onChange={(e) => updateContent('row_align', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
              <p className="text-xs text-slate-500 mt-1">
                How to align cards when there are fewer than the maximum per row
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function IEditWallOfFameElementRenderer({ element, content }) {
  const sectionId = element.content?.section_id || content?.section_id;
  const displaySettings = element.content || content || {};
  
  if (!sectionId) {
    return (
      <div className="bg-slate-100 border-2 border-dashed border-slate-300 rounded-lg p-12 text-center">
        <p className="text-slate-600">Please select a Wall of Fame section to display</p>
      </div>
    );
  }

  return (
    <WallOfFameDisplay 
      sectionId={sectionId} 
      showCategoryName={displaySettings.show_category_name !== false}
      customTitle={displaySettings.custom_title}
      titleFontFamily={displaySettings.title_font_family}
      titleFontWeight={displaySettings.title_font_weight}
      titleFontSize={displaySettings.title_font_size}
      titleColor={displaySettings.title_color}
      titleAlign={displaySettings.title_align}
      cardsPerRow={displaySettings.cards_per_row}
      rowAlign={displaySettings.row_align}
      backgroundType={displaySettings.background_type}
      backgroundColor={displaySettings.background_color}
      gradientStartColor={displaySettings.gradient_start_color}
      gradientEndColor={displaySettings.gradient_end_color}
      gradientAngle={displaySettings.gradient_angle}
      backgroundImageUrl={displaySettings.background_image_url}
      backgroundImageFit={displaySettings.background_image_fit}
      overlayEnabled={displaySettings.overlay_enabled}
      overlayColor={displaySettings.overlay_color}
      overlayOpacity={displaySettings.overlay_opacity}
      headingText={displaySettings.heading_text}
      headingFontFamily={displaySettings.heading_font_family}
      headingFontSize={displaySettings.heading_font_size}
      headingFontSizeMobile={displaySettings.heading_font_size_mobile}
      headingFontWeight={displaySettings.heading_font_weight}
      headingLineHeight={displaySettings.heading_line_height}
      headingLetterSpacing={displaySettings.heading_letter_spacing}
      headingColor={displaySettings.heading_color}
      subheadingText={displaySettings.subheading_text}
      subheadingFontFamily={displaySettings.subheading_font_family}
      subheadingFontSize={displaySettings.subheading_font_size}
      subheadingFontSizeMobile={displaySettings.subheading_font_size_mobile}
      subheadingFontWeight={displaySettings.subheading_font_weight}
      subheadingLineHeight={displaySettings.subheading_line_height}
      subheadingLetterSpacing={displaySettings.subheading_letter_spacing}
      subheadingColor={displaySettings.subheading_color}
      bodyContent={displaySettings.body_content}
      contentFontFamily={displaySettings.content_font_family}
      contentFontSize={displaySettings.content_font_size}
      contentFontSizeMobile={displaySettings.content_font_size_mobile}
      contentFontWeight={displaySettings.content_font_weight}
      contentLineHeight={displaySettings.content_line_height}
      contentLetterSpacing={displaySettings.content_letter_spacing}
      contentColor={displaySettings.content_color}
      textAlign={displaySettings.text_align}
    />
  );
}
