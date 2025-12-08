import { useState, useEffect } from "react";
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import DOMPurify from 'dompurify';
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChevronDown, ChevronUp, Upload, X } from "lucide-react";
import AGCASButton from "../../ui/AGCASButton";
import TypographyStyleSelector, { applyTypographyStyle } from "../TypographyStyleSelector";
import { useIsMobile } from "@/hooks/use-mobile";

const fiftyFiftyQuillModules = {
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

export default function IEditFiftyFiftyElement({ content, variant, settings }) {
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
    left_content_type = 'text',
    right_content_type = 'text',
    left_image_url,
    left_image_fit = 'cover',
    right_image_url,
    right_image_fit = 'cover',
    left_column_bg_color,
    right_column_bg_color,
    left_column_padding = 24,
    right_column_padding = 24,
    column_border_radius = 0,
    button,
    button_column = 'left',
    button_inset_right = 0,
    button_inset_bottom = 0,
    left_vertical_alignment = 'center',
    right_vertical_alignment = 'center',
    reverse_on_mobile = false,
    column_gap = 32,
    vertical_padding = 48
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

  const getVerticalAlignmentClass = (alignment) => ({
    top: 'justify-start',
    center: 'justify-center',
    bottom: 'justify-end'
  }[alignment] || 'justify-center');

  const leftAlignmentClass = getVerticalAlignmentClass(left_vertical_alignment);
  const rightAlignmentClass = getVerticalAlignmentClass(right_vertical_alignment);

  const renderTextContent = (side) => {
    const heading = content?.[`${side}_heading`];
    const subheading = content?.[`${side}_subheading`];
    const textContent = content?.[`${side}_content`];
    const alignment = content?.[`${side}_text_alignment`] || 'left';

    const alignmentClass = {
      left: 'text-left',
      center: 'text-center',
      right: 'text-right'
    }[alignment] || 'text-left';

    return (
      <div className={`space-y-4 ${alignmentClass} flex-1`}>
        {heading && (
          <h2 style={getTextStyle(`${side}_heading`)} className="m-0">
            {heading}
          </h2>
        )}
        {subheading && (
          <div 
            style={getTextStyle(`${side}_subheading`)} 
            className="m-0 prose max-w-none"
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(subheading) }}
          />
        )}
        {textContent && (
          <div 
            className="prose max-w-none" 
            style={getTextStyle(`${side}_content`)}
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(textContent) }}
          />
        )}
      </div>
    );
  };

  const renderImageContent = (side) => {
    const imageUrl = side === 'left' ? left_image_url : right_image_url;
    const imageFit = side === 'left' ? left_image_fit : right_image_fit;

    if (!imageUrl) {
      return (
        <div 
          className="w-full min-h-64 bg-slate-200 flex items-center justify-center"
          style={{ borderRadius: `${column_border_radius}px` }}
        >
          <span className="text-slate-500">No image</span>
        </div>
      );
    }

    return (
      <img 
        src={imageUrl} 
        alt="" 
        className="w-full object-cover"
        style={{ 
          objectFit: imageFit,
          borderRadius: `${column_border_radius}px`
        }}
      />
    );
  };

  const renderColumn = (side) => {
    const contentType = side === 'left' ? left_content_type : right_content_type;
    
    if (contentType === 'image') {
      return renderImageContent(side);
    }
    return renderTextContent(side);
  };

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
        className="relative max-w-7xl mx-auto px-4"
        style={{ paddingTop: `${vertical_padding}px`, paddingBottom: `${vertical_padding}px` }}
      >
        <div 
          className="grid grid-cols-1 md:grid-cols-2 items-stretch"
          style={{ gap: `${column_gap}px` }}
        >
          <div 
            className={`${reverse_on_mobile ? 'order-2 md:order-1' : ''} flex flex-col`}
            style={{
              ...(left_content_type === 'text' && left_column_bg_color ? { 
                backgroundColor: left_column_bg_color,
                padding: `${left_column_padding}px`,
                borderRadius: `${column_border_radius}px`
              } : {}),
              ...(left_content_type === 'image' ? { minHeight: 0 } : {})
            }}
          >
            {left_content_type === 'image' ? (
              <div className="flex-1 flex flex-col min-h-0">
                {left_image_url ? (
                  <img 
                    src={left_image_url} 
                    alt="" 
                    className="w-full flex-1 min-h-0"
                    style={{ 
                      objectFit: left_image_fit || 'cover',
                      borderRadius: `${column_border_radius}px`
                    }}
                  />
                ) : (
                  <div 
                    className="w-full flex-1 min-h-64 bg-slate-200 flex items-center justify-center"
                    style={{ borderRadius: `${column_border_radius}px` }}
                  >
                    <span className="text-slate-500">No image</span>
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className={`flex-1 flex flex-col ${leftAlignmentClass}`}>
                  {renderColumn('left')}
                </div>
                {(button?.text || button?.show_arrow) && button_column === 'left' && (
                  <div 
                    className="flex justify-end"
                    style={{
                      marginRight: left_column_bg_color ? `${-left_column_padding + button_inset_right}px` : `${button_inset_right}px`,
                      marginBottom: left_column_bg_color ? `${-left_column_padding + button_inset_bottom}px` : `${button_inset_bottom}px`
                    }}
                  >
                    <AGCASButton
                      text={button.text}
                      link={button.link}
                      buttonStyleId={button.button_style_id}
                      customBgColor={button.custom_bg_color}
                      customTextColor={button.custom_text_color}
                      customBorderColor={button.custom_border_color}
                      openInNewTab={button.open_in_new_tab}
                      size={button.size || 'medium'}
                      showArrow={button.show_arrow}
                    />
                  </div>
                )}
              </>
            )}
          </div>
          <div 
            className={`${reverse_on_mobile ? 'order-1 md:order-2' : ''} flex flex-col`}
            style={{
              ...(right_content_type === 'text' && right_column_bg_color ? { 
                backgroundColor: right_column_bg_color,
                padding: `${right_column_padding}px`,
                borderRadius: `${column_border_radius}px`
              } : {}),
              ...(right_content_type === 'image' ? { minHeight: 0 } : {})
            }}
          >
            {right_content_type === 'image' ? (
              <div className="flex-1 flex flex-col min-h-0">
                {right_image_url ? (
                  <img 
                    src={right_image_url} 
                    alt="" 
                    className="w-full flex-1 min-h-0"
                    style={{ 
                      objectFit: right_image_fit || 'cover',
                      borderRadius: `${column_border_radius}px`
                    }}
                  />
                ) : (
                  <div 
                    className="w-full flex-1 min-h-64 bg-slate-200 flex items-center justify-center"
                    style={{ borderRadius: `${column_border_radius}px` }}
                  >
                    <span className="text-slate-500">No image</span>
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className={`flex-1 flex flex-col ${rightAlignmentClass}`}>
                  {renderColumn('right')}
                </div>
                {(button?.text || button?.show_arrow) && button_column === 'right' && (
                  <div 
                    className="flex justify-end"
                    style={{
                      marginRight: right_column_bg_color ? `${-right_column_padding + button_inset_right}px` : `${button_inset_right}px`,
                      marginBottom: right_column_bg_color ? `${-right_column_padding + button_inset_bottom}px` : `${button_inset_bottom}px`
                    }}
                  >
                    <AGCASButton
                      text={button.text}
                      link={button.link}
                      buttonStyleId={button.button_style_id}
                      customBgColor={button.custom_bg_color}
                      customTextColor={button.custom_text_color}
                      customBorderColor={button.custom_border_color}
                      openInNewTab={button.open_in_new_tab}
                      size={button.size || 'medium'}
                      showArrow={button.show_arrow}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function IEditFiftyFiftyElementEditor({ element, onChange }) {
  const content = element.content || {};
  const [isUploading, setIsUploading] = useState({});
  const [expandedSections, setExpandedSections] = useState({
    background: true,
    leftColumn: true,
    rightColumn: false,
    button: false,
    layout: false
  });
  const [buttonStyles, setButtonStyles] = useState([]);

  useEffect(() => {
    const fetchStyles = async () => {
      try {
        const { base44 } = await import("@/api/base44Client");
        const styles = await base44.entities.ButtonStyle.list();
        setButtonStyles(styles.filter(s => s.is_active));
      } catch (error) {
        console.error('Failed to fetch button styles:', error);
      }
    };
    fetchStyles();
  }, []);

  const updateContent = (key, value) => {
    onChange({ ...element, content: { ...content, [key]: value } });
  };

  const updateMultipleContent = (updates) => {
    onChange({ ...element, content: { ...content, ...updates } });
  };

  const updateButton = (key, value) => {
    const currentButton = content.button || {};
    updateContent('button', { ...currentButton, [key]: value });
  };

  const toggleSection = (section) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

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

  const renderTextControls = (side) => {
    return (
      <div className="space-y-4">
        <div>
          <Label className="text-xs">Text Alignment</Label>
          <select
            value={content[`${side}_text_alignment`] || 'left'}
            onChange={(e) => updateContent(`${side}_text_alignment`, e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
          >
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
        </div>

        <div className="border-b pb-4">
          <h5 className="font-medium text-sm mb-3">Heading</h5>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Heading Text</Label>
              <Input
                value={content[`${side}_heading`] || ''}
                onChange={(e) => updateContent(`${side}_heading`, e.target.value)}
                placeholder="Enter heading..."
              />
            </div>
            <TypographyStyleSelector
              value={content[`${side}_heading_typography_style_id`] || null}
              onChange={(styleId, style) => {
                const updates = { [`${side}_heading_typography_style_id`]: styleId };
                if (style) {
                  const mapped = applyTypographyStyle(style);
                  if (mapped.font_family) updates[`${side}_heading_font_family`] = mapped.font_family;
                  if (mapped.font_size) updates[`${side}_heading_font_size`] = mapped.font_size;
                  if (mapped.font_size_mobile) updates[`${side}_heading_font_size_mobile`] = mapped.font_size_mobile;
                  if (mapped.font_weight) updates[`${side}_heading_font_weight`] = mapped.font_weight;
                  if (mapped.line_height) updates[`${side}_heading_line_height`] = mapped.line_height;
                  if (mapped.letter_spacing !== undefined) updates[`${side}_heading_letter_spacing`] = mapped.letter_spacing;
                  if (mapped.color) updates[`${side}_heading_color`] = mapped.color;
                }
                updateMultipleContent(updates);
              }}
              filterTypes={['h1', 'h2']}
              label="Heading Typography Style"
            />
            <details className="text-xs">
              <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
              {renderTypographyControls(`${side}_heading`, 'Heading Typography')}
            </details>
          </div>
        </div>

        <div className="border-b pb-4">
          <h5 className="font-medium text-sm mb-3">Subheading</h5>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Subheading Text</Label>
              <div className="fifty-fifty-quill-editor border border-slate-300 rounded-md overflow-hidden bg-white">
                <ReactQuill
                  theme="snow"
                  value={content[`${side}_subheading`] || ''}
                  onChange={(value) => updateContent(`${side}_subheading`, value)}
                  modules={fiftyFiftyQuillModules}
                  placeholder="Enter subheading..."
                  style={{ minHeight: '80px' }}
                />
              </div>
            </div>
            <TypographyStyleSelector
              value={content[`${side}_subheading_typography_style_id`] || null}
              onChange={(styleId, style) => {
                const updates = { [`${side}_subheading_typography_style_id`]: styleId };
                if (style) {
                  const mapped = applyTypographyStyle(style);
                  if (mapped.font_family) updates[`${side}_subheading_font_family`] = mapped.font_family;
                  if (mapped.font_size) updates[`${side}_subheading_font_size`] = mapped.font_size;
                  if (mapped.font_size_mobile) updates[`${side}_subheading_font_size_mobile`] = mapped.font_size_mobile;
                  if (mapped.font_weight) updates[`${side}_subheading_font_weight`] = mapped.font_weight;
                  if (mapped.line_height) updates[`${side}_subheading_line_height`] = mapped.line_height;
                  if (mapped.letter_spacing !== undefined) updates[`${side}_subheading_letter_spacing`] = mapped.letter_spacing;
                  if (mapped.color) updates[`${side}_subheading_color`] = mapped.color;
                }
                updateMultipleContent(updates);
              }}
              filterTypes={['h3', 'h4']}
              label="Subheading Typography Style"
            />
            <details className="text-xs">
              <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
              {renderTypographyControls(`${side}_subheading`, 'Subheading Typography')}
            </details>
          </div>
        </div>

        <div>
          <h5 className="font-medium text-sm mb-3">Content</h5>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Content</Label>
              <div className="fifty-fifty-quill-editor border border-slate-300 rounded-md overflow-hidden bg-white">
                <ReactQuill
                  theme="snow"
                  value={content[`${side}_content`] || ''}
                  onChange={(value) => updateContent(`${side}_content`, value)}
                  modules={fiftyFiftyQuillModules}
                  placeholder="Enter content..."
                  style={{ minHeight: '120px' }}
                />
              </div>
            </div>
            <TypographyStyleSelector
              value={content[`${side}_content_typography_style_id`] || null}
              onChange={(styleId, style) => {
                const updates = { [`${side}_content_typography_style_id`]: styleId };
                if (style) {
                  const mapped = applyTypographyStyle(style);
                  if (mapped.font_family) updates[`${side}_content_font_family`] = mapped.font_family;
                  if (mapped.font_size) updates[`${side}_content_font_size`] = mapped.font_size;
                  if (mapped.font_size_mobile) updates[`${side}_content_font_size_mobile`] = mapped.font_size_mobile;
                  if (mapped.font_weight) updates[`${side}_content_font_weight`] = mapped.font_weight;
                  if (mapped.line_height) updates[`${side}_content_line_height`] = mapped.line_height;
                  if (mapped.color) updates[`${side}_content_color`] = mapped.color;
                }
                updateMultipleContent(updates);
              }}
              filterTypes={['paragraph']}
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

  const renderImageControls = (side) => {
    const imageUrlKey = `${side}_image_url`;
    const imageFitKey = `${side}_image_fit`;

    return (
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
      </div>
    );
  };

  const renderColumnControls = (side, label) => {
    const contentTypeKey = `${side}_content_type`;
    const contentType = content[contentTypeKey] || 'text';
    const bgColorKey = `${side}_column_bg_color`;
    const paddingKey = `${side}_column_padding`;

    return (
      <div className="space-y-4">
        <div>
          <Label className="text-sm font-medium">Content Type</Label>
          <select
            value={contentType}
            onChange={(e) => updateContent(contentTypeKey, e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 rounded-md"
          >
            <option value="text">Text (Heading, Subheading, Content)</option>
            <option value="image">Image</option>
          </select>
        </div>

        {contentType === 'text' && (
          <div className="p-3 bg-slate-50 rounded-md space-y-3">
            <h5 className="font-medium text-sm text-slate-700">Column Background</h5>
            <div>
              <Label className="text-xs">Background Color (optional)</Label>
              <div className="flex gap-2 items-center">
                <input
                  type="color"
                  value={safeHexColor(content[bgColorKey], '#f8fafc')}
                  onChange={(e) => updateContent(bgColorKey, e.target.value)}
                  className="w-12 h-8 px-1 py-1 border border-slate-300 rounded cursor-pointer"
                />
                <Input
                  value={content[bgColorKey] || ''}
                  onChange={(e) => updateContent(bgColorKey, e.target.value)}
                  placeholder="No background"
                  className="flex-1 font-mono text-xs h-8"
                />
                {content[bgColorKey] && (
                  <button
                    type="button"
                    onClick={() => updateContent(bgColorKey, '')}
                    className="p-1 text-slate-500 hover:text-red-600"
                    title="Remove background"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
            {content[bgColorKey] && (
              <div>
                <Label className="text-xs">Column Padding: {content[paddingKey] || 24}px</Label>
                <input
                  type="range"
                  min="0"
                  max="64"
                  value={content[paddingKey] || 24}
                  onChange={(e) => updateContent(paddingKey, parseInt(e.target.value))}
                  className="w-full"
                />
              </div>
            )}
          </div>
        )}

        {contentType === 'text' ? renderTextControls(side) : renderImageControls(side)}
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

      {/* CTA Button Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('button')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
        >
          <span className="font-semibold text-sm">CTA Button (Optional)</span>
          {expandedSections.button ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.button && (
          <div className="p-4 space-y-4">
            <div>
              <Label className="text-sm">Button Column</Label>
              <select
                value={content.button_column || 'left'}
                onChange={(e) => updateContent('button_column', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
              >
                <option value="left">Left Column</option>
                <option value="right">Right Column</option>
              </select>
              <p className="text-xs text-slate-500 mt-1">Button appears at bottom-right of the selected text column</p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Inset from Right: {content.button_inset_right || 0}px</Label>
                <input
                  type="range"
                  min="0"
                  max="48"
                  value={content.button_inset_right || 0}
                  onChange={(e) => updateContent('button_inset_right', parseInt(e.target.value))}
                  className="w-full"
                />
              </div>
              <div>
                <Label className="text-xs">Inset from Bottom: {content.button_inset_bottom || 0}px</Label>
                <input
                  type="range"
                  min="0"
                  max="48"
                  value={content.button_inset_bottom || 0}
                  onChange={(e) => updateContent('button_inset_bottom', parseInt(e.target.value))}
                  className="w-full"
                />
              </div>
            </div>

            <div>
              <Label className="text-sm">Button Text</Label>
              <Input
                value={content.button?.text || ''}
                onChange={(e) => updateButton('text', e.target.value)}
                placeholder="e.g., Learn More"
              />
            </div>

            <div>
              <Label className="text-sm">Link URL</Label>
              <Input
                value={content.button?.link || ''}
                onChange={(e) => updateButton('link', e.target.value)}
                placeholder="https://..."
              />
            </div>

            <div>
              <Label className="text-sm">Button Style</Label>
              <select
                value={content.button?.button_style_id || ''}
                onChange={(e) => updateButton('button_style_id', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
              >
                <option value="">Default Style</option>
                {buttonStyles.map((style) => (
                  <option key={style.id} value={style.id}>
                    {style.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-slate-500 mt-1">Or use custom colors below</p>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label className="text-xs">Background</Label>
                <input
                  type="color"
                  value={safeHexColor(content.button?.custom_bg_color, '#000000')}
                  onChange={(e) => updateButton('custom_bg_color', e.target.value)}
                  className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                />
              </div>
              <div>
                <Label className="text-xs">Text</Label>
                <input
                  type="color"
                  value={safeHexColor(content.button?.custom_text_color, '#ffffff')}
                  onChange={(e) => updateButton('custom_text_color', e.target.value)}
                  className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                />
              </div>
              <div>
                <Label className="text-xs">Border (opt.)</Label>
                <input
                  type="color"
                  value={safeHexColor(content.button?.custom_border_color, '#cccccc')}
                  onChange={(e) => updateButton('custom_border_color', e.target.value)}
                  className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                />
              </div>
            </div>

            <div>
              <Label className="text-sm">Button Size</Label>
              <select
                value={content.button?.size || 'medium'}
                onChange={(e) => updateButton('size', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
              >
                <option value="small">Small</option>
                <option value="medium">Medium</option>
                <option value="large">Large</option>
                <option value="xlarge">Extra Large</option>
              </select>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="show-arrow"
                checked={content.button?.show_arrow || false}
                onChange={(e) => updateButton('show_arrow', e.target.checked)}
                className="w-4 h-4"
              />
              <Label htmlFor="show-arrow" className="cursor-pointer">Show arrow icon →</Label>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="new-tab"
                checked={content.button?.open_in_new_tab || false}
                onChange={(e) => updateButton('open_in_new_tab', e.target.checked)}
                className="w-4 h-4"
              />
              <Label htmlFor="new-tab" className="cursor-pointer">Open in new tab</Label>
            </div>
          </div>
        )}
      </div>

      {/* Layout Options Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('layout')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
        >
          <span className="font-semibold text-sm">Layout Options</span>
          {expandedSections.layout ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.layout && (
          <div className="p-4 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-sm">Left Column Alignment</Label>
                <select
                  value={content.left_vertical_alignment || 'center'}
                  onChange={(e) => updateContent('left_vertical_alignment', e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                >
                  <option value="top">Top</option>
                  <option value="center">Center</option>
                  <option value="bottom">Bottom</option>
                </select>
              </div>
              <div>
                <Label className="text-sm">Right Column Alignment</Label>
                <select
                  value={content.right_vertical_alignment || 'center'}
                  onChange={(e) => updateContent('right_vertical_alignment', e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                >
                  <option value="top">Top</option>
                  <option value="center">Center</option>
                  <option value="bottom">Bottom</option>
                </select>
              </div>
            </div>

            <div>
              <Label className="text-sm">Column Gap (px)</Label>
              <Input
                type="number"
                value={content.column_gap !== undefined ? content.column_gap : 32}
                onChange={(e) => {
                  const val = parseInt(e.target.value);
                  updateContent('column_gap', isNaN(val) ? 0 : Math.min(50, Math.max(0, val)));
                }}
                min="0"
                max="50"
              />
            </div>

            <div>
              <Label className="text-sm">Vertical Padding (px)</Label>
              <Input
                type="number"
                value={content.vertical_padding || 48}
                onChange={(e) => updateContent('vertical_padding', parseInt(e.target.value) || 48)}
                min="0"
                max="200"
              />
            </div>

            <div>
              <Label className="text-sm">Column Corner Radius: {content.column_border_radius || 0}px</Label>
              <input
                type="range"
                min="0"
                max="48"
                value={content.column_border_radius || 0}
                onChange={(e) => updateContent('column_border_radius', parseInt(e.target.value))}
                className="w-full"
              />
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="reverse-mobile"
                checked={content.reverse_on_mobile || false}
                onChange={(e) => updateContent('reverse_on_mobile', e.target.checked)}
                className="w-4 h-4"
              />
              <Label htmlFor="reverse-mobile" className="cursor-pointer">
                Reverse column order on mobile
              </Label>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
