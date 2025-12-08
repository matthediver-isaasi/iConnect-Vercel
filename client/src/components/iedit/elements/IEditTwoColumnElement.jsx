import { useState } from "react";
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import DOMPurify from 'dompurify';
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChevronDown, ChevronUp, Upload, X, AlignLeft, AlignCenter, AlignRight } from "lucide-react";
import TypographyStyleSelector, { applyTypographyStyle } from "../TypographyStyleSelector";

const twoColumnQuillModules = {
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

export default function IEditTwoColumnElement({ content, variant, settings }) {
  const variants = {
    default: "md:grid-cols-2",
    "60-40": "md:grid-cols-[60%_40%]",
    "40-60": "md:grid-cols-[40%_60%]",
  };

  const gridClass = variants[variant] || variants.default;
  const backgroundType = content?.background_type || 'none';

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

  const getHeaderStyle = (side) => ({
    fontFamily: content?.[`${side}_header_font_family`] || 'Poppins',
    fontWeight: content?.[`${side}_header_font_weight`] || 700,
    fontSize: `${content?.[`${side}_header_font_size`] || 24}px`,
    color: content?.[`${side}_header_color`] || '#1e293b',
    letterSpacing: `${content?.[`${side}_header_letter_spacing`] || 0}px`,
    lineHeight: content?.[`${side}_header_line_height`] || 1.3,
    textAlign: content?.[`${side}_header_align`] || 'left'
  });

  const getContentStyle = (side) => ({
    fontFamily: content?.[`${side}_content_font_family`] || 'Poppins',
    fontWeight: content?.[`${side}_content_font_weight`] || 400,
    fontSize: `${content?.[`${side}_content_font_size`] || 16}px`,
    color: content?.[`${side}_content_color`] || '#475569',
    lineHeight: content?.[`${side}_content_line_height`] || 1.6,
    textAlign: content?.[`${side}_content_align`] || 'left'
  });

  const renderColumn = (side, heading, columnContent) => {
    const imageUrl = content?.[`${side}_image_url`];
    const imageFit = content?.[`${side}_image_fit`] || 'cover';
    const imagePosition = content?.[`${side}_image_position`] || 'above';

    const headingElement = heading && (
      <h3 style={getHeaderStyle(side)} className="mb-4">
        {heading}
      </h3>
    );

    const contentElement = columnContent && (
      <div 
        className="prose max-w-none" 
        style={getContentStyle(side)}
        dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(columnContent) }}
      />
    );

    const imageElement = imageUrl && (
      <div className="mb-4">
        <img 
          src={imageUrl} 
          alt="" 
          className="w-full rounded-lg"
          style={{ objectFit: imageFit, maxHeight: '400px' }}
        />
      </div>
    );

    if (imagePosition === 'above') {
      return (
        <div>
          {imageElement}
          {headingElement}
          {contentElement}
        </div>
      );
    } else {
      return (
        <div>
          {headingElement}
          {contentElement}
          {imageElement}
        </div>
      );
    }
  };

  return (
    <div 
      className="relative w-full"
      style={hasBackground && backgroundType !== 'image' ? getBackgroundStyle() : {}}
    >
      {/* Background image layer - full width */}
      {backgroundType === 'image' && content?.background_image_url && (
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

      {/* Content container - constrained width */}
      <div className={`relative max-w-7xl mx-auto px-4 ${hasBackground ? 'py-12' : ''}`}>
        <div className={`grid ${gridClass} gap-8`}>
          {renderColumn('left', content?.leftHeading, content?.leftContent)}
          {renderColumn('right', content?.rightHeading, content?.rightContent)}
        </div>
      </div>
    </div>
  );
}

export function IEditTwoColumnElementEditor({ element, onChange }) {
  const content = element.content || {};
  const [isUploading, setIsUploading] = useState({});
  const [expandedSections, setExpandedSections] = useState({
    background: true,
    leftColumn: true,
    rightColumn: false
  });

  const updateContent = (key, value) => {
    onChange({ ...element, content: { ...content, [key]: value } });
  };

  const toggleSection = (section) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const AlignmentButtons = ({ value, onChange: onAlignChange, label, testIdPrefix = 'align' }) => (
    <div>
      <label className="block text-sm font-medium mb-1">{label}</label>
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
    </div>
  );

  const handleImageUpload = async (file, field) => {
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

    setIsUploading(prev => ({ ...prev, [field]: true }));
    try {
      const { base44 } = await import("@/api/base44Client");
      const response = await base44.integrations.Core.UploadFile({ file });
      updateContent(field, response.file_url);
    } catch (error) {
      alert('Failed to upload image: ' + error.message);
    } finally {
      setIsUploading(prev => ({ ...prev, [field]: false }));
    }
  };

  const backgroundType = content.background_type || 'none';
  const gradientPreview = `linear-gradient(${content.gradient_angle || 135}deg, ${content.gradient_start_color || '#3b82f6'}, ${content.gradient_end_color || '#8b5cf6'})`;

  const renderTypographyControls = (prefix, label, defaultValues = {}) => {
    const defaults = {
      font_family: 'Poppins',
      font_weight: prefix.includes('header') ? 700 : 400,
      font_size: prefix.includes('header') ? 24 : 16,
      color: prefix.includes('header') ? '#1e293b' : '#475569',
      letter_spacing: 0,
      line_height: prefix.includes('header') ? 1.3 : 1.6,
      ...defaultValues
    };

    return (
      <div className="space-y-3 p-3 bg-slate-50 rounded-md">
        <h5 className="font-medium text-sm text-slate-700">{label}</h5>
        
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

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">Font Size (px)</Label>
            <Input
              type="number"
              value={content[`${prefix}_font_size`] || defaults.font_size}
              onChange={(e) => updateContent(`${prefix}_font_size`, parseInt(e.target.value) || defaults.font_size)}
              min="10"
              max="72"
              className="h-8"
            />
          </div>
          <div>
            <Label className="text-xs">Text Color</Label>
            <div className="flex gap-1 items-center">
              <input
                type="color"
                value={content[`${prefix}_color`] || defaults.color}
                onChange={(e) => updateContent(`${prefix}_color`, e.target.value)}
                className="w-10 h-8 px-0.5 py-0.5 border border-slate-300 rounded cursor-pointer"
              />
              <Input
                value={content[`${prefix}_color`] || defaults.color}
                onChange={(e) => updateContent(`${prefix}_color`, e.target.value)}
                className="flex-1 h-8 font-mono text-xs"
              />
            </div>
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

  const renderColumnControls = (side, label) => {
    const headingKey = side === 'left' ? 'leftHeading' : 'rightHeading';
    const contentKey = side === 'left' ? 'leftContent' : 'rightContent';
    const imageUrlKey = `${side}_image_url`;
    const imageFitKey = `${side}_image_fit`;
    const imagePositionKey = `${side}_image_position`;

    return (
      <div className="space-y-4">
        {/* Column Image */}
        <div className="border-b pb-4">
          <h5 className="font-medium text-sm mb-3">Column Image</h5>
          
          <div className="space-y-3">
            <div>
              <label className="inline-block">
                <div className={`px-4 py-2 rounded-md text-sm font-medium cursor-pointer inline-flex items-center gap-2 ${
                  isUploading[imageUrlKey] 
                    ? 'bg-slate-300 cursor-not-allowed' 
                    : 'bg-blue-600 hover:bg-blue-700 text-white'
                }`}>
                  <Upload className="w-4 h-4" />
                  {isUploading[imageUrlKey] ? 'Uploading...' : 'Upload Image'}
                </div>
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleImageUpload(file, imageUrlKey);
                    e.target.value = '';
                  }}
                  className="hidden"
                  disabled={isUploading[imageUrlKey]}
                />
              </label>
            </div>

            {content[imageUrlKey] && (
              <div className="relative">
                <img
                  src={content[imageUrlKey]}
                  alt="Preview"
                  className="w-full h-32 object-cover rounded"
                  onError={(e) => { e.target.style.display = 'none'; }}
                />
                <button
                  onClick={() => updateContent(imageUrlKey, '')}
                  className="absolute top-2 right-2 p-1 bg-red-600 hover:bg-red-700 text-white rounded"
                  type="button"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            {content[imageUrlKey] && (
              <>
                <div>
                  <Label className="text-xs">Image Fit</Label>
                  <select
                    value={content[imageFitKey] || 'cover'}
                    onChange={(e) => updateContent(imageFitKey, e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                  >
                    <option value="cover">Cover (fill, may crop)</option>
                    <option value="contain">Contain (show all)</option>
                    <option value="fill">Fill (stretch)</option>
                  </select>
                </div>

                <div>
                  <Label className="text-xs">Image Position</Label>
                  <select
                    value={content[imagePositionKey] || 'above'}
                    onChange={(e) => updateContent(imagePositionKey, e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                  >
                    <option value="above">Above text</option>
                    <option value="below">Below text</option>
                  </select>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Heading */}
        <div className="border-b pb-4">
          <h5 className="font-medium text-sm mb-3">Heading</h5>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Heading Text</Label>
              <Input
                value={content[headingKey] || ''}
                onChange={(e) => updateContent(headingKey, e.target.value)}
                placeholder="Enter heading..."
              />
            </div>
            <AlignmentButtons 
              value={content[`${side}_header_align`] || 'left'} 
              onChange={(val) => updateContent(`${side}_header_align`, val)}
              label="Heading Alignment"
              testIdPrefix={`twocol-${side}-heading-align`}
            />
            <TypographyStyleSelector
              value={content[`${side}_header_typography_style_id`] || null}
              onChange={(styleId) => updateContent(`${side}_header_typography_style_id`, styleId)}
              onApplyStyle={(style) => {
                const mapped = applyTypographyStyle(style);
                if (mapped.font_family) updateContent(`${side}_header_font_family`, mapped.font_family);
                if (mapped.font_size) updateContent(`${side}_header_font_size`, mapped.font_size);
                if (mapped.font_size_mobile) updateContent(`${side}_header_font_size_mobile`, mapped.font_size_mobile);
                if (mapped.font_weight) updateContent(`${side}_header_font_weight`, mapped.font_weight);
                if (mapped.line_height) updateContent(`${side}_header_line_height`, mapped.line_height);
                if (mapped.letter_spacing !== undefined) updateContent(`${side}_header_letter_spacing`, mapped.letter_spacing);
                if (mapped.color) updateContent(`${side}_header_color`, mapped.color);
              }}
              label="Header Typography Style"
            />
            <details className="text-xs">
              <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
              {renderTypographyControls(`${side}_header`, 'Header Typography')}
            </details>
          </div>
        </div>

        {/* Content */}
        <div>
          <h5 className="font-medium text-sm mb-3">Content</h5>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Content</Label>
              <div className="two-column-quill-editor border border-slate-300 rounded-md overflow-hidden bg-white">
                <ReactQuill
                  theme="snow"
                  value={content[contentKey] || ''}
                  onChange={(value) => updateContent(contentKey, value)}
                  modules={twoColumnQuillModules}
                  placeholder="Enter content..."
                  style={{ minHeight: '120px' }}
                />
              </div>
            </div>
            <AlignmentButtons 
              value={content[`${side}_content_align`] || 'left'} 
              onChange={(val) => updateContent(`${side}_content_align`, val)}
              label="Content Alignment"
              testIdPrefix={`twocol-${side}-content-align`}
            />
            <TypographyStyleSelector
              value={content[`${side}_content_typography_style_id`] || null}
              onChange={(styleId) => updateContent(`${side}_content_typography_style_id`, styleId)}
              onApplyStyle={(style) => {
                const mapped = applyTypographyStyle(style);
                if (mapped.font_family) updateContent(`${side}_content_font_family`, mapped.font_family);
                if (mapped.font_size) updateContent(`${side}_content_font_size`, mapped.font_size);
                if (mapped.font_size_mobile) updateContent(`${side}_content_font_size_mobile`, mapped.font_size_mobile);
                if (mapped.font_weight) updateContent(`${side}_content_font_weight`, mapped.font_weight);
                if (mapped.line_height) updateContent(`${side}_content_line_height`, mapped.line_height);
                if (mapped.color) updateContent(`${side}_content_color`, mapped.color);
              }}
              label="Content Typography Style"
            />
            <details className="text-xs">
              <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
              {renderTypographyControls(`${side}_content`, 'Content Typography')}
            </details>
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
                    <Label className="text-xs">Start Color</Label>
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
                    <Label className="text-xs">End Color</Label>
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
              <>
                <div>
                  <Label>Background Image</Label>
                  <div className="space-y-2">
                    <label className="inline-block">
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
                    className="w-full px-3 py-2 border border-slate-300 rounded-md"
                  >
                    <option value="cover">Cover (fill, may crop)</option>
                    <option value="contain">Contain (show all)</option>
                  </select>
                </div>

                <div className="space-y-3 p-3 bg-slate-50 rounded-md">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="overlay_enabled"
                      checked={content.overlay_enabled || false}
                      onChange={(e) => updateContent('overlay_enabled', e.target.checked)}
                      className="rounded"
                    />
                    <label htmlFor="overlay_enabled" className="text-sm font-medium">Enable Overlay</label>
                  </div>
                  
                  {content.overlay_enabled && (
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label className="text-xs">Overlay Color</Label>
                        <input
                          type="color"
                          value={content.overlay_color || '#000000'}
                          onChange={(e) => updateContent('overlay_color', e.target.value)}
                          className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Opacity (%)</Label>
                        <Input
                          type="number"
                          value={content.overlay_opacity || 50}
                          onChange={(e) => updateContent('overlay_opacity', e.target.value)}
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
        )}
      </div>

      {/* Left Column Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('leftColumn')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
        >
          <span className="font-semibold text-sm">Left Column</span>
          {expandedSections.leftColumn ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.leftColumn && (
          <div className="p-4">
            {renderColumnControls('left', 'Left Column')}
          </div>
        )}
      </div>

      {/* Right Column Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('rightColumn')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
        >
          <span className="font-semibold text-sm">Right Column</span>
          {expandedSections.rightColumn ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.rightColumn && (
          <div className="p-4">
            {renderColumnControls('right', 'Right Column')}
          </div>
        )}
      </div>
    </div>
  );
}
