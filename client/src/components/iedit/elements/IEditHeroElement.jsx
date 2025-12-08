import { useState, useEffect, useId } from "react";
import AGCASButton from "../../ui/AGCASButton";
import TypographyStyleSelector, { applyTypographyStyle } from "../TypographyStyleSelector";
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import DOMPurify from 'dompurify';
import { AlignLeft, AlignCenter, AlignRight, ChevronDown, ChevronUp } from "lucide-react";

const heroQuillModules = {
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

export default function IEditHeroElement({ content, variant, settings }) {
  const {
    background_type = 'color',
    background_color = '#3b82f6',
    gradient_start_color = '#3b82f6',
    gradient_end_color = '#8b5cf6',
    gradient_angle = 135,
    image_url,
    image_fit = 'cover',
    overlay_enabled = false,
    overlay_color = '#000000',
    overlay_opacity = 50,
    text_color = '#ffffff',
    heading_font_family = 'Poppins',
    heading_font_size = 48,
    heading_line_height = 1.2,
    heading_letter_spacing = 0,
    heading_underline_enabled = false,
    heading_underline_color = '#000000',
    heading_underline_width = 100,
    heading_underline_weight = 2,
    heading_underline_spacing = 16,
    heading_underline_to_content_spacing = 24,
    heading_text_align,
    subheading_font_family = 'Poppins',
    subheading_font_size = 20,
    subheading_line_height = 1.5,
    subheading_letter_spacing = 0,
    subheading_text_align,
    content_text = '',
    content_font_family = 'Poppins',
    content_font_size = 16,
    content_line_height = 1.6,
    content_letter_spacing = 0,
    content_color,
    content_top_margin = 24,
    content_text_align,
    text_align = 'center',
    padding_left = 16,
    padding_right = 16,
    padding_top = 80,
    padding_bottom = 80,
    height_type = 'auto',
    custom_height = 400,
    button_top_margin = 32,
    text_vertical_align = 'center',
    button,
    mobile_heading_font_size,
    mobile_subheading_font_size,
    mobile_content_font_size,
    mobile_padding_top,
    mobile_padding_bottom,
    mobile_padding_left,
    mobile_padding_right,
    mobile_height_type = 'auto',
    mobile_custom_height = 300,
    mobile_text_align,
    mobile_button_top_margin
  } = content;

  const reactId = useId();
  const instanceId = `hero-${reactId.replace(/:/g, '')}`;
  const fullWidth = settings?.fullWidth;

  const mobileHeadingFontSize = mobile_heading_font_size || Math.max(28, Math.round(heading_font_size * 0.6));
  const mobileSubheadingFontSize = mobile_subheading_font_size || Math.max(16, Math.round(subheading_font_size * 0.8));
  const mobileContentFontSize = mobile_content_font_size || Math.max(14, Math.round(content_font_size * 0.9));
  const mobilePaddingTop = mobile_padding_top !== undefined ? mobile_padding_top : Math.max(40, Math.round(padding_top * 0.5));
  const mobilePaddingBottom = mobile_padding_bottom !== undefined ? mobile_padding_bottom : Math.max(40, Math.round(padding_bottom * 0.5));
  const mobilePaddingLeft = mobile_padding_left !== undefined ? mobile_padding_left : Math.max(16, padding_left);
  const mobilePaddingRight = mobile_padding_right !== undefined ? mobile_padding_right : Math.max(16, padding_right);
  const mobileTextAlign = mobile_text_align || text_align;
  const mobileButtonTopMargin = mobile_button_top_margin !== undefined ? mobile_button_top_margin : Math.max(16, Math.round(button_top_margin * 0.75));
  const mobileUnderlineWidth = Math.min(heading_underline_width, 80);

  const effectiveHeadingAlign = heading_text_align || text_align;
  const effectiveSubheadingAlign = subheading_text_align || text_align;
  const effectiveContentAlign = content_text_align || text_align;

  const isImageSized = height_type === 'image' && background_type === 'image' && image_url;

  const getHeightStyle = () => {
    if (height_type === 'full') return { minHeight: '100vh' };
    if (height_type === 'custom') return { minHeight: `${custom_height}px` };
    if (height_type === 'image') return {};
    return {};
  };

  const getMobileHeightStyle = () => {
    if (mobile_height_type === 'full') return { minHeight: '100vh' };
    if (mobile_height_type === 'custom') return { minHeight: `${mobile_custom_height}px` };
    if (height_type === 'image') return {};
    return {};
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

  const getTextVerticalAlign = () => {
    if (text_vertical_align === 'top') return 'flex-start';
    if (text_vertical_align === 'bottom') return 'flex-end';
    return 'center';
  };

  const desktopHeight = getHeightStyle();
  const mobileHeight = getMobileHeightStyle();

  const responsiveStyles = `
    .${instanceId} .hero-container {
      ${desktopHeight.minHeight ? `min-height: ${desktopHeight.minHeight};` : ''}
    }
    
    .${instanceId} .hero-content {
      padding-left: ${padding_left}px;
      padding-right: ${padding_right}px;
      padding-top: ${padding_top}px;
      padding-bottom: ${padding_bottom}px;
    }
    
    .${instanceId} .hero-heading {
      font-family: ${heading_font_family};
      font-size: ${heading_font_size}px;
      line-height: ${heading_line_height};
      letter-spacing: ${heading_letter_spacing}px;
      color: ${text_color};
      text-align: ${effectiveHeadingAlign};
    }
    
    .${instanceId} .hero-underline {
      width: ${heading_underline_width}px;
      ${effectiveHeadingAlign === 'center' ? 'margin-left: auto; margin-right: auto;' : 
        effectiveHeadingAlign === 'right' ? 'margin-left: auto; margin-right: 0;' : 
        'margin-left: 0; margin-right: auto;'}
    }
    
    .${instanceId} .hero-subheading {
      font-family: ${subheading_font_family};
      font-size: ${subheading_font_size}px;
      line-height: ${subheading_line_height};
      letter-spacing: ${subheading_letter_spacing}px;
      color: ${text_color};
      text-align: ${effectiveSubheadingAlign};
    }
    
    .${instanceId} .hero-content-text {
      font-family: ${content_font_family};
      font-size: ${content_font_size}px;
      line-height: ${content_line_height};
      letter-spacing: ${content_letter_spacing}px;
      color: ${content_color || text_color};
      margin-top: ${content_top_margin}px;
      text-align: ${effectiveContentAlign};
    }
    
    .${instanceId} .hero-button-wrapper {
      margin-top: ${button_top_margin}px;
      text-align: ${content.button_align || text_align};
    }
    
    @media (max-width: 767px) {
      .${instanceId} .hero-container {
        ${mobileHeight.minHeight ? `min-height: ${mobileHeight.minHeight};` : ''}
      }
      
      .${instanceId} .hero-content {
        padding-left: ${mobilePaddingLeft}px;
        padding-right: ${mobilePaddingRight}px;
        padding-top: ${mobilePaddingTop}px;
        padding-bottom: ${mobilePaddingBottom}px;
      }
      
      .${instanceId} .hero-heading {
        font-size: ${mobileHeadingFontSize}px;
        text-align: ${mobile_text_align || effectiveHeadingAlign};
      }
      
      .${instanceId} .hero-underline {
        width: ${mobileUnderlineWidth}px;
        ${(mobile_text_align || effectiveHeadingAlign) === 'center' ? 'margin-left: auto; margin-right: auto;' : 
          (mobile_text_align || effectiveHeadingAlign) === 'right' ? 'margin-left: auto; margin-right: 0;' : 
          'margin-left: 0; margin-right: auto;'}
      }
      
      .${instanceId} .hero-subheading {
        font-size: ${mobileSubheadingFontSize}px;
        text-align: ${mobile_text_align || effectiveSubheadingAlign};
      }
      
      .${instanceId} .hero-content-text {
        font-size: ${mobileContentFontSize}px;
        text-align: ${mobile_text_align || effectiveContentAlign};
      }
      
      .${instanceId} .hero-button-wrapper {
        margin-top: ${mobileButtonTopMargin}px;
        text-align: ${content.mobile_button_align || content.button_align || mobileTextAlign};
      }
    }
  `;

  const fullWidthClass = fullWidth ? 'w-screen relative left-1/2 right-1/2 -ml-[50vw] -mr-[50vw]' : '';

  if (isImageSized) {
    return (
      <div className={`${instanceId} ${fullWidthClass}`}>
        <style>{responsiveStyles}</style>
        <div 
          style={{ 
            display: 'grid',
            gridTemplateColumns: '1fr',
            gridTemplateRows: '1fr',
            width: '100%'
          }}
        >
          <img 
            src={image_url} 
            alt={content.heading || 'Hero background'} 
            style={{ 
              gridColumn: '1 / -1',
              gridRow: '1 / -1',
              display: 'block', 
              width: '100%', 
              height: 'auto' 
            }}
          />
          {overlay_enabled && (
            <div 
              style={{ 
                gridColumn: '1 / -1',
                gridRow: '1 / -1',
                backgroundColor: overlay_color, 
                opacity: parseInt(overlay_opacity) / 100
              }} 
            />
          )}
          <div 
            style={{ 
              gridColumn: '1 / -1',
              gridRow: '1 / -1',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: getTextVerticalAlign()
            }}
          >
            <div className="hero-content max-w-7xl mx-auto w-full">
              {content.heading && (
                <div>
                  <h1 
                    className="hero-heading font-bold hero-rich-text-content"
                    style={{ 
                      marginBottom: heading_underline_enabled 
                        ? `${heading_underline_spacing}px` 
                        : (content.subheading || (button && button.text)) ? '24px' : '0'
                    }}
                    dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(content.heading) }}
                  />
                  {heading_underline_enabled && (
                    <div 
                      className="hero-underline"
                      style={{
                        height: `${heading_underline_weight}px`,
                        backgroundColor: heading_underline_color,
                        marginBottom: (content.subheading || (button && button.text)) ? `${heading_underline_to_content_spacing}px` : '0'
                      }}
                    />
                  )}
                </div>
              )}
              {content.subheading && (
                <div 
                  className="hero-subheading opacity-90 hero-rich-text-content"
                  style={{ 
                    marginBottom: content_text ? '0' : (button && button.text) ? '24px' : '0'
                  }}
                  dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(content.subheading) }}
                />
              )}
              {content_text && (
                <div 
                  className="hero-content-text opacity-90 hero-rich-text-content"
                  dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(content_text) }}
                />
              )}
              {button && button.link && (button.text || button.show_arrow) && (
                <div className="hero-button-wrapper" style={{ marginBottom: 0 }}>
                  <AGCASButton
                    text={button.text}
                    link={button.link}
                    buttonStyleId={button.button_style_id}
                    customBgColor={button.custom_bg_color}
                    customTextColor={button.custom_text_color}
                    customBorderColor={button.custom_border_color}
                    transparentBg={button.transparent_bg}
                    openInNewTab={button.open_in_new_tab}
                    size={button.size || 'large'}
                    showArrow={button.show_arrow}
                    useGradientStyle={button.style_type === 'gradient'}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`${instanceId} ${fullWidthClass}`}>
      <style>{responsiveStyles}</style>
      <div 
        className="hero-container relative w-full overflow-hidden"
        style={{ ...getBackgroundStyle() }}
      >
        {background_type === 'image' && image_url && (
          <>
            <img 
              src={image_url} 
              alt={content.heading || 'Hero background'} 
              className="absolute inset-0 w-full h-full"
              style={{ objectFit: image_fit }}
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
        
        <div className="hero-content relative max-w-7xl mx-auto">
          {content.heading && (
            <div>
              <h1 
                className="hero-heading font-bold hero-rich-text-content"
                style={{ 
                  marginBottom: heading_underline_enabled 
                    ? `${heading_underline_spacing}px` 
                    : (content.subheading || content_text || (button && button.text)) ? '24px' : '0'
                }}
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(content.heading) }}
              />
              {heading_underline_enabled && (
                <div 
                  className="hero-underline"
                  style={{
                    height: `${heading_underline_weight}px`,
                    backgroundColor: heading_underline_color,
                    marginBottom: (content.subheading || content_text || (button && button.text)) ? `${heading_underline_to_content_spacing}px` : '0'
                  }}
                />
              )}
            </div>
          )}
          {content.subheading && (
            <div 
              className="hero-subheading opacity-90 hero-rich-text-content"
              style={{ 
                marginBottom: content_text ? '0' : (button && button.text) ? '24px' : '0'
              }}
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(content.subheading) }}
            />
          )}
          {content_text && (
            <div 
              className="hero-content-text opacity-90 hero-rich-text-content"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(content_text) }}
            />
          )}
          {button && button.link && (button.text || button.show_arrow) && (
            <div className="hero-button-wrapper" style={{ marginBottom: 0 }}>
              <AGCASButton
                text={button.text}
                link={button.link}
                buttonStyleId={button.button_style_id}
                customBgColor={button.custom_bg_color}
                customTextColor={button.custom_text_color}
                customBorderColor={button.custom_border_color}
                transparentBg={button.transparent_bg}
                openInNewTab={button.open_in_new_tab}
                size={button.size || 'large'}
                showArrow={button.show_arrow}
                useGradientStyle={button.style_type === 'gradient'}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function IEditHeroElementEditor({ element, onChange }) {
  const defaultButton = { 
    text: '', 
    link: '', 
    button_style_id: '', 
    open_in_new_tab: false, 
    size: 'large', 
    show_arrow: false, 
    custom_bg_color: '', 
    custom_text_color: '', 
    custom_border_color: '',
    transparent_bg: false
  };

  const content = element.content || {};
  const backgroundType = content.background_type || 'color';

  const [isUploading, setIsUploading] = useState(false);
  const [buttonStyles, setButtonStyles] = useState([]);
  const [expandedSections, setExpandedSections] = useState({
    background: false,
    heading: true,
    subheading: false,
    content: false,
    button: false,
    mobile: false
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

  const updateButton = (keyOrUpdates, value) => {
    const currentButton = content.button || defaultButton;
    if (typeof keyOrUpdates === 'object') {
      updateContent('button', { ...currentButton, ...keyOrUpdates });
    } else {
      updateContent('button', { ...currentButton, [keyOrUpdates]: value });
    }
  };

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

  const button = content.button || defaultButton;
  const gradientPreview = `linear-gradient(${content.gradient_angle || 135}deg, ${content.gradient_start_color || '#3b82f6'}, ${content.gradient_end_color || '#8b5cf6'})`;

  const defaultMobileHeadingSize = Math.max(28, Math.round((content.heading_font_size || 48) * 0.6));
  const defaultMobileSubheadingSize = Math.max(16, Math.round((content.subheading_font_size || 20) * 0.8));
  const defaultMobileContentSize = Math.max(14, Math.round((content.content_font_size || 16) * 0.9));
  const defaultMobilePaddingTop = Math.max(40, Math.round((content.padding_top || 80) * 0.5));
  const defaultMobilePaddingBottom = Math.max(40, Math.round((content.padding_bottom || 80) * 0.5));
  const defaultMobileButtonMargin = Math.max(16, Math.round((content.button_top_margin || 32) * 0.75));

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

  return (
    <div className="space-y-4">
        
        {/* Background & Layout Section */}
        <div className="border rounded-lg overflow-hidden">
          <button
            type="button"
            onClick={() => toggleSection('background')}
            className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
            data-testid="accordion-hero-background"
          >
            <span className="font-semibold text-sm">Background & Layout</span>
            {expandedSections.background ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
          
          {expandedSections.background && (
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Background Type</label>
                <select
                  value={backgroundType}
                  onChange={(e) => updateContent('background_type', e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                >
                  <option value="color">Solid Color</option>
                  <option value="gradient">Gradient</option>
                  <option value="image">Image</option>
                </select>
              </div>

              {backgroundType === 'color' && (
                <div>
                  <label className="block text-sm font-medium mb-1">Background Color</label>
                  <div className="flex gap-2 items-center">
                    <input
                      type="color"
                      value={content.background_color || '#3b82f6'}
                      onChange={(e) => updateContent('background_color', e.target.value)}
                      className="w-16 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                    />
                    <input
                      type="text"
                      value={content.background_color || '#3b82f6'}
                      onChange={(e) => updateContent('background_color', e.target.value)}
                      className="flex-1 px-3 py-2 border border-slate-300 rounded-md font-mono text-sm"
                      placeholder="#3b82f6"
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
                      <label className="block text-sm font-medium mb-1">Start Color</label>
                      <div className="flex gap-2 items-center">
                        <input
                          type="color"
                          value={content.gradient_start_color || '#3b82f6'}
                          onChange={(e) => updateContent('gradient_start_color', e.target.value)}
                          className="w-12 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                        />
                        <input
                          type="text"
                          value={content.gradient_start_color || '#3b82f6'}
                          onChange={(e) => updateContent('gradient_start_color', e.target.value)}
                          className="flex-1 px-2 py-2 border border-slate-300 rounded-md font-mono text-xs"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">End Color</label>
                      <div className="flex gap-2 items-center">
                        <input
                          type="color"
                          value={content.gradient_end_color || '#8b5cf6'}
                          onChange={(e) => updateContent('gradient_end_color', e.target.value)}
                          className="w-12 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                        />
                        <input
                          type="text"
                          value={content.gradient_end_color || '#8b5cf6'}
                          onChange={(e) => updateContent('gradient_end_color', e.target.value)}
                          className="flex-1 px-2 py-2 border border-slate-300 rounded-md font-mono text-xs"
                        />
                      </div>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">Angle: {content.gradient_angle || 135}°</label>
                    <input
                      type="range"
                      min="0"
                      max="360"
                      value={content.gradient_angle || 135}
                      onChange={(e) => updateContent('gradient_angle', parseInt(e.target.value))}
                      className="w-full"
                    />
                    <div className="flex justify-between text-xs text-slate-500 mt-1">
                      <span>0° (Right)</span>
                      <span>90° (Down)</span>
                      <span>180° (Left)</span>
                      <span>270° (Up)</span>
                    </div>
                  </div>
                </div>
              )}

              {backgroundType === 'image' && (
                <>
                  <div>
                    <label className="block text-sm font-medium mb-1">Background Image</label>
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
                    <label className="block text-sm font-medium mb-1">Image Scaling</label>
                    <select
                      value={content.image_fit || 'cover'}
                      onChange={(e) => updateContent('image_fit', e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md"
                    >
                      <option value="cover">Fill container (scale proportionally, may crop edges)</option>
                      <option value="contain">Fit entire image (scale proportionally, may show gaps)</option>
                    </select>
                    <p className="text-xs text-slate-500 mt-1">
                      {content.image_fit === 'contain' 
                        ? 'The full image will be visible, but there may be empty space around it.'
                        : 'Image fills the full width and height, keeping proportions. Parts may be cropped if needed.'}
                    </p>
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

              <div>
                <label className="block text-sm font-medium mb-1">Text Color</label>
                <div className="flex gap-2 items-center">
                  <input
                    type="color"
                    value={content.text_color || '#ffffff'}
                    onChange={(e) => updateContent('text_color', e.target.value)}
                    className="w-16 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                  />
                  <input
                    type="text"
                    value={content.text_color || '#ffffff'}
                    onChange={(e) => updateContent('text_color', e.target.value)}
                    className="flex-1 px-3 py-2 border border-slate-300 rounded-md font-mono text-sm"
                    placeholder="#ffffff"
                  />
                </div>
              </div>

              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium mb-1">Container Height</label>
                  <select
                    value={content.height_type || 'auto'}
                    onChange={(e) => updateContent('height_type', e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md"
                  >
                    <option value="auto">Auto (Based on Content)</option>
                    <option value="full">Full Viewport</option>
                    <option value="custom">Custom</option>
                    {backgroundType === 'image' && (
                      <option value="image">Match Image Size (text overlays image)</option>
                    )}
                  </select>
                  {content.height_type === 'image' && backgroundType === 'image' && (
                    <p className="text-xs text-slate-500 mt-1">
                      Container will match the image's natural dimensions. Text will overlay the image.
                    </p>
                  )}
                </div>

                {content.height_type === 'custom' && (
                  <div>
                    <label className="block text-sm font-medium mb-1">Custom Height (px)</label>
                    <input
                      type="number"
                      value={content.custom_height || 400}
                      onChange={(e) => updateContent('custom_height', parseInt(e.target.value) || 400)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md"
                      min="100"
                    />
                  </div>
                )}

                {content.height_type === 'image' && backgroundType === 'image' && (
                  <div>
                    <label className="block text-sm font-medium mb-1">Text Vertical Position</label>
                    <select
                      value={content.text_vertical_align || 'center'}
                      onChange={(e) => updateContent('text_vertical_align', e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md"
                    >
                      <option value="top">Top</option>
                      <option value="center">Center</option>
                      <option value="bottom">Bottom</option>
                    </select>
                  </div>
                )}
              </div>

              <div className="space-y-3">
                <h4 className="text-sm font-semibold">Padding</h4>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium mb-1">Top (px)</label>
                    <input
                      type="number"
                      value={content.padding_top || 80}
                      onChange={(e) => updateContent('padding_top', parseInt(e.target.value) || 0)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md"
                      min="0"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">Bottom (px)</label>
                    <input
                      type="number"
                      value={content.padding_bottom || 80}
                      onChange={(e) => updateContent('padding_bottom', parseInt(e.target.value) || 0)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md"
                      min="0"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">Left (px)</label>
                    <input
                      type="number"
                      value={content.padding_left || 16}
                      onChange={(e) => updateContent('padding_left', parseInt(e.target.value) || 0)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md"
                      min="0"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">Right (px)</label>
                    <input
                      type="number"
                      value={content.padding_right || 16}
                      onChange={(e) => updateContent('padding_right', parseInt(e.target.value) || 0)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md"
                      min="0"
                    />
                  </div>
                </div>
              </div>

              <AlignmentButtons 
                value={content.text_align || 'center'} 
                onChange={(val) => updateContent('text_align', val)}
                label="Default Text Alignment"
                testIdPrefix="hero-default-align"
              />
            </div>
          )}
        </div>

        {/* Heading Section */}
        <div className="border rounded-lg overflow-hidden">
          <button
            type="button"
            onClick={() => toggleSection('heading')}
            className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
            data-testid="accordion-hero-heading"
          >
            <span className="font-semibold text-sm">Heading</span>
            {expandedSections.heading ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
          
          {expandedSections.heading && (
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Heading</label>
                <div className="hero-quill-editor border border-slate-300 rounded-md overflow-hidden bg-white">
                  <ReactQuill
                    theme="snow"
                    value={content.heading || ''}
                    onChange={(value) => updateContent('heading', value)}
                    modules={heroQuillModules}
                    placeholder="Enter heading..."
                    style={{ minHeight: '80px' }}
                  />
                </div>
              </div>

              <AlignmentButtons 
                value={content.heading_text_align || content.text_align || 'center'} 
                onChange={(val) => updateContent('heading_text_align', val)}
                label="Alignment"
                testIdPrefix="hero-heading-align"
              />

              <TypographyStyleSelector
                value={content.heading_typography_style_id}
                onChange={(styleId, style) => {
                  const updates = { heading_typography_style_id: styleId };
                  if (style) {
                    const mapped = applyTypographyStyle(style);
                    if (mapped.font_family) updates.heading_font_family = mapped.font_family;
                    if (mapped.font_size) updates.heading_font_size = mapped.font_size;
                    if (mapped.font_size_mobile) updates.mobile_heading_font_size = mapped.font_size_mobile;
                    if (mapped.letter_spacing !== undefined) updates.heading_letter_spacing = mapped.letter_spacing;
                    if (mapped.line_height) updates.heading_line_height = mapped.line_height;
                    if (mapped.text_transform) updates.heading_text_transform = mapped.text_transform;
                    if (mapped.font_weight) updates.heading_font_weight = mapped.font_weight;
                  }
                  updateMultipleContent(updates);
                }}
                label="Heading Typography Style"
              />

              <details className="text-xs">
                <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
                <div className="mt-3 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium mb-1">Heading Font</label>
                      <select
                        value={content.heading_font_family || 'Poppins'}
                        onChange={(e) => updateContent('heading_font_family', e.target.value)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md"
                      >
                        <option value="Poppins">Poppins</option>
                        <option value="Degular Medium">Degular Medium</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Heading Size (px)</label>
                      <input
                        type="number"
                        value={content.heading_font_size || 48}
                        onChange={(e) => updateContent('heading_font_size', parseInt(e.target.value) || 48)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md"
                        min="12"
                        max="200"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Line Height</label>
                      <input
                        type="number"
                        step="0.1"
                        value={content.heading_line_height || 1.2}
                        onChange={(e) => updateContent('heading_line_height', parseFloat(e.target.value) || 1.2)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md"
                        min="0.8"
                        max="3"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Letter Spacing (px)</label>
                      <input
                        type="number"
                        step="0.5"
                        value={content.heading_letter_spacing || 0}
                        onChange={(e) => updateContent('heading_letter_spacing', parseFloat(e.target.value) || 0)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md"
                        min="-5"
                        max="20"
                      />
                    </div>
                  </div>
                </div>
              </details>

              <div className="space-y-3 p-3 bg-slate-50 rounded-lg">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="underline-enabled"
                    checked={content.heading_underline_enabled || false}
                    onChange={(e) => updateContent('heading_underline_enabled', e.target.checked)}
                    className="w-4 h-4"
                  />
                  <label htmlFor="underline-enabled" className="text-sm font-medium cursor-pointer">
                    Show line below heading
                  </label>
                </div>

                {content.heading_underline_enabled && (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-sm font-medium mb-1">Line Color</label>
                        <input
                          type="color"
                          value={content.heading_underline_color || '#000000'}
                          onChange={(e) => updateContent('heading_underline_color', e.target.value)}
                          className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium mb-1">Line Width (px)</label>
                        <input
                          type="number"
                          value={content.heading_underline_width || 100}
                          onChange={(e) => updateContent('heading_underline_width', parseInt(e.target.value) || 0)}
                          className="w-full px-3 py-2 border border-slate-300 rounded-md"
                          min="10"
                          max="1000"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-sm font-medium mb-1">Line Weight (px)</label>
                        <input
                          type="number"
                          value={content.heading_underline_weight || 2}
                          onChange={(e) => updateContent('heading_underline_weight', parseInt(e.target.value) || 1)}
                          className="w-full px-3 py-2 border border-slate-300 rounded-md"
                          min="1"
                          max="20"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium mb-1">Spacing from Header (px)</label>
                        <input
                          type="number"
                          value={content.heading_underline_spacing || 16}
                          onChange={(e) => updateContent('heading_underline_spacing', parseInt(e.target.value) || 0)}
                          className="w-full px-3 py-2 border border-slate-300 rounded-md"
                          min="0"
                          max="100"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Spacing to Content (px)</label>
                      <input
                        type="number"
                        value={content.heading_underline_to_content_spacing || 24}
                        onChange={(e) => updateContent('heading_underline_to_content_spacing', parseInt(e.target.value) || 0)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md"
                        min="0"
                        max="100"
                      />
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Subheading Section */}
        <div className="border rounded-lg overflow-hidden">
          <button
            type="button"
            onClick={() => toggleSection('subheading')}
            className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
            data-testid="accordion-hero-subheading"
          >
            <span className="font-semibold text-sm">Subheading</span>
            {expandedSections.subheading ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
          
          {expandedSections.subheading && (
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Subheading</label>
                <div className="hero-quill-editor border border-slate-300 rounded-md overflow-hidden bg-white">
                  <ReactQuill
                    theme="snow"
                    value={content.subheading || ''}
                    onChange={(value) => updateContent('subheading', value)}
                    modules={heroQuillModules}
                    placeholder="Enter subheading..."
                    style={{ minHeight: '100px' }}
                  />
                </div>
              </div>

              <AlignmentButtons 
                value={content.subheading_text_align || content.text_align || 'center'} 
                onChange={(val) => updateContent('subheading_text_align', val)}
                label="Alignment"
                testIdPrefix="hero-subheading-align"
              />

              <TypographyStyleSelector
                value={content.subheading_typography_style_id}
                onChange={(styleId, style) => {
                  const updates = { subheading_typography_style_id: styleId };
                  if (style) {
                    const mapped = applyTypographyStyle(style);
                    if (mapped.font_family) updates.subheading_font_family = mapped.font_family;
                    if (mapped.font_size) updates.subheading_font_size = mapped.font_size;
                    if (mapped.font_size_mobile) updates.mobile_subheading_font_size = mapped.font_size_mobile;
                    if (mapped.line_height) updates.subheading_line_height = mapped.line_height;
                    if (mapped.letter_spacing !== undefined) updates.subheading_letter_spacing = mapped.letter_spacing;
                    if (mapped.font_weight) updates.subheading_font_weight = mapped.font_weight;
                  }
                  updateMultipleContent(updates);
                }}
                label="Subheading Typography Style"
              />

              <details className="text-xs">
                <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
                <div className="mt-3 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium mb-1">Subheading Font</label>
                      <select
                        value={content.subheading_font_family || 'Poppins'}
                        onChange={(e) => updateContent('subheading_font_family', e.target.value)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md"
                      >
                        <option value="Poppins">Poppins</option>
                        <option value="Degular Medium">Degular Medium</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Size (px)</label>
                      <input
                        type="number"
                        value={content.subheading_font_size || 20}
                        onChange={(e) => updateContent('subheading_font_size', parseInt(e.target.value) || 20)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md"
                        min="12"
                        max="100"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Line Height</label>
                      <input
                        type="number"
                        step="0.1"
                        value={content.subheading_line_height || 1.5}
                        onChange={(e) => updateContent('subheading_line_height', parseFloat(e.target.value) || 1.5)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md"
                        min="1"
                        max="3"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Letter Spacing (px)</label>
                      <input
                        type="number"
                        step="0.5"
                        value={content.subheading_letter_spacing || 0}
                        onChange={(e) => updateContent('subheading_letter_spacing', parseFloat(e.target.value) || 0)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md"
                        min="-5"
                        max="20"
                      />
                    </div>
                  </div>
                </div>
              </details>
            </div>
          )}
        </div>

        {/* Content Text Section */}
        <div className="border rounded-lg overflow-hidden">
          <button
            type="button"
            onClick={() => toggleSection('content')}
            className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
            data-testid="accordion-hero-content"
          >
            <span className="font-semibold text-sm">Content Text</span>
            {expandedSections.content ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
          
          {expandedSections.content && (
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Content</label>
                <div className="hero-quill-editor border border-slate-300 rounded-md overflow-hidden bg-white">
                  <ReactQuill
                    theme="snow"
                    value={content.content_text || ''}
                    onChange={(value) => updateContent('content_text', value)}
                    modules={heroQuillModules}
                    placeholder="Enter content text (optional)..."
                    style={{ minHeight: '120px' }}
                  />
                </div>
              </div>

              <AlignmentButtons 
                value={content.content_text_align || content.text_align || 'center'} 
                onChange={(val) => updateContent('content_text_align', val)}
                label="Alignment"
                testIdPrefix="hero-content-align"
              />

              <TypographyStyleSelector
                value={content.content_typography_style_id}
                onChange={(styleId, style) => {
                  const updates = { content_typography_style_id: styleId };
                  if (style) {
                    const mapped = applyTypographyStyle(style);
                    if (mapped.font_family) updates.content_font_family = mapped.font_family;
                    if (mapped.font_size) updates.content_font_size = mapped.font_size;
                    if (mapped.font_size_mobile) updates.mobile_content_font_size = mapped.font_size_mobile;
                    if (mapped.line_height) updates.content_line_height = mapped.line_height;
                    if (mapped.letter_spacing !== undefined) updates.content_letter_spacing = mapped.letter_spacing;
                    if (mapped.font_weight) updates.content_font_weight = mapped.font_weight;
                    if (mapped.color) updates.content_color = mapped.color;
                  }
                  updateMultipleContent(updates);
                }}
                label="Content Typography Style"
              />

              <details className="text-xs">
                <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
                <div className="mt-3 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium mb-1">Content Font</label>
                      <select
                        value={content.content_font_family || 'Poppins'}
                        onChange={(e) => updateContent('content_font_family', e.target.value)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md"
                      >
                        <option value="Poppins">Poppins</option>
                        <option value="Degular Medium">Degular Medium</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Size (px)</label>
                      <input
                        type="number"
                        value={content.content_font_size || 16}
                        onChange={(e) => updateContent('content_font_size', parseInt(e.target.value) || 16)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md"
                        min="12"
                        max="100"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Line Height</label>
                      <input
                        type="number"
                        step="0.1"
                        value={content.content_line_height || 1.6}
                        onChange={(e) => updateContent('content_line_height', parseFloat(e.target.value) || 1.6)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md"
                        min="1"
                        max="3"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Letter Spacing (px)</label>
                      <input
                        type="number"
                        step="0.5"
                        value={content.content_letter_spacing || 0}
                        onChange={(e) => updateContent('content_letter_spacing', parseFloat(e.target.value) || 0)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md"
                        min="-5"
                        max="20"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Top Margin (px)</label>
                      <input
                        type="number"
                        value={content.content_top_margin || 24}
                        onChange={(e) => updateContent('content_top_margin', parseInt(e.target.value) || 24)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md"
                        min="0"
                        max="200"
                      />
                      <p className="text-xs text-slate-500 mt-1">Space above content</p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Content Color</label>
                      <div className="flex items-center gap-2 mb-1">
                        <input
                          type="checkbox"
                          id="content-use-text-color"
                          checked={!content.content_color}
                          onChange={(e) => {
                            if (e.target.checked) {
                              updateContent('content_color', '');
                            } else {
                              updateContent('content_color', content.text_color || '#ffffff');
                            }
                          }}
                          className="w-4 h-4"
                        />
                        <label htmlFor="content-use-text-color" className="text-xs cursor-pointer">
                          Use main text color
                        </label>
                      </div>
                      {content.content_color && (
                        <div className="flex gap-2 items-center">
                          <input
                            type="color"
                            value={content.content_color}
                            onChange={(e) => updateContent('content_color', e.target.value)}
                            className="w-16 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                          />
                          <input
                            type="text"
                            value={content.content_color}
                            onChange={(e) => updateContent('content_color', e.target.value)}
                            className="flex-1 px-2 py-1.5 border border-slate-300 rounded-md font-mono text-sm"
                          />
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </details>
            </div>
          )}
        </div>

        {/* Button Section */}
        <div className="border rounded-lg overflow-hidden">
          <button
            type="button"
            onClick={() => toggleSection('button')}
            className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
            data-testid="accordion-hero-button"
          >
            <span className="font-semibold text-sm">Button</span>
            {expandedSections.button ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
          
          {expandedSections.button && (
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Button Text</label>
                <input
                  type="text"
                  value={button.text || ''}
                  onChange={(e) => updateButton('text', e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                  placeholder="e.g., Get Started"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Link URL</label>
                <input
                  type="text"
                  value={button.link || ''}
                  onChange={(e) => updateButton('link', e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                  placeholder="https://..."
                />
              </div>

              <AlignmentButtons 
                value={content.button_align || content.text_align || 'center'} 
                onChange={(val) => updateContent('button_align', val)}
                label="Button Alignment"
                testIdPrefix="hero-button-align"
              />

              <div>
                <label className="block text-sm font-medium mb-1">Button Style Type</label>
                <select
                  value={button.style_type || 'custom'}
                  onChange={(e) => updateButton('style_type', e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                >
                  <option value="custom">Custom Style</option>
                  <option value="gradient">Gradient Style (Join Us button)</option>
                </select>
                <p className="text-xs text-slate-500 mt-1">
                  {button.style_type === 'gradient' 
                    ? 'Uses the same style as the "Join Us" button in the header' 
                    : 'Configure custom colors below or select a saved button style'}
                </p>
              </div>

              {button.style_type === 'gradient' && (
                <div 
                  className="p-4 rounded-md text-center"
                  style={{ 
                    background: 'linear-gradient(to top right, #5C0085, #BA0087, #EE00C3, #FF4229, #FFB000)'
                  }}
                >
                  <span className="text-white font-bold text-sm">Gradient Style Preview</span>
                </div>
              )}

              {button.style_type !== 'gradient' && (
                <>
                  <div>
                    <label className="block text-sm font-medium mb-1">Saved Button Style</label>
                    <select
                      value={button.button_style_id || ''}
                      onChange={(e) => updateButton('button_style_id', e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md"
                    >
                      <option value="">None (use custom colors)</option>
                      {buttonStyles.map((style) => (
                        <option key={style.id} value={style.id}>
                          {style.name}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-slate-500 mt-1">Or use custom colors below</p>
                  </div>

                  <div className="flex items-center gap-2 mb-2">
                    <input
                      type="checkbox"
                      id="transparent-bg-hero"
                      checked={button.transparent_bg || false}
                      onChange={(e) => {
                        const isTransparent = e.target.checked;
                        if (isTransparent) {
                          updateButton({ transparent_bg: true, custom_bg_color: '' });
                        } else {
                          updateButton('transparent_bg', false);
                        }
                      }}
                      className="w-4 h-4"
                    />
                    <label htmlFor="transparent-bg-hero" className="text-sm cursor-pointer">
                      Transparent background
                    </label>
                  </div>

                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-sm font-medium mb-1">Background</label>
                      <div className="flex gap-2 items-center">
                        <input
                          type="color"
                          value={button.custom_bg_color || '#000000'}
                          onChange={(e) => {
                            updateButton({ custom_bg_color: e.target.value, transparent_bg: false });
                          }}
                          className={`w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer ${button.transparent_bg ? 'opacity-50' : ''}`}
                          disabled={button.transparent_bg}
                        />
                      </div>
                      {button.transparent_bg && (
                        <p className="text-xs text-slate-500 mt-1">Using transparent</p>
                      )}
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Text</label>
                      <input
                        type="color"
                        value={button.custom_text_color || '#ffffff'}
                        onChange={(e) => updateButton('custom_text_color', e.target.value)}
                        className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Border</label>
                      <input
                        type="color"
                        value={button.custom_border_color || '#000000'}
                        onChange={(e) => updateButton('custom_border_color', e.target.value)}
                        className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                      />
                    </div>
                  </div>
                </>
              )}

              <div>
                <label className="block text-sm font-medium mb-1">Button Size</label>
                <select
                  value={button.size || 'large'}
                  onChange={(e) => updateButton('size', e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                >
                  <option value="small">Small</option>
                  <option value="medium">Medium</option>
                  <option value="large">Large</option>
                  <option value="xlarge">Extra Large</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Button Top Margin (px)</label>
                <input
                  type="number"
                  value={content.button_top_margin || 32}
                  onChange={(e) => updateContent('button_top_margin', parseInt(e.target.value) || 0)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                  min="0"
                  max="200"
                />
                <p className="text-xs text-slate-500 mt-1">Space between text and button</p>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="arrow-hero"
                  checked={button.show_arrow || false}
                  onChange={(e) => updateButton('show_arrow', e.target.checked)}
                  className="w-4 h-4"
                />
                <label htmlFor="arrow-hero" className="text-sm cursor-pointer">
                  Show arrow icon
                </label>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="new-tab-hero"
                  checked={button.open_in_new_tab || false}
                  onChange={(e) => updateButton('open_in_new_tab', e.target.checked)}
                  className="w-4 h-4"
                />
                <label htmlFor="new-tab-hero" className="text-sm cursor-pointer">
                  Open in new tab
                </label>
              </div>
            </div>
          )}
        </div>

        {/* Mobile Settings Section */}
        <div className="border rounded-lg overflow-hidden">
          <button
            type="button"
            onClick={() => toggleSection('mobile')}
            className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
            data-testid="accordion-hero-mobile"
          >
            <span className="font-semibold text-sm">Mobile Settings</span>
            {expandedSections.mobile ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
          
          {expandedSections.mobile && (
            <div className="p-4 space-y-4 bg-blue-50 rounded-lg">
              <p className="text-xs text-slate-600 mb-3">
                Leave fields empty to use automatic scaling based on desktop values.
              </p>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-sm font-medium mb-1">
                    Mobile Heading Size
                    <span className="text-xs text-slate-500 block">Default: {defaultMobileHeadingSize}px</span>
                  </label>
                  <input
                    type="number"
                    value={content.mobile_heading_font_size || ''}
                    onChange={(e) => updateContent('mobile_heading_font_size', e.target.value ? parseInt(e.target.value) : '')}
                    placeholder={defaultMobileHeadingSize}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md"
                    min="16"
                    max="96"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">
                    Mobile Subheading Size
                    <span className="text-xs text-slate-500 block">Default: {defaultMobileSubheadingSize}px</span>
                  </label>
                  <input
                    type="number"
                    value={content.mobile_subheading_font_size || ''}
                    onChange={(e) => updateContent('mobile_subheading_font_size', e.target.value ? parseInt(e.target.value) : '')}
                    placeholder={defaultMobileSubheadingSize}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md"
                    min="12"
                    max="48"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">
                    Mobile Content Size
                    <span className="text-xs text-slate-500 block">Default: {defaultMobileContentSize}px</span>
                  </label>
                  <input
                    type="number"
                    value={content.mobile_content_font_size || ''}
                    onChange={(e) => updateContent('mobile_content_font_size', e.target.value ? parseInt(e.target.value) : '')}
                    placeholder={defaultMobileContentSize}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md"
                    min="10"
                    max="36"
                  />
                </div>
              </div>

              {content.height_type !== 'image' && (
                <div className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium mb-1">Mobile Container Height</label>
                    <select
                      value={content.mobile_height_type || 'auto'}
                      onChange={(e) => updateContent('mobile_height_type', e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md"
                    >
                      <option value="auto">Auto (Based on Content)</option>
                      <option value="full">Full Viewport</option>
                      <option value="custom">Custom</option>
                    </select>
                  </div>

                  {content.mobile_height_type === 'custom' && (
                    <div>
                      <label className="block text-sm font-medium mb-1">Mobile Custom Height (px)</label>
                      <input
                        type="number"
                        value={content.mobile_custom_height || 300}
                        onChange={(e) => updateContent('mobile_custom_height', parseInt(e.target.value) || 300)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md"
                        min="100"
                      />
                    </div>
                  )}
                </div>
              )}

              <div className="space-y-3">
                <h5 className="text-sm font-medium">Mobile Padding</h5>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium mb-1">
                      Top
                      <span className="text-xs text-slate-500 block">Default: {defaultMobilePaddingTop}px</span>
                    </label>
                    <input
                      type="number"
                      value={content.mobile_padding_top ?? ''}
                      onChange={(e) => updateContent('mobile_padding_top', e.target.value ? parseInt(e.target.value) : undefined)}
                      placeholder={defaultMobilePaddingTop}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md"
                      min="0"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">
                      Bottom
                      <span className="text-xs text-slate-500 block">Default: {defaultMobilePaddingBottom}px</span>
                    </label>
                    <input
                      type="number"
                      value={content.mobile_padding_bottom ?? ''}
                      onChange={(e) => updateContent('mobile_padding_bottom', e.target.value ? parseInt(e.target.value) : undefined)}
                      placeholder={defaultMobilePaddingBottom}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md"
                      min="0"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">
                      Left
                      <span className="text-xs text-slate-500 block">Default: {content.padding_left || 16}px</span>
                    </label>
                    <input
                      type="number"
                      value={content.mobile_padding_left ?? ''}
                      onChange={(e) => updateContent('mobile_padding_left', e.target.value ? parseInt(e.target.value) : undefined)}
                      placeholder={content.padding_left || 16}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md"
                      min="0"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">
                      Right
                      <span className="text-xs text-slate-500 block">Default: {content.padding_right || 16}px</span>
                    </label>
                    <input
                      type="number"
                      value={content.mobile_padding_right ?? ''}
                      onChange={(e) => updateContent('mobile_padding_right', e.target.value ? parseInt(e.target.value) : undefined)}
                      placeholder={content.padding_right || 16}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md"
                      min="0"
                    />
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">
                  Mobile Text Alignment
                  <span className="text-xs text-slate-500 ml-2">Default: Same as desktop</span>
                </label>
                <select
                  value={content.mobile_text_align || ''}
                  onChange={(e) => updateContent('mobile_text_align', e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                >
                  <option value="">Same as Desktop ({content.text_align || 'center'})</option>
                  <option value="left">Left</option>
                  <option value="center">Center</option>
                  <option value="right">Right</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">
                  Mobile Button Top Margin
                  <span className="text-xs text-slate-500 block">Default: {defaultMobileButtonMargin}px</span>
                </label>
                <input
                  type="number"
                  value={content.mobile_button_top_margin ?? ''}
                  onChange={(e) => updateContent('mobile_button_top_margin', e.target.value ? parseInt(e.target.value) : undefined)}
                  placeholder={defaultMobileButtonMargin}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                  min="0"
                />
              </div>
            </div>
          )}
        </div>

    </div>
  );
}
