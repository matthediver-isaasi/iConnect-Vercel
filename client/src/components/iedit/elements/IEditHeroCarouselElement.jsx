import { useState, useEffect, useRef, useId, useCallback } from "react";
import { base44 } from "@/api/base44Client";
import TypographyStyleSelector, { applyTypographyStyle, useTypographyStyles } from "../TypographyStyleSelector";
import ReactQuill from "react-quill";
import "react-quill/dist/quill.snow.css";
import DOMPurify from "dompurify";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Plus, Trash2, Upload, Loader2, GripVertical, Copy, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";

const fontFamilies = [
  'Poppins', 'Degular Medium', 'Degular Bold', 'Degular Semibold',
  'Inter', 'Arial', 'Georgia', 'Times New Roman'
];

const fontWeights = [
  { value: 300, label: 'Light' },
  { value: 400, label: 'Regular' },
  { value: 500, label: 'Medium' },
  { value: 600, label: 'Semibold' },
  { value: 700, label: 'Bold' },
  { value: 800, label: 'Extra Bold' }
];

const safeHexColor = (color, fallback = '#ffffff') => {
  if (!color || typeof color !== 'string') return fallback;
  const trimmed = color.trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(trimmed)) return trimmed;
  if (/^#[0-9A-Fa-f]{3}$/.test(trimmed)) {
    return '#' + trimmed[1] + trimmed[1] + trimmed[2] + trimmed[2] + trimmed[3] + trimmed[3];
  }
  return fallback;
};

const heroQuillModules = {
  toolbar: {
    container: [
      [{ 'header': [1, 2, 3, false] }],
      ['bold', 'italic', 'underline', 'strike'],
      [{ 'list': 'ordered' }, { 'list': 'bullet' }],
      [{ 'indent': '-1' }, { 'indent': '+1' }],
      ['blockquote'],
      ['link'],
      ['clean']
    ]
  }
};

