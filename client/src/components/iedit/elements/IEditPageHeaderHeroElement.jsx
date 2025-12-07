import { useState, useId } from "react";
import TypographyStyleSelector, { applyTypographyStyle } from "../TypographyStyleSelector";

export default function IEditPageHeaderHeroElement({ content, variant, settings, isFirst }) {
  const { 
    background_type = 'color',
    background_color = '#1e3a5f',
    gradient_start_color = '#1e3a5f',
    gradient_end_color = '#3b82f6',
    gradient_angle = 135,
    image_url,
    header_text,
    header_position = 'left',
    header_font_family = 'Poppins',
    header_font_size = '48',
    header_color = '#ffffff',
    text_alignment = 'left',
    padding_vertical = '80',
    padding_horizontal = '16',
    line_spacing = '1.2',
    text_padding_left = '0',
    text_padding_right = '0',
    text_padding_top = '0',
    text_padding_bottom = '0',
    height_type = 'auto',
    custom_height = '400',
    image_fit = 'cover',
    overlay_enabled = false,
    overlay_color = '#000000',
    overlay_opacity = '50',
    // Mobile-specific settings with sensible defaults
    mobile_font_size,
    mobile_height_type = 'auto',
    mobile_custom_height = '250',
    mobile_padding_vertical,
    mobile_padding_horizontal,
    mobile_text_alignment
  } = content;

  // Generate unique ID for this instance to scope CSS
  const reactId = useId();
  const instanceId = `hero-${reactId.replace(/:/g, '')}`;

  // Calculate mobile values with fallbacks
  const mobileFontSize = mobile_font_size || Math.max(24, Math.round(parseInt(header_font_size) * 0.6));
  const mobilePaddingVertical = mobile_padding_vertical || Math.max(32, Math.round(parseInt(padding_vertical) * 0.5));
  const mobilePaddingHorizontal = mobile_padding_horizontal || Math.max(16, parseInt(padding_horizontal));
  const mobileTextAlignment = mobile_text_alignment || text_alignment;

  const textAlignClass = {
    left: 'text-left',
    center: 'text-center',
    right: 'text-right'
  }[text_alignment] || 'text-left';

  const getDesktopHeight = () => {
    if (background_type === 'image' && image_fit === 'original') return {};
    if (height_type === 'full') return { height: '100vh' };
    if (height_type === 'custom') return { height: `${custom_height}px` };
    return { minHeight: '400px' };
  };

  const getMobileHeight = () => {
    if (background_type === 'image' && image_fit === 'original') return {};
    if (mobile_height_type === 'full') return { height: '100vh' };
    if (mobile_height_type === 'custom') return { height: `${mobile_custom_height}px` };
    return { minHeight: '250px' };
  };

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

  const desktopHeight = getDesktopHeight();
  const mobileHeight = getMobileHeight();

  return (
    <>
      {/* Instance-scoped responsive styles */}
      <style>
        {`
          .${instanceId} {
            ${desktopHeight.minHeight ? `min-height: ${desktopHeight.minHeight};` : ''}
            ${desktopHeight.height ? `height: ${desktopHeight.height};` : ''}
          }
          
          .${instanceId} .hero-content {
            padding-left: ${padding_horizontal}px;
            padding-right: ${padding_horizontal}px;
            padding-top: ${padding_vertical}px;
            padding-bottom: ${padding_vertical}px;
          }
          
          .${instanceId} .hero-text-box {
            padding-left: ${text_padding_left}px;
            padding-right: ${text_padding_right}px;
            padding-top: ${text_padding_top}px;
            padding-bottom: ${text_padding_bottom}px;
          }
          
          .${instanceId} .hero-title {
            font-family: ${header_font_family};
            font-size: ${header_font_size}px;
            color: ${header_color};
            line-height: ${line_spacing};
          }
          
          /* Mobile styles - below 768px */
          @media (max-width: 767px) {
            .${instanceId} {
              ${mobileHeight.minHeight ? `min-height: ${mobileHeight.minHeight};` : ''}
              ${mobileHeight.height ? `height: ${mobileHeight.height};` : ''}
            }
            
            .${instanceId} .hero-content {
              padding-left: ${mobilePaddingHorizontal}px;
              padding-right: ${mobilePaddingHorizontal}px;
              padding-top: ${mobilePaddingVertical}px;
              padding-bottom: ${mobilePaddingVertical}px;
            }
            
            .${instanceId} .hero-text-box {
              max-width: 100% !important;
              margin-left: 0 !important;
              margin-right: 0 !important;
              padding-left: ${Math.min(parseInt(text_padding_left), 16)}px;
              padding-right: ${Math.min(parseInt(text_padding_right), 16)}px;
              padding-top: ${Math.max(16, Math.round(parseInt(text_padding_top) * 0.5))}px;
              padding-bottom: ${Math.max(16, Math.round(parseInt(text_padding_bottom) * 0.5))}px;
              text-align: ${mobileTextAlignment};
            }
            
            .${instanceId} .hero-title {
              font-size: ${mobileFontSize}px;
            }
          }
        `}
      </style>
      
      <div 
        className={`${instanceId} relative w-full overflow-hidden`}
        style={{ ...getBackgroundStyle() }}
      >
        {background_type === 'image' && image_url && (
          <>
            <img 
              src={image_url} 
              alt={header_text || 'Hero image'} 
              className={image_fit === 'original' ? 'w-full h-auto block' : 'absolute inset-0 w-full h-full'}
              style={image_fit === 'original' ? {} : { objectFit: image_fit }}
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
          className={`hero-content ${background_type === 'image' && image_fit === 'original' ? 'absolute inset-0 flex items-center' : 'relative h-full flex items-center'} max-w-7xl mx-auto`}
        >
          <div 
            className={`hero-text-box max-w-2xl ${header_position === 'right' ? 'ml-auto' : 'mr-auto'} ${textAlignClass}`}
          >
            {header_text && (
              <h1 
                className="hero-title whitespace-pre-line"
              >
                {header_text}
              </h1>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

export function IEditPageHeaderHeroElementEditor({ element, onChange }) {
  const content = element.content || {
    background_type: 'color',
    background_color: '#1e3a5f',
    image_url: '',
    header_text: '',
    header_position: 'left',
    header_font_family: 'Poppins',
    header_font_size: '48',
    header_color: '#ffffff',
    text_alignment: 'left',
    padding_vertical: '80',
    padding_horizontal: '16',
    line_spacing: '1.2',
    text_padding_left: '0',
    text_padding_right: '0',
    text_padding_top: '0',
    text_padding_bottom: '0',
    height_type: 'auto',
    custom_height: '400',
    image_fit: 'cover',
    overlay_enabled: false,
    overlay_color: '#000000',
    overlay_opacity: '50',
    // Mobile defaults
    mobile_font_size: '',
    mobile_height_type: 'auto',
    mobile_custom_height: '250',
    mobile_padding_vertical: '',
    mobile_padding_horizontal: '',
    mobile_text_alignment: ''
  };

  const [isUploading, setIsUploading] = useState(false);
  const [showMobileSettings, setShowMobileSettings] = useState(false);

  const updateContent = (key, value) => {
    onChange({ ...element, content: { ...content, [key]: value } });
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
      const { base44 } = await import("@/api/base44Client");
      const response = await base44.integrations.Core.UploadFile({ file });
      updateContent('image_url', response.file_url);
    } catch (error) {
      alert('Failed to upload image: ' + error.message);
    } finally {
      setIsUploading(false);
    }
  };

  // Calculate default mobile values for display
  const defaultMobileFontSize = Math.max(24, Math.round(parseInt(content.header_font_size || 48) * 0.6));
  const defaultMobilePaddingVertical = Math.max(32, Math.round(parseInt(content.padding_vertical || 80) * 0.5));
  const defaultMobilePaddingHorizontal = Math.max(16, parseInt(content.padding_horizontal || 16));

  return (
    <div className="space-y-4">
      {/* Background Type Selection */}
      <div>
        <label className="block text-sm font-medium mb-1">Background Type</label>
        <select
          value={content.background_type || 'color'}
          onChange={(e) => updateContent('background_type', e.target.value)}
          className="w-full px-3 py-2 border border-slate-300 rounded-md"
        >
          <option value="color">Solid Color</option>
          <option value="gradient">Gradient</option>
          <option value="image">Image</option>
        </select>
      </div>

      {/* Color Background Options */}
      {content.background_type === 'color' && (
        <div>
          <label className="block text-sm font-medium mb-1">Background Color</label>
          <input
            type="color"
            value={content.background_color || '#1e3a5f'}
            onChange={(e) => updateContent('background_color', e.target.value)}
            className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
          />
        </div>
      )}

      {/* Gradient Background Options */}
      {content.background_type === 'gradient' && (
        <div className="space-y-3 p-3 bg-slate-50 rounded-md">
          <div 
            className="w-full h-16 rounded-md border border-slate-300"
            style={{ 
              background: `linear-gradient(${content.gradient_angle || 135}deg, ${content.gradient_start_color || '#1e3a5f'}, ${content.gradient_end_color || '#3b82f6'})` 
            }}
          />
          
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Start Color</label>
              <div className="flex gap-2 items-center">
                <input
                  type="color"
                  value={content.gradient_start_color || '#1e3a5f'}
                  onChange={(e) => updateContent('gradient_start_color', e.target.value)}
                  className="w-12 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                />
                <input
                  type="text"
                  value={content.gradient_start_color || '#1e3a5f'}
                  onChange={(e) => updateContent('gradient_start_color', e.target.value)}
                  className="flex-1 px-2 py-1 border border-slate-300 rounded-md font-mono text-xs"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">End Color</label>
              <div className="flex gap-2 items-center">
                <input
                  type="color"
                  value={content.gradient_end_color || '#3b82f6'}
                  onChange={(e) => updateContent('gradient_end_color', e.target.value)}
                  className="w-12 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                />
                <input
                  type="text"
                  value={content.gradient_end_color || '#3b82f6'}
                  onChange={(e) => updateContent('gradient_end_color', e.target.value)}
                  className="flex-1 px-2 py-1 border border-slate-300 rounded-md font-mono text-xs"
                />
              </div>
            </div>
          </div>
          
          <div>
            <label className="block text-xs font-medium mb-1">Angle: {content.gradient_angle || 135}°</label>
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

      {/* Image Background Options */}
      {content.background_type === 'image' && (
        <>
          <div>
            <label className="block text-sm font-medium mb-1">Hero Image *</label>
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
            {content.image_url && (
              <div className="mt-2 relative">
                <img
                  src={content.image_url}
                  alt="Preview"
                  className="w-full h-32 object-cover rounded"
                  onError={(e) => { e.target.style.display = 'none'; }}
                />
                <button
                  onClick={() => updateContent('image_url', '')}
                  className="absolute bottom-2 right-2 px-2 py-1 bg-red-600 hover:bg-red-700 text-white text-xs rounded"
                  type="button"
                >
                  Remove
                </button>
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Image Display</label>
            <select
              value={content.image_fit || 'cover'}
              onChange={(e) => updateContent('image_fit', e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md"
            >
              <option value="cover">Cover (Fill & Crop)</option>
              <option value="contain">Contain (Fit Within)</option>
              <option value="original">Original (Full Width, Natural Height)</option>
            </select>
          </div>

          {/* Overlay Options */}
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
                  <label className="block text-sm font-medium mb-1">Overlay Color</label>
                  <input
                    type="color"
                    value={content.overlay_color || '#000000'}
                    onChange={(e) => updateContent('overlay_color', e.target.value)}
                    className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Opacity (%)</label>
                  <input
                    type="number"
                    value={content.overlay_opacity || 50}
                    onChange={(e) => updateContent('overlay_opacity', e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md"
                    min="0"
                    max="100"
                  />
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* Header Text */}
      <div>
        <label className="block text-sm font-medium mb-1">Header Text *</label>
        <textarea
          value={content.header_text || ''}
          onChange={(e) => updateContent('header_text', e.target.value)}
          className="w-full px-3 py-2 border border-slate-300 rounded-md"
          placeholder="Enter header text..."
          rows={3}
        />
      </div>

      {/* Typography Style Selector */}
      <TypographyStyleSelector
        value={content.header_typography_style_id}
        onChange={(styleId) => updateContent('header_typography_style_id', styleId)}
        onApplyStyle={(style) => {
          const styleProps = applyTypographyStyle(style);
          if (styleProps.font_family) updateContent('header_font_family', styleProps.font_family);
          if (styleProps.font_size) updateContent('header_font_size', styleProps.font_size);
          if (styleProps.font_size_mobile) updateContent('mobile_font_size', styleProps.font_size_mobile);
          if (styleProps.line_height) updateContent('line_spacing', styleProps.line_height);
          if (styleProps.color) updateContent('header_color', styleProps.color);
          updateContent('header_typography_style_id', style.id);
        }}
        filterTypes={['h1', 'h2']}
        label="Header Typography Style"
      />

      {/* Header Position */}
      <div>
        <label className="block text-sm font-medium mb-1">Header Position</label>
        <select
          value={content.header_position || 'left'}
          onChange={(e) => updateContent('header_position', e.target.value)}
          className="w-full px-3 py-2 border border-slate-300 rounded-md"
        >
          <option value="left">Left</option>
          <option value="right">Right</option>
        </select>
      </div>

      {/* Container Height - show for color backgrounds or non-original image fit */}
      {(content.background_type === 'color' || content.image_fit !== 'original') && (
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1">Container Height</label>
            <select
              value={content.height_type || 'auto'}
              onChange={(e) => updateContent('height_type', e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md"
            >
              <option value="auto">Auto (Min 400px)</option>
              <option value="full">Full Viewport</option>
              <option value="custom">Custom</option>
            </select>
          </div>

          {content.height_type === 'custom' && (
            <div>
              <label className="block text-sm font-medium mb-1">Custom Height (px)</label>
              <input
                type="number"
                value={content.custom_height || 400}
                onChange={(e) => updateContent('custom_height', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
                min="100"
              />
            </div>
          )}
        </div>
      )}

      {/* Manual Font Settings - Collapsible */}
      <details className="text-xs">
        <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
        <div className="mt-3 space-y-4">
          {/* Typography Settings */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">Font Family</label>
              <select
                value={content.header_font_family || 'Poppins'}
                onChange={(e) => updateContent('header_font_family', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
              >
                <option value="Poppins">Poppins</option>
                <option value="Degular Medium">Degular Medium</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Font Size (px)</label>
              <input
                type="number"
                value={content.header_font_size || 48}
                onChange={(e) => updateContent('header_font_size', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
                min="16"
                max="96"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Font Color</label>
            <input
              type="color"
              value={content.header_color || '#ffffff'}
              onChange={(e) => updateContent('header_color', e.target.value)}
              className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
            />
          </div>

          {/* Line Spacing */}
          <div>
            <label className="block text-sm font-medium mb-1">Line Spacing</label>
            <input
              type="number"
              step="0.1"
              min="0.5"
              max="3"
              value={content.line_spacing || 1.2}
              onChange={(e) => updateContent('line_spacing', e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md"
            />
          </div>
        </div>
      </details>

      {/* Text Alignment - Outside collapsible section */}
      <div>
        <label className="block text-sm font-medium mb-1">Text Alignment</label>
        <select
          value={content.text_alignment || 'left'}
          onChange={(e) => updateContent('text_alignment', e.target.value)}
          className="w-full px-3 py-2 border border-slate-300 rounded-md"
        >
          <option value="left">Left</option>
          <option value="center">Center</option>
          <option value="right">Right</option>
        </select>
      </div>

      {/* Container Padding */}
      <div className="space-y-3">
        <h4 className="text-sm font-semibold">Container Padding</h4>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium mb-1">Vertical (px)</label>
            <input
              type="number"
              value={content.padding_vertical || 80}
              onChange={(e) => updateContent('padding_vertical', e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md"
              min="0"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Horizontal (px)</label>
            <input
              type="number"
              value={content.padding_horizontal || 16}
              onChange={(e) => updateContent('padding_horizontal', e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md"
              min="0"
            />
          </div>
        </div>
      </div>

      {/* Text Position */}
      <div className="space-y-3">
        <h4 className="text-sm font-semibold">Text Position</h4>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium mb-1">From Left (px)</label>
            <input
              type="number"
              value={content.text_padding_left || 0}
              onChange={(e) => updateContent('text_padding_left', e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md"
              min="0"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">From Right (px)</label>
            <input
              type="number"
              value={content.text_padding_right || 0}
              onChange={(e) => updateContent('text_padding_right', e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md"
              min="0"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">From Top (px)</label>
            <input
              type="number"
              value={content.text_padding_top || 0}
              onChange={(e) => updateContent('text_padding_top', e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md"
              min="0"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">From Bottom (px)</label>
            <input
              type="number"
              value={content.text_padding_bottom || 0}
              onChange={(e) => updateContent('text_padding_bottom', e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md"
              min="0"
            />
          </div>
        </div>
      </div>

      {/* Mobile Settings Section */}
      <div className="border-t pt-4 mt-4">
        <button
          type="button"
          onClick={() => setShowMobileSettings(!showMobileSettings)}
          className="flex items-center gap-2 text-sm font-semibold text-blue-600 hover:text-blue-700"
        >
          <svg 
            className={`w-4 h-4 transition-transform ${showMobileSettings ? 'rotate-90' : ''}`} 
            fill="none" 
            stroke="currentColor" 
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          Mobile Settings
          <span className="text-xs font-normal text-slate-500">(screens below 768px)</span>
        </button>
        
        {showMobileSettings && (
          <div className="mt-4 space-y-4 p-4 bg-blue-50 rounded-lg">
            <p className="text-xs text-slate-600 mb-3">
              Leave fields empty to use automatic scaling based on desktop values.
            </p>

            {/* Mobile Font Size */}
            <div>
              <label className="block text-sm font-medium mb-1">
                Mobile Font Size (px)
                <span className="text-xs text-slate-500 ml-2">Default: {defaultMobileFontSize}px</span>
              </label>
              <input
                type="number"
                value={content.mobile_font_size || ''}
                onChange={(e) => updateContent('mobile_font_size', e.target.value)}
                placeholder={defaultMobileFontSize}
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
                min="16"
                max="72"
              />
            </div>

            {/* Mobile Height */}
            {(content.background_type === 'color' || content.image_fit !== 'original') && (
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium mb-1">Mobile Container Height</label>
                  <select
                    value={content.mobile_height_type || 'auto'}
                    onChange={(e) => updateContent('mobile_height_type', e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md"
                  >
                    <option value="auto">Auto (Min 250px)</option>
                    <option value="full">Full Viewport</option>
                    <option value="custom">Custom</option>
                  </select>
                </div>

                {content.mobile_height_type === 'custom' && (
                  <div>
                    <label className="block text-sm font-medium mb-1">Mobile Custom Height (px)</label>
                    <input
                      type="number"
                      value={content.mobile_custom_height || 250}
                      onChange={(e) => updateContent('mobile_custom_height', e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md"
                      min="100"
                    />
                  </div>
                )}
              </div>
            )}

            {/* Mobile Padding */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">
                  Mobile Vertical Padding
                  <span className="text-xs text-slate-500 block">Default: {defaultMobilePaddingVertical}px</span>
                </label>
                <input
                  type="number"
                  value={content.mobile_padding_vertical || ''}
                  onChange={(e) => updateContent('mobile_padding_vertical', e.target.value)}
                  placeholder={defaultMobilePaddingVertical}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                  min="0"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">
                  Mobile Horizontal Padding
                  <span className="text-xs text-slate-500 block">Default: {defaultMobilePaddingHorizontal}px</span>
                </label>
                <input
                  type="number"
                  value={content.mobile_padding_horizontal || ''}
                  onChange={(e) => updateContent('mobile_padding_horizontal', e.target.value)}
                  placeholder={defaultMobilePaddingHorizontal}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                  min="0"
                />
              </div>
            </div>

            {/* Mobile Text Alignment */}
            <div>
              <label className="block text-sm font-medium mb-1">
                Mobile Text Alignment
                <span className="text-xs text-slate-500 ml-2">Default: Same as desktop</span>
              </label>
              <select
                value={content.mobile_text_alignment || ''}
                onChange={(e) => updateContent('mobile_text_alignment', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
              >
                <option value="">Same as Desktop ({content.text_alignment || 'left'})</option>
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