export function IEditHeroCarouselElementEditor({ element, onChange }) {
  const content = element.content || { slides: [] };
  const [uploadingIndex, setUploadingIndex] = useState(null);
  const [expandedSlide, setExpandedSlide] = useState(0);
  const [expandedSections, setExpandedSections] = useState({
    slides: true,
    typography: false,
    layout: false,
    carousel: false
  });

  const toggleSection = (section) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const updateContent = (key, value) => {
    onChange({ ...element, content: { ...content, [key]: value } });
  };

  const updateMultipleContent = (updates) => {
    onChange({ ...element, content: { ...content, ...updates } });
  };

  const addSlide = () => {
    const newSlide = {
      id: `slide-${Date.now()}`,
      headerText: '',
      subheadingText: '',
      contentText: '',
      ctaText: '',
      ctaLink: '',
      backgroundImage: '',
      overlayColor: '#000000',
      overlayOpacity: 40
    };
    updateContent('slides', [...(content.slides || []), newSlide]);
    setExpandedSlide((content.slides || []).length);
  };

  const removeSlide = (index) => {
    const slides = [...(content.slides || [])];
    slides.splice(index, 1);
    updateContent('slides', slides);
    if (expandedSlide >= slides.length) setExpandedSlide(Math.max(0, slides.length - 1));
  };

  const duplicateSlide = (index) => {
    const slides = [...(content.slides || [])];
    const slideToDuplicate = { ...slides[index], id: `slide-${Date.now()}` };
    slides.splice(index + 1, 0, slideToDuplicate);
    updateContent('slides', slides);
    setExpandedSlide(index + 1);
    toast.success('Slide duplicated');
  };

  const updateSlide = (index, field, value) => {
    const slides = [...(content.slides || [])];
    slides[index] = { ...slides[index], [field]: value };
    updateContent('slides', slides);
  };

  const handleImageUpload = async (index, file) => {
    if (!file) return;
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
    if (!allowedTypes.includes(file.type)) { toast.error('Please upload a valid image file'); return; }
    if (file.size > 10 * 1024 * 1024) { toast.error('Image must be smaller than 10MB'); return; }

    setUploadingIndex(index);
    try {
      const response = await base44.integrations.Core.UploadFile({ file });
      updateSlide(index, 'backgroundImage', response.file_url);
      toast.success('Image uploaded');
    } catch (error) {
      toast.error('Upload failed: ' + error.message);
    } finally {
      setUploadingIndex(null);
    }
  };

  const handleDragEnd = (result) => {
    if (!result.destination) return;
    const slides = Array.from(content.slides || []);
    const [removed] = slides.splice(result.source.index, 1);
    slides.splice(result.destination.index, 0, removed);
    updateContent('slides', slides);
  };

  const renderTypographyControls = (prefix, label, defaultValues = {}) => {
    const defaults = {
      font_family: 'Poppins', font_weight: 400,
      font_size: prefix === 'subheading' ? 24 : 16,
      color: '#ffffff', letter_spacing: 0,
      line_height: prefix === 'subheading' ? 1.4 : 1.6,
      ...defaultValues
    };

    return (
      <div className="space-y-3 p-3 bg-white rounded-md border border-slate-200 mt-2">
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
              min="10" max="120" className="h-8"
            />
          </div>
          <div>
            <Label className="text-xs">Mobile Size (px)</Label>
            <Input
              type="number"
              value={content[`mobile_${prefix}_font_size`] || ''}
              onChange={(e) => updateContent(`mobile_${prefix}_font_size`, e.target.value ? parseInt(e.target.value) : '')}
              min="10" max="120" placeholder="Auto" className="h-8"
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
              type="number" step="0.5"
              value={content[`${prefix}_letter_spacing`] || defaults.letter_spacing}
              onChange={(e) => updateContent(`${prefix}_letter_spacing`, parseFloat(e.target.value) || 0)}
              min="-2" max="10" className="h-8"
            />
          </div>
          <div>
            <Label className="text-xs">Line Height</Label>
            <Input
              type="number" step="0.1"
              value={content[`${prefix}_line_height`] || defaults.line_height}
              onChange={(e) => updateContent(`${prefix}_line_height`, parseFloat(e.target.value) || defaults.line_height)}
              min="0.8" max="3" className="h-8"
            />
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-2">
      <div className="border rounded-lg p-3 bg-slate-50">
        <label className="block text-sm font-medium mb-1">Anchor ID</label>
        <input
          type="text"
          value={content.anchor || ''}
          onChange={(e) => {
            const sanitized = e.target.value.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '');
            updateContent('anchor', sanitized);
          }}
          placeholder="e.g., hero-carousel"
          className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
          data-testid="input-herocarousel-anchor"
        />
        <p className="text-xs text-slate-500 mt-1">Used for linking directly to this section (e.g., /page#anchor-id)</p>
      </div>

      <div className="border border-slate-200 rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('slides')}
          className="w-full flex items-center justify-between p-3 bg-slate-50 hover:bg-slate-100 transition-colors text-left"
          data-testid="accordion-slides"
        >
          <span className="font-medium text-sm">Slides ({(content.slides || []).length})</span>
          <ChevronDown className={`w-4 h-4 transition-transform ${expandedSections.slides ? 'rotate-180' : ''}`} />
        </button>

        {expandedSections.slides && (
          <div className="p-4 space-y-3 border-t border-slate-200">
            <div className="flex items-center justify-between">
              <Label>Manage Slides</Label>
              <Button onClick={addSlide} size="sm" type="button" data-testid="button-add-slide">
                <Plus className="w-4 h-4 mr-1" />
                Add Slide
              </Button>
            </div>

            {(!content.slides || content.slides.length === 0) ? (
              <div className="border-2 border-dashed border-slate-300 rounded-lg p-8 text-center">
                <p className="text-slate-500 text-sm mb-3">No slides yet</p>
                <Button onClick={addSlide} size="sm" type="button">
                  <Plus className="w-4 h-4 mr-1" />
                  Add First Slide
                </Button>
              </div>
            ) : (
              <DragDropContext onDragEnd={handleDragEnd}>
                <Droppable droppableId="hero-carousel-slides">
                  {(provided) => (
                    <div {...provided.droppableProps} ref={provided.innerRef} className="space-y-3">
                      {content.slides.map((slide, index) => (
                        <Draggable key={slide.id} draggableId={slide.id} index={index}>
                          {(provided) => (
                            <div
                              ref={provided.innerRef}
                              {...provided.draggableProps}
                              className="border border-slate-200 rounded-lg bg-slate-50 overflow-hidden"
                            >
                              <div
                                className="flex items-center justify-between p-3 cursor-pointer hover:bg-slate-100"
                                onClick={() => setExpandedSlide(expandedSlide === index ? -1 : index)}
                              >
                                <div className="flex items-center gap-2">
                                  <div {...provided.dragHandleProps} onClick={(e) => e.stopPropagation()}>
                                    <GripVertical className="w-4 h-4 text-slate-400 cursor-grab" />
                                  </div>
                                  <span className="font-medium text-sm text-slate-700">
                                    Slide {index + 1}
                                    {slide.headerText ? ` — ${slide.headerText.replace(/<[^>]*>/g, '').substring(0, 30)}` : ''}
                                  </span>
                                </div>
                                <div className="flex gap-1">
                                  <Button onClick={(e) => { e.stopPropagation(); duplicateSlide(index); }} size="sm" variant="ghost" type="button">
                                    <Copy className="w-4 h-4" />
                                  </Button>
                                  <Button onClick={(e) => { e.stopPropagation(); removeSlide(index); }} size="sm" variant="ghost" className="text-red-600" type="button">
                                    <Trash2 className="w-4 h-4" />
                                  </Button>
                                  <ChevronDown className={`w-4 h-4 transition-transform ${expandedSlide === index ? 'rotate-180' : ''}`} />
                                </div>
                              </div>

                              {expandedSlide === index && (
                                <div className="p-4 pt-0 space-y-3 border-t border-slate-200">
                                  <div>
                                    <Label>Background Image</Label>
                                    <div className="flex gap-2">
                                      <Input
                                        value={slide.backgroundImage || ''}
                                        onChange={(e) => updateSlide(index, 'backgroundImage', e.target.value)}
                                        placeholder="Image URL"
                                        className="flex-1"
                                      />
                                      <Label htmlFor={`hc-upload-${index}`} className="cursor-pointer">
                                        <div className={`flex items-center gap-2 px-4 py-2 rounded-md transition-colors ${
                                          uploadingIndex === index ? 'bg-slate-300 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700 text-white'
                                        }`}>
                                          {uploadingIndex === index ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                                        </div>
                                        <input
                                          id={`hc-upload-${index}`}
                                          type="file" accept="image/*"
                                          onChange={(e) => { const file = e.target.files?.[0]; if (file) handleImageUpload(index, file); e.target.value = ''; }}
                                          className="hidden"
                                          disabled={uploadingIndex === index}
                                        />
                                      </Label>
                                    </div>
                                    {slide.backgroundImage && (
                                      <img src={slide.backgroundImage} alt="Preview" className="mt-2 w-full h-32 object-cover rounded" />
                                    )}
                                  </div>

                                  <div className="grid grid-cols-2 gap-3">
                                    <div>
                                      <Label className="text-xs">Overlay Color</Label>
                                      <input
                                        type="color"
                                        value={slide.overlayColor || '#000000'}
                                        onChange={(e) => updateSlide(index, 'overlayColor', e.target.value)}
                                        className="w-full h-8 px-0.5 py-0.5 border border-slate-300 rounded cursor-pointer"
                                      />
                                    </div>
                                    <div>
                                      <Label className="text-xs">Overlay Opacity (%)</Label>
                                      <Input
                                        type="number" min="0" max="100"
                                        value={slide.overlayOpacity ?? 40}
                                        onChange={(e) => updateSlide(index, 'overlayOpacity', parseInt(e.target.value) || 0)}
                                        className="h-8"
                                      />
                                    </div>
                                  </div>

                                  <div>
                                    <Label className="text-xs">Image Display</Label>
                                    <select
                                      value={slide.imageFit || 'cover'}
                                      onChange={(e) => updateSlide(index, 'imageFit', e.target.value)}
                                      className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                                      data-testid={`select-herocarousel-image-fit-${index}`}
                                    >
                                      <option value="cover">Cover (Fill & Crop)</option>
                                      <option value="contain">Contain (Fit Within)</option>
                                      <option value="original">Original (Full Width, Natural Height)</option>
                                    </select>
                                  </div>

                                  <div>
                                    <Label>Header Text</Label>
                                    <div className="border border-slate-300 rounded-md overflow-hidden bg-white">
                                      <ReactQuill
                                        theme="snow"
                                        value={slide.headerText || ''}
                                        onChange={(value) => updateSlide(index, 'headerText', value)}
                                        modules={heroQuillModules}
                                        placeholder="Enter header text..."
                                        style={{ minHeight: '60px' }}
                                      />
                                    </div>
                                  </div>

                                  <div>
                                    <Label>Subheading Text</Label>
                                    <div className="border border-slate-300 rounded-md overflow-hidden bg-white">
                                      <ReactQuill
                                        theme="snow"
                                        value={slide.subheadingText || ''}
                                        onChange={(value) => updateSlide(index, 'subheadingText', value)}
                                        modules={heroQuillModules}
                                        placeholder="Enter subheading text..."
                                        style={{ minHeight: '50px' }}
                                      />
                                    </div>
                                  </div>

                                  <div>
                                    <Label>Content Text</Label>
                                    <div className="border border-slate-300 rounded-md overflow-hidden bg-white">
                                      <ReactQuill
                                        theme="snow"
                                        value={slide.contentText || ''}
                                        onChange={(value) => updateSlide(index, 'contentText', value)}
                                        modules={heroQuillModules}
                                        placeholder="Enter content text..."
                                        style={{ minHeight: '50px' }}
                                      />
                                    </div>
                                  </div>

                                  <div className="grid grid-cols-2 gap-3">
                                    <div>
                                      <Label>CTA Button Text</Label>
                                      <Input
                                        value={slide.ctaText || ''}
                                        onChange={(e) => updateSlide(index, 'ctaText', e.target.value)}
                                        placeholder="Learn More"
                                      />
                                    </div>
                                    <div>
                                      <Label>CTA Button Link</Label>
                                      <Input
                                        value={slide.ctaLink || ''}
                                        onChange={(e) => updateSlide(index, 'ctaLink', e.target.value)}
                                        placeholder="/page-url"
                                      />
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </Draggable>
                      ))}
                      {provided.placeholder}
                    </div>
                  )}
                </Droppable>
              </DragDropContext>
            )}
          </div>
        )}
      </div>

      <div className="border border-slate-200 rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('typography')}
          className="w-full flex items-center justify-between p-3 bg-slate-50 hover:bg-slate-100 transition-colors text-left"
          data-testid="accordion-typography"
        >
          <span className="font-medium text-sm">Typography & Colors</span>
          <ChevronDown className={`w-4 h-4 transition-transform ${expandedSections.typography ? 'rotate-180' : ''}`} />
        </button>

        {expandedSections.typography && (
          <div className="p-4 space-y-4 border-t border-slate-200">
            <TypographyStyleSelector
              value={content.header_typography_style_id || null}
              onChange={(styleId, style) => {
                const updates = { header_typography_style_id: styleId };
                if (style) {
                  const mapped = applyTypographyStyle(style);
                  if (mapped.font_family) updates.header_font_family = mapped.font_family;
                  if (mapped.font_size) updates.header_font_size = mapped.font_size;
                  if (mapped.font_size_mobile) updates.mobile_header_font_size = mapped.font_size_mobile;
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
              {renderTypographyControls('header', 'Header Typography', { font_size: 48, color: '#ffffff', line_height: 1.2 })}
            </details>

            <div className="pt-2 border-t border-slate-100">
              <TypographyStyleSelector
                value={content.subheading_typography_style_id || null}
                onChange={(styleId, style) => {
                  const updates = { subheading_typography_style_id: styleId };
                  if (style) {
                    const mapped = applyTypographyStyle(style);
                    if (mapped.font_family) updates.subheading_font_family = mapped.font_family;
                    if (mapped.font_size) updates.subheading_font_size = mapped.font_size;
                    if (mapped.font_size_mobile) updates.mobile_subheading_font_size = mapped.font_size_mobile;
                    if (mapped.font_weight) updates.subheading_font_weight = mapped.font_weight;
                    if (mapped.line_height) updates.subheading_line_height = mapped.line_height;
                    if (mapped.letter_spacing !== undefined) updates.subheading_letter_spacing = mapped.letter_spacing;
                    if (mapped.color) updates.subheading_color = mapped.color;
                  }
                  updateMultipleContent(updates);
                }}
                label="Subheading Typography Style"
              />
              <details className="text-xs">
                <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Subheading Font Settings</summary>
                {renderTypographyControls('subheading', 'Subheading Typography')}
              </details>
            </div>

            <div className="pt-2 border-t border-slate-100">
              <TypographyStyleSelector
                value={content.content_typography_style_id || null}
                onChange={(styleId, style) => {
                  const updates = { content_typography_style_id: styleId };
                  if (style) {
                    const mapped = applyTypographyStyle(style);
                    if (mapped.font_family) updates.content_font_family = mapped.font_family;
                    if (mapped.font_size) updates.content_font_size = mapped.font_size;
                    if (mapped.font_size_mobile) updates.mobile_content_font_size = mapped.font_size_mobile;
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
                {renderTypographyControls('content', 'Content Typography')}
              </details>
            </div>

            <div className="pt-4 border-t border-slate-100">
              <label className="block text-sm font-medium mb-1">Text Alignment</label>
              <select
                value={content.text_alignment || 'center'}
                onChange={(e) => updateContent('text_alignment', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
                data-testid="select-herocarousel-text-alignment"
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </div>

          </div>
        )}
      </div>

      <div className="border border-slate-200 rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('layout')}
          className="w-full flex items-center justify-between p-3 bg-slate-50 hover:bg-slate-100 transition-colors text-left"
          data-testid="accordion-layout"
        >
          <span className="font-medium text-sm">Layout & Height</span>
          <ChevronDown className={`w-4 h-4 transition-transform ${expandedSections.layout ? 'rotate-180' : ''}`} />
        </button>

        {expandedSections.layout && (
          <div className="p-4 space-y-4 border-t border-slate-200">
            {(content.slides || []).length > 0 && (content.slides || []).every(s => s.imageFit === 'original') ? (
              <div className="text-xs text-slate-500 italic">
                Height is determined by the image when all slides use "Original" display mode.
              </div>
            ) : (
              <>
                <div>
                  <label className="block text-sm font-medium mb-1">Container Height</label>
                  <select
                    value={content.height_type || 'custom'}
                    onChange={(e) => updateContent('height_type', e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md"
                    data-testid="select-herocarousel-height"
                  >
                    <option value="auto">Auto (Min Height)</option>
                    <option value="full">Full Viewport</option>
                    <option value="custom">Custom</option>
                  </select>
                </div>

                {content.height_type === 'auto' && (
                  <div>
                    <label className="block text-sm font-medium mb-1">Minimum Height (px)</label>
                    <Input
                      type="number"
                      value={content.auto_min_height ?? 400}
                      onChange={(e) => updateContent('auto_min_height', parseInt(e.target.value) || 200)}
                      min="100"
                      data-testid="input-herocarousel-auto-min-height"
                    />
                  </div>
                )}

                {content.height_type === 'custom' && (
                  <div>
                    <label className="block text-sm font-medium mb-1">Custom Height (px)</label>
                    <Input
                      type="number"
                      value={content.custom_height || 500}
                      onChange={(e) => updateContent('custom_height', parseInt(e.target.value) || 500)}
                      min="200"
                    />
                  </div>
                )}
              </>
            )}

            <div className="space-y-3 pt-4 border-t border-slate-100">
              <h4 className="text-sm font-semibold">Container Padding</h4>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium mb-1">Vertical (px)</label>
                  <Input
                    type="number"
                    value={content.padding_vertical || 60}
                    onChange={(e) => updateContent('padding_vertical', parseInt(e.target.value) || 0)}
                    min="0"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Horizontal (px)</label>
                  <Input
                    type="number"
                    value={content.padding_horizontal || 16}
                    onChange={(e) => updateContent('padding_horizontal', parseInt(e.target.value) || 0)}
                    min="0"
                  />
                </div>
              </div>
            </div>

            <div className="space-y-3 pt-4 border-t border-slate-100">
              <h4 className="text-sm font-semibold">Text Position Offset</h4>
              <p className="text-xs text-slate-500">0 = centered. Negative moves left/up, positive moves right/down.</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium mb-1">X Offset (px)</label>
                  <input
                    type="number"
                    value={content.text_offset_x ?? 0}
                    onChange={(e) => updateContent('text_offset_x', parseInt(e.target.value) || 0)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md"
                    data-testid="input-herocarousel-text-offset-x"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Y Offset (px)</label>
                  <input
                    type="number"
                    value={content.text_offset_y ?? 0}
                    onChange={(e) => updateContent('text_offset_y', parseInt(e.target.value) || 0)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md"
                    data-testid="input-herocarousel-text-offset-y"
                  />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="border border-slate-200 rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('carousel')}
          className="w-full flex items-center justify-between p-3 bg-slate-50 hover:bg-slate-100 transition-colors text-left"
          data-testid="accordion-carousel-settings"
        >
          <span className="font-medium text-sm">Carousel Settings</span>
          <ChevronDown className={`w-4 h-4 transition-transform ${expandedSections.carousel ? 'rotate-180' : ''}`} />
        </button>

        {expandedSections.carousel && (
          <div className="p-4 space-y-4 border-t border-slate-200">
            <div>
              <Label htmlFor="hc-autoplay">Autoplay Interval (seconds)</Label>
              <Input
                id="hc-autoplay"
                type="number" min="0"
                value={content.autoplayInterval ?? 5}
                onChange={(e) => updateContent('autoplayInterval', parseInt(e.target.value) || 0)}
                placeholder="5"
                data-testid="input-herocarousel-autoplay"
              />
              <p className="text-xs text-slate-500 mt-1">Set to 0 to disable autoplay</p>
            </div>

            <div>
              <Label>Transition Effect</Label>
              <select
                value={content.transitionEffect || 'fade'}
                onChange={(e) => updateContent('transitionEffect', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
                data-testid="select-herocarousel-transition"
              >
                <option value="fade">Fade</option>
                <option value="slide-left">Slide Left</option>
                <option value="slide-right">Slide Right</option>
                <option value="slide-up">Slide Up</option>
              </select>
            </div>

            <div>
              <Label>Transition Duration (ms)</Label>
              <Input
                type="number" min="100" max="3000" step="100"
                value={content.transitionDuration || 700}
                onChange={(e) => updateContent('transitionDuration', parseInt(e.target.value) || 700)}
                data-testid="input-herocarousel-duration"
              />
              <p className="text-xs text-slate-500 mt-1">How long each transition takes (100-3000ms)</p>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="hc-pause-hover"
                checked={content.pauseOnHover !== false}
                onChange={(e) => updateContent('pauseOnHover', e.target.checked)}
                className="rounded"
                data-testid="checkbox-pause-hover"
              />
              <label htmlFor="hc-pause-hover" className="text-sm">Pause on hover</label>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="hc-show-arrows"
                checked={content.showArrows !== false}
                onChange={(e) => updateContent('showArrows', e.target.checked)}
                className="rounded"
                data-testid="checkbox-show-arrows"
              />
              <label htmlFor="hc-show-arrows" className="text-sm">Show navigation arrows</label>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="hc-show-dots"
                checked={content.showDots !== false}
                onChange={(e) => updateContent('showDots', e.target.checked)}
                className="rounded"
                data-testid="checkbox-show-dots"
              />
              <label htmlFor="hc-show-dots" className="text-sm">Show dot indicators</label>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


export function IEditHeroCarouselElementRenderer({ element, content: contentProp, variant, settings, isFirst, previewViewport }) {
  const content = contentProp || element?.content || { slides: [] };
  const slides = content.slides || [];
  const [currentIndex, setCurrentIndex] = useState(0);
  const [previousIndex, setPreviousIndex] = useState(null);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const timerRef = useRef(null);
  const isMobilePreview = previewViewport === 'mobile';

  const autoplayInterval = content.autoplayInterval ?? 5;
  const transitionEffect = content.transitionEffect || 'fade';
  const transitionDuration = content.transitionDuration || 700;
  const pauseOnHover = content.pauseOnHover !== false;
  const showArrows = content.showArrows !== false;
  const showDots = content.showDots !== false;

  const {
    anchor,
    header_font_family = 'Poppins',
    header_font_size = '48',
    header_color = '#ffffff',
    header_font_weight,
    header_letter_spacing = 0,
    header_line_height = 1.2,
    subheading_font_family = 'Poppins',
    subheading_font_size = '24',
    subheading_color = '#ffffff',
    subheading_font_weight,
    subheading_letter_spacing = 0,
    subheading_line_height = 1.5,
    content_font_family = 'Poppins',
    content_font_size = '16',
    content_color = '#ffffff',
    content_font_weight,
    content_letter_spacing = 0,
    content_line_height = 1.6,
    text_alignment = 'center',
    height_type = 'custom',
    custom_height = 500,
    auto_min_height = 400,
    padding_vertical = 60,
    padding_horizontal = 16,
    text_offset_x = 0,
    text_offset_y = 0,
    mobile_header_font_size,
    mobile_subheading_font_size,
    mobile_content_font_size,
  } = content;

  const reactId = useId();
  const instanceId = `hcarousel-${reactId.replace(/:/g, '')}`;

  const { getStyleById } = useTypographyStyles();
  const headerTypographyStyle = getStyleById ? getStyleById(content.header_typography_style_id) : null;
  const subheadingTypographyStyle = getStyleById ? getStyleById(content.subheading_typography_style_id) : null;
  const contentTypographyStyle = getStyleById ? getStyleById(content.content_typography_style_id) : null;

  const effectiveHeaderFontFamily = headerTypographyStyle?.font_family || header_font_family;
  const effectiveHeaderFontSize = headerTypographyStyle?.font_size || parseInt(header_font_size);
  const effectiveHeaderFontWeight = headerTypographyStyle?.font_weight || header_font_weight;
  const effectiveHeaderLetterSpacing = headerTypographyStyle?.letter_spacing ?? header_letter_spacing;
  const effectiveHeaderLineHeight = headerTypographyStyle?.line_height || header_line_height;

  const effectiveSubheadingFontFamily = subheadingTypographyStyle?.font_family || subheading_font_family;
  const effectiveSubheadingFontSize = subheadingTypographyStyle?.font_size || parseInt(subheading_font_size);
  const effectiveSubheadingFontWeight = subheadingTypographyStyle?.font_weight || subheading_font_weight;
  const effectiveSubheadingLetterSpacing = subheadingTypographyStyle?.letter_spacing ?? subheading_letter_spacing;
  const effectiveSubheadingLineHeight = subheadingTypographyStyle?.line_height || subheading_line_height;

  const effectiveContentFontFamily = contentTypographyStyle?.font_family || content_font_family;
  const effectiveContentFontSize = contentTypographyStyle?.font_size || parseInt(content_font_size);
  const effectiveContentFontWeight = contentTypographyStyle?.font_weight || content_font_weight;
  const effectiveContentLetterSpacing = contentTypographyStyle?.letter_spacing ?? content_letter_spacing;
  const effectiveContentLineHeight = contentTypographyStyle?.line_height || content_line_height;

  const safeHeaderFS = isNaN(effectiveHeaderFontSize) ? 48 : effectiveHeaderFontSize;
  const safeSubheadingFS = isNaN(effectiveSubheadingFontSize) ? 24 : effectiveSubheadingFontSize;
  const safeContentFS = isNaN(effectiveContentFontSize) ? 16 : effectiveContentFontSize;

  const mobileHeaderFS = mobile_header_font_size || Math.max(24, Math.round(safeHeaderFS * 0.6));
  const mobileSubheadingFS = mobile_subheading_font_size || Math.max(16, Math.round(safeSubheadingFS * 0.75));
  const mobileContentFS = mobile_content_font_size || Math.max(14, Math.round(safeContentFS * 0.9));
  const mobilePaddingV = Math.max(32, Math.round(parseInt(padding_vertical) * 0.5));
  const mobilePaddingH = Math.max(16, parseInt(padding_horizontal));
  const parsedOffsetX = parseInt(text_offset_x) || 0;
  const parsedOffsetY = parseInt(text_offset_y) || 0;
  const mobileOffsetX = Math.round(parsedOffsetX * 0.5);
  const mobileOffsetY = Math.round(parsedOffsetY * 0.5);

  const goToSlide = useCallback((newIndex) => {
    if (isTransitioning || slides.length <= 1) return;
    setIsTransitioning(true);
    setPreviousIndex(currentIndex);
    setCurrentIndex(newIndex);
    setTimeout(() => { setIsTransitioning(false); setPreviousIndex(null); }, transitionDuration);
  }, [isTransitioning, slides.length, transitionDuration, currentIndex]);

  const goToNext = useCallback(() => {
    goToSlide((currentIndex + 1) % slides.length);
  }, [currentIndex, slides.length, goToSlide]);

  const goToPrevious = useCallback(() => {
    goToSlide((currentIndex - 1 + slides.length) % slides.length);
  }, [currentIndex, slides.length, goToSlide]);

  useEffect(() => {
    if (slides.length <= 1 || autoplayInterval === 0 || isPaused) {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }
    timerRef.current = setInterval(() => {
      setIsTransitioning(true);
      setCurrentIndex(prev => {
        setPreviousIndex(prev);
        return (prev + 1) % slides.length;
      });
      setTimeout(() => { setIsTransitioning(false); setPreviousIndex(null); }, transitionDuration);
    }, autoplayInterval * 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [slides.length, autoplayInterval, isPaused, transitionDuration]);

  const activeSlideOriginal = slides[currentIndex]?.imageFit === 'original';

  const getDesktopHeightCSS = () => {
    if (activeSlideOriginal) return '';
    if (height_type === 'full') return 'height: 100vh;';
    if (height_type === 'custom') return `height: ${custom_height}px;`;
    return `min-height: ${parseInt(auto_min_height) || 400}px;`;
  };

  const getMobileHeightCSS = () => {
    if (activeSlideOriginal) return '';
    if (height_type === 'full') return 'height: 100vh;';
    if (height_type === 'custom') return `height: ${Math.round(parseInt(custom_height) * 0.6)}px;`;
    return `min-height: ${Math.round((parseInt(auto_min_height) || 400) * 0.6)}px;`;
  };

  const getSlideTransitionStyle = (slideIndex) => {
    const isActive = slideIndex === currentIndex;
    const isPrev = slideIndex === previousIndex;
    const dur = `${transitionDuration}ms`;
    const base = { position: 'absolute', inset: 0 };

    if (transitionEffect === 'fade') {
      return {
        ...base,
        opacity: isActive ? 1 : 0,
        transition: `opacity ${dur} ease-in-out`,
        zIndex: isActive ? 2 : (isPrev ? 1 : 0),
      };
    }

    const movingForward = previousIndex !== null && (
      currentIndex > previousIndex ||
      (currentIndex === 0 && previousIndex === slides.length - 1)
    );

    const exitTransforms = {
      'slide-left': movingForward ? 'translateX(-100%)' : 'translateX(100%)',
      'slide-right': movingForward ? 'translateX(100%)' : 'translateX(-100%)',
      'slide-up': 'translateY(-100%)',
    };
    const enterTransforms = {
      'slide-left': movingForward ? 'translateX(100%)' : 'translateX(-100%)',
      'slide-right': movingForward ? 'translateX(-100%)' : 'translateX(100%)',
      'slide-up': 'translateY(100%)',
    };
    const effect = exitTransforms[transitionEffect] ? transitionEffect : 'slide-left';

    if (isActive) {
      return {
        ...base,
        transform: 'translateX(0) translateY(0)',
        opacity: 1,
        transition: `transform ${dur} ease-in-out, opacity ${dur} ease-in-out`,
        zIndex: 2,
      };
    }
    if (isPrev) {
      return {
        ...base,
        transform: exitTransforms[effect],
        opacity: 0,
        transition: `transform ${dur} ease-in-out, opacity ${dur} ease-in-out`,
        zIndex: 1,
      };
    }
    return {
      ...base,
      transform: enterTransforms[effect],
      opacity: 0,
      transition: 'none',
      zIndex: 0,
    };
  };

  if (!slides || slides.length === 0) {
    return (
      <div className="bg-slate-100 py-24 text-center">
        <p className="text-slate-500">No slides configured</p>
      </div>
    );
  }

  const textAlignClass = {
    left: 'text-left',
    center: 'text-center',
    right: 'text-right'
  }[text_alignment] || 'text-center';

  const displayHeaderFS = isMobilePreview ? mobileHeaderFS : safeHeaderFS;
  const displaySubheadingFS = isMobilePreview ? mobileSubheadingFS : safeSubheadingFS;
  const displayContentFS = isMobilePreview ? mobileContentFS : safeContentFS;
  const displayPaddingV = isMobilePreview ? mobilePaddingV : parseInt(padding_vertical);
  const displayPaddingH = isMobilePreview ? mobilePaddingH : parseInt(padding_horizontal);

  const [isMobileViewport, setIsMobileViewport] = useState(false);
  useEffect(() => {
    if (isMobilePreview) return;
    const mql = window.matchMedia('(max-width: 767px)');
    setIsMobileViewport(mql.matches);
    const handler = (e) => setIsMobileViewport(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [isMobilePreview]);

  const effOffsetX = (isMobilePreview || isMobileViewport) ? mobileOffsetX : parsedOffsetX;
  const effOffsetY = (isMobilePreview || isMobileViewport) ? mobileOffsetY : parsedOffsetY;

  const textBoxStyle = {};
  if (effOffsetX !== 0 || effOffsetY !== 0) {
    textBoxStyle.transform = `translate(${effOffsetX}px, ${effOffsetY}px)`;
  }

  return (
    <>
      <style>{`
        .${instanceId} {
          ${getDesktopHeightCSS()}
          transition: height ${transitionDuration}ms ease-in-out, min-height ${transitionDuration}ms ease-in-out;
        }
        .${instanceId} .hc-title {
          font-family: ${effectiveHeaderFontFamily};
          font-size: ${displayHeaderFS}px;
          color: ${header_color};
          line-height: ${effectiveHeaderLineHeight};
          ${effectiveHeaderFontWeight ? `font-weight: ${effectiveHeaderFontWeight};` : ''}
          letter-spacing: ${effectiveHeaderLetterSpacing}px;
        }
        .${instanceId} .hc-subheading {
          font-family: ${effectiveSubheadingFontFamily};
          font-size: ${displaySubheadingFS}px;
          color: ${subheading_color};
          line-height: ${effectiveSubheadingLineHeight};
          ${effectiveSubheadingFontWeight ? `font-weight: ${effectiveSubheadingFontWeight};` : 'font-weight: 400;'}
          letter-spacing: ${effectiveSubheadingLetterSpacing}px;
          margin-top: ${isMobilePreview ? '12px' : '16px'};
        }
        .${instanceId} .hc-body {
          font-family: ${effectiveContentFontFamily};
          font-size: ${displayContentFS}px;
          color: ${content_color};
          line-height: ${effectiveContentLineHeight};
          ${effectiveContentFontWeight ? `font-weight: ${effectiveContentFontWeight};` : 'font-weight: 400;'}
          letter-spacing: ${effectiveContentLetterSpacing}px;
          margin-top: ${isMobilePreview ? '12px' : '16px'};
        }
        .${instanceId} .hc-subheading p,
        .${instanceId} .hc-body p {
          margin: 0 0 0.5em 0;
        }
        .${instanceId} .hc-subheading p:last-child,
        .${instanceId} .hc-body p:last-child {
          margin-bottom: 0;
        }
        
        ${isMobilePreview ? '' : `@media (max-width: 767px) {
          .${instanceId} {
            ${getMobileHeightCSS()}
          }
          .${instanceId} .hc-title { font-size: ${mobileHeaderFS}px; }
          .${instanceId} .hc-subheading { font-size: ${mobileSubheadingFS}px; margin-top: 12px; }
          .${instanceId} .hc-body { font-size: ${mobileContentFS}px; margin-top: 12px; }
          .${instanceId} .hc-content-wrap {
            padding-left: ${mobilePaddingH}px !important;
            padding-right: ${mobilePaddingH}px !important;
            padding-top: ${mobilePaddingV}px !important;
            padding-bottom: ${mobilePaddingV}px !important;
          }
          .${instanceId} .hc-text-box {
            max-width: 100% !important;
            ${(mobileOffsetX || mobileOffsetY) ? `transform: translate(${mobileOffsetX}px, ${mobileOffsetY}px) !important;` : ''}
          }
          .${instanceId} .hc-cta-wrap {
            margin-top: 16px !important;
          }
          .${instanceId} .hc-cta {
            padding: 10px 20px !important;
            font-size: 14px !important;
          }
          .${instanceId} .hc-nav-arrow {
            width: 40px !important;
            height: 40px !important;
          }
          .${instanceId} .hc-nav-icon {
            width: 20px !important;
            height: 20px !important;
          }
          .${instanceId} .hc-dots {
            bottom: 24px !important;
          }
        }`}
      `}</style>

      <div
        id={anchor || undefined}
        className={`${instanceId} relative w-full overflow-hidden`}
        onMouseEnter={pauseOnHover ? () => setIsPaused(true) : undefined}
        onMouseLeave={pauseOnHover ? () => setIsPaused(false) : undefined}
      >
        {activeSlideOriginal && slides[currentIndex]?.backgroundImage && (
          <img
            src={slides[currentIndex].backgroundImage}
            alt=""
            className="w-full h-auto block"
            style={{ visibility: 'hidden' }}
            aria-hidden="true"
          />
        )}

        {slides.map((slide, index) => (
          <div key={slide.id || index} style={getSlideTransitionStyle(index)}>
            <div className="absolute inset-0">
              {slide.backgroundImage ? (
                <img
                  src={slide.backgroundImage}
                  alt=""
                  className="absolute inset-0 w-full h-full"
                  style={{ objectFit: slide.imageFit === 'original' ? 'contain' : (slide.imageFit || 'cover') }}
                />
              ) : (
                <div
                  className="absolute inset-0"
                  style={{ background: 'linear-gradient(135deg, #1e3a5f 0%, #3b82f6 100%)' }}
                />
              )}
              <div
                className="absolute inset-0"
                style={{
                  backgroundColor: slide.overlayColor || '#000000',
                  opacity: (slide.overlayOpacity ?? 40) / 100
                }}
              />
            </div>

            <div
              className={`hc-content-wrap relative h-full flex items-center z-10 max-w-7xl mx-auto ${textAlignClass}`}
              style={{
                paddingLeft: `${displayPaddingH}px`,
                paddingRight: `${displayPaddingH}px`,
                paddingTop: `${displayPaddingV}px`,
                paddingBottom: `${displayPaddingV}px`,
              }}
            >
              <div className={`hc-text-box ${isMobilePreview ? '' : 'max-w-2xl'} mx-auto`} style={textBoxStyle}>
                {slide.headerText && (
                  <div className="hc-title" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(slide.headerText) }} />
                )}
                {slide.subheadingText && (
                  <div className="hc-subheading" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(slide.subheadingText) }} />
                )}
                {slide.contentText && (
                  <div className="hc-body" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(slide.contentText) }} />
                )}
                {slide.ctaText && slide.ctaLink && (
                  <div className="hc-cta-wrap" style={{ marginTop: isMobilePreview ? '16px' : '24px' }}>
                    <a
                      href={slide.ctaLink}
                      className="hc-cta inline-block bg-white text-slate-900 font-semibold rounded-lg hover:bg-slate-100 transition-colors shadow-lg"
                      style={{
                        padding: isMobilePreview ? '10px 20px' : '16px 32px',
                        fontSize: isMobilePreview ? '14px' : undefined,
                      }}
                    >
                      {slide.ctaText}
                    </a>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}

        {showArrows && slides.length > 1 && (
          <>
            <button
              onClick={goToPrevious}
              className="hc-nav-arrow absolute left-4 top-1/2 -translate-y-1/2 rounded-full bg-white/20 hover:bg-white/30 backdrop-blur-sm flex items-center justify-center transition-colors z-10"
              style={{ width: isMobilePreview ? '40px' : '48px', height: isMobilePreview ? '40px' : '48px' }}
              aria-label="Previous slide"
              data-testid="button-herocarousel-prev"
            >
              <ChevronLeft className="hc-nav-icon text-white" style={{ width: isMobilePreview ? '20px' : '24px', height: isMobilePreview ? '20px' : '24px' }} />
            </button>
            <button
              onClick={goToNext}
              className="hc-nav-arrow absolute right-4 top-1/2 -translate-y-1/2 rounded-full bg-white/20 hover:bg-white/30 backdrop-blur-sm flex items-center justify-center transition-colors z-10"
              style={{ width: isMobilePreview ? '40px' : '48px', height: isMobilePreview ? '40px' : '48px' }}
              aria-label="Next slide"
              data-testid="button-herocarousel-next"
            >
              <ChevronRight className="hc-nav-icon text-white" style={{ width: isMobilePreview ? '20px' : '24px', height: isMobilePreview ? '20px' : '24px' }} />
            </button>
          </>
        )}

        {showDots && slides.length > 1 && (
          <div className="hc-dots absolute bottom-8 left-1/2 -translate-x-1/2 flex gap-2 z-10">
            {slides.map((_, index) => (
              <button
                key={index}
                onClick={() => goToSlide(index)}
                className={`h-3 rounded-full transition-all ${
                  index === currentIndex ? 'bg-white w-8' : 'bg-white/50 hover:bg-white/70 w-3'
                }`}
                aria-label={`Go to slide ${index + 1}`}
                data-testid={`button-herocarousel-dot-${index}`}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

export default IEditHeroCarouselElementRenderer;
