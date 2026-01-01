import { useState, useEffect, useId } from "react";
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import DOMPurify from 'dompurify';
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChevronDown, ChevronUp, Upload, X, AlignLeft, AlignCenter, AlignRight } from "lucide-react";
import AGCASButton from "../../ui/AGCASButton";
import TypographyStyleSelector, { applyTypographyStyle, useTypographyStyles } from "../TypographyStyleSelector";
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

export default function IEditFiftyFiftyElement({ content, variant, settings, previewViewport }) {
  const isMobile = useIsMobile();
  const isMobilePreview = previewViewport === 'mobile';
  const reactId = useId();
  const instanceId = `fiftyfifty-${reactId.replace(/:/g, '')}`;
  
  // Look up typography styles at render time to use current values from InstalledFonts
  const { getStyleById } = useTypographyStyles();
  
  const {
    anchor,
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
    // Mobile background settings (defaults to 'same' meaning use desktop values)
    mobile_background_type = 'same',
    mobile_background_color = '#ffffff',
    mobile_gradient_start_color = '#3b82f6',
    mobile_gradient_end_color = '#8b5cf6',
    mobile_gradient_angle = 135,
    mobile_background_image_url,
    mobile_background_image_fit = 'cover',
    mobile_overlay_enabled = false,
    mobile_overlay_color = '#000000',
    mobile_overlay_opacity = 50,
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
    left_column_padding_top = 0,
    left_column_padding_bottom = 0,
    right_column_padding_top = 0,
    right_column_padding_bottom = 0,
    column_border_radius = 0,
    button,
    button_column = 'left',
    button_align = 'right',
    button_top_padding = 0,
    button_inset_right = 0,
    button_inset_bottom = 0,
    left_vertical_alignment = 'center',
    right_vertical_alignment = 'center',
    reverse_on_mobile = false,
    column_gap = 32,
    vertical_padding = 48,
    // Mobile-specific layout
    mobile_vertical_padding,
    mobile_column_gap,
    mobile_custom_layout = false,
    // Section Header fields
    header_title = '',
    header_subtitle = '',
    header_content = '',
    header_align = 'center',
    header_font_family = 'Poppins',
    header_font_size = 32,
    header_font_size_mobile = 24,
    header_font_weight = 700,
    header_color = '#1e293b',
    header_line_height = 1.2,
    header_letter_spacing = 0,
    subtitle_font_family = 'Poppins',
    subtitle_font_size = 18,
    subtitle_font_size_mobile = 16,
    subtitle_font_weight = 400,
    subtitle_color = '#64748b',
    subtitle_line_height = 1.4,
    subtitle_letter_spacing = 0,
    content_font_family = 'Poppins',
    content_font_size = 16,
    content_font_size_mobile = 14,
    content_font_weight = 400,
    content_color = '#475569',
    content_line_height = 1.6,
    content_letter_spacing = 0
  } = content || {};

  // Look up typography styles for live rendering
  const headerTypographyStyle = getStyleById(content?.header_typography_style_id);
  const subtitleTypographyStyle = getStyleById(content?.subtitle_typography_style_id);
  const contentTypographyStyle = getStyleById(content?.content_typography_style_id);
  const leftHeadingStyle = getStyleById(content?.left_heading_typography_style_id);
  const leftSubheadingStyle = getStyleById(content?.left_subheading_typography_style_id);
  const leftContentStyle = getStyleById(content?.left_content_typography_style_id);
  const rightHeadingStyle = getStyleById(content?.right_heading_typography_style_id);
  const rightSubheadingStyle = getStyleById(content?.right_subheading_typography_style_id);
  const rightContentStyle = getStyleById(content?.right_content_typography_style_id);

  // Auto-scaled default values for mobile
  const defaultMobileHeaderSize = Math.max(20, Math.round(header_font_size * 0.75));
  const defaultMobileSubtitleSize = Math.max(14, Math.round(subtitle_font_size * 0.85));
  const defaultMobileContentSize = Math.max(13, Math.round(content_font_size * 0.9));
  const defaultMobileVerticalPadding = Math.max(24, Math.round(vertical_padding * 0.6));
  const defaultMobileColumnGap = Math.max(16, Math.round(column_gap * 0.5));

  // Desktop background CSS
  const getDesktopBackgroundCSS = () => {
    if (background_type === 'color') {
      return `background-color: ${background_color};`;
    }
    if (background_type === 'gradient') {
      return `background: linear-gradient(${gradient_angle}deg, ${gradient_start_color}, ${gradient_end_color});`;
    }
    return '';
  };

  // Mobile background CSS
  const getMobileBackgroundCSS = () => {
    const effectiveType = mobile_background_type === 'same' ? background_type : mobile_background_type;
    if (effectiveType === 'color') {
      const color = mobile_background_type === 'same' ? background_color : mobile_background_color;
      return `background-color: ${color} !important;`;
    }
    if (effectiveType === 'gradient') {
      const start = mobile_background_type === 'same' ? gradient_start_color : mobile_gradient_start_color;
      const end = mobile_background_type === 'same' ? gradient_end_color : mobile_gradient_end_color;
      const angle = mobile_background_type === 'same' ? gradient_angle : mobile_gradient_angle;
      return `background: linear-gradient(${angle}deg, ${start}, ${end}) !important;`;
    }
    return '';
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

  const hasBackground = background_type && background_type !== 'none';
  const hasMobileBackground = mobile_background_type !== 'same' && mobile_background_type && mobile_background_type !== 'none';

  // Helper to get typography style for a prefix (left/right heading/subheading/content)
  const getTypographyStyleForPrefix = (prefix) => {
    if (prefix === 'left_heading') return leftHeadingStyle;
    if (prefix === 'left_subheading') return leftSubheadingStyle;
    if (prefix === 'left_content') return leftContentStyle;
    if (prefix === 'right_heading') return rightHeadingStyle;
    if (prefix === 'right_subheading') return rightSubheadingStyle;
    if (prefix === 'right_content') return rightContentStyle;
    return null;
  };

  const getTextStyle = (prefix) => {
    const savedFontSize = content?.[`${prefix}_font_size`] || 16;
    const savedMobileFontSize = content?.[`${prefix}_font_size_mobile`];
    const savedFontFamily = content?.[`${prefix}_font_family`] || 'Poppins';
    const savedFontWeight = content?.[`${prefix}_font_weight`] || 400;
    const savedColor = content?.[`${prefix}_color`] || '#1e293b';
    const savedLetterSpacing = content?.[`${prefix}_letter_spacing`] || 0;
    const savedLineHeight = content?.[`${prefix}_line_height`] || 1.5;
    
    // Look up live typography style
    const liveStyle = getTypographyStyleForPrefix(prefix);
    
    // Priority: 1) Live style value, 2) Saved value
    const effectiveFontFamily = liveStyle?.font_family || savedFontFamily;
    const effectiveFontSize = liveStyle?.font_size || savedFontSize;
    const effectiveFontWeight = liveStyle?.font_weight || savedFontWeight;
    const effectiveColor = liveStyle?.color || savedColor;
    const effectiveLetterSpacing = liveStyle?.letter_spacing ?? savedLetterSpacing;
    const effectiveLineHeight = liveStyle?.line_height || savedLineHeight;
    
    // Mobile font size: 1) Live style mobile, 2) Saved mobile, 3) Auto-scaled
    const defaultMobileSize = Math.max(14, Math.round(effectiveFontSize * 0.85));
    const effectiveMobileFontSize = liveStyle?.font_size_mobile || savedMobileFontSize || defaultMobileSize;
    
    return {
      fontFamily: effectiveFontFamily,
      fontWeight: effectiveFontWeight,
      fontSize: `${(isMobile || isMobilePreview) && effectiveMobileFontSize ? effectiveMobileFontSize : effectiveFontSize}px`,
      color: effectiveColor,
      letterSpacing: `${effectiveLetterSpacing}px`,
      lineHeight: effectiveLineHeight
    };
  };

  const getVerticalAlignmentClass = (alignment) => ({
    top: 'justify-start',
    center: 'justify-center',
    bottom: 'justify-end'
  }[alignment] || 'justify-center');

  const leftAlignmentClass = getVerticalAlignmentClass(left_vertical_alignment);
  const rightAlignmentClass = getVerticalAlignmentClass(right_vertical_alignment);

  // Section header styles - with live typography lookups
  const getHeaderTitleStyle = () => {
    const effectiveFontFamily = headerTypographyStyle?.font_family || header_font_family;
    const effectiveFontSize = headerTypographyStyle?.font_size || header_font_size;
    const effectiveFontWeight = headerTypographyStyle?.font_weight || header_font_weight;
    const effectiveColor = headerTypographyStyle?.color || header_color;
    const effectiveLineHeight = headerTypographyStyle?.line_height || header_line_height;
    const effectiveLetterSpacing = headerTypographyStyle?.letter_spacing ?? header_letter_spacing;
    
    const defaultMobileSize = Math.max(20, Math.round(effectiveFontSize * 0.75));
    const effectiveMobileSize = headerTypographyStyle?.font_size_mobile || header_font_size_mobile || defaultMobileSize;
    
    return {
      fontFamily: effectiveFontFamily,
      fontSize: `${(isMobile || isMobilePreview) && effectiveMobileSize ? effectiveMobileSize : effectiveFontSize}px`,
      fontWeight: effectiveFontWeight,
      color: effectiveColor,
      lineHeight: effectiveLineHeight,
      letterSpacing: `${effectiveLetterSpacing}px`
    };
  };

  const getSubtitleStyle = () => {
    const effectiveFontFamily = subtitleTypographyStyle?.font_family || subtitle_font_family;
    const effectiveFontSize = subtitleTypographyStyle?.font_size || subtitle_font_size;
    const effectiveFontWeight = subtitleTypographyStyle?.font_weight || subtitle_font_weight;
    const effectiveColor = subtitleTypographyStyle?.color || subtitle_color;
    const effectiveLineHeight = subtitleTypographyStyle?.line_height || subtitle_line_height;
    const effectiveLetterSpacing = subtitleTypographyStyle?.letter_spacing ?? subtitle_letter_spacing;
    
    const defaultMobileSize = Math.max(14, Math.round(effectiveFontSize * 0.85));
    const effectiveMobileSize = subtitleTypographyStyle?.font_size_mobile || subtitle_font_size_mobile || defaultMobileSize;
    
    return {
      fontFamily: effectiveFontFamily,
      fontSize: `${(isMobile || isMobilePreview) && effectiveMobileSize ? effectiveMobileSize : effectiveFontSize}px`,
      fontWeight: effectiveFontWeight,
      color: effectiveColor,
      lineHeight: effectiveLineHeight,
      letterSpacing: `${effectiveLetterSpacing}px`
    };
  };

  const getContentStyle = () => {
    const effectiveFontFamily = contentTypographyStyle?.font_family || content_font_family;
    const effectiveFontSize = contentTypographyStyle?.font_size || content_font_size;
    const effectiveFontWeight = contentTypographyStyle?.font_weight || content_font_weight;
    const effectiveColor = contentTypographyStyle?.color || content_color;
    const effectiveLineHeight = contentTypographyStyle?.line_height || content_line_height;
    const effectiveLetterSpacing = contentTypographyStyle?.letter_spacing ?? content_letter_spacing;
    
    const defaultMobileSize = Math.max(13, Math.round(effectiveFontSize * 0.9));
    const effectiveMobileSize = contentTypographyStyle?.font_size_mobile || content_font_size_mobile || defaultMobileSize;
    
    return {
      fontFamily: effectiveFontFamily,
      fontSize: `${(isMobile || isMobilePreview) && effectiveMobileSize ? effectiveMobileSize : effectiveFontSize}px`,
      fontWeight: effectiveFontWeight,
      color: effectiveColor,
      lineHeight: effectiveLineHeight,
      letterSpacing: `${effectiveLetterSpacing}px`
    };
  };

  // Helper to check if a text value has actual content (not empty/whitespace/empty HTML tags)
  const hasContent = (value) => {
    if (!value) return false;
    // Strip HTML tags and check if there's actual text content
    const stripped = value.replace(/<[^>]*>/g, '').trim();
    return stripped.length > 0;
  };

  // Check section header content using the helper
  const hasHeaderTitle = hasContent(header_title);
  const hasHeaderSubtitle = hasContent(header_subtitle);
  const hasHeaderContentText = hasContent(header_content);
  const hasHeaderContent = hasHeaderTitle || hasHeaderSubtitle || hasHeaderContentText;

  const headerAlignmentClass = {
    left: 'text-left',
    center: 'text-center',
    right: 'text-right'
  }[header_align] || 'text-center';

  const renderTextContent = (side) => {
    const heading = content?.[`${side}_heading`];
    const subheading = content?.[`${side}_subheading`];
    const textContent = content?.[`${side}_content`];
    const alignment = content?.[`${side}_text_alignment`] || 'left';

    // Check if any text content actually exists
    const hasHeading = hasContent(heading);
    const hasSubheading = hasContent(subheading);
    const hasTextContent = hasContent(textContent);
    const hasAnyContent = hasHeading || hasSubheading || hasTextContent;

    // Don't render the container if there's no content
    if (!hasAnyContent) {
      return null;
    }

    const alignmentClass = {
      left: 'text-left',
      center: 'text-center',
      right: 'text-right'
    }[alignment] || 'text-left';

    return (
      <div className={`space-y-4 ${alignmentClass}`}>
        {hasHeading && (
          <div 
            style={getTextStyle(`${side}_heading`)} 
            className="m-0 fifty-fifty-heading"
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(heading) }}
          />
        )}
        {hasSubheading && (
          <div 
            style={getTextStyle(`${side}_subheading`)} 
            className="m-0 prose max-w-none"
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(subheading) }}
          />
        )}
        {hasTextContent && (
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
      id={anchor || undefined}
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
        {/* Section Header - only render if there's actual content */}
        {hasHeaderContent && (
          <div className="mb-8 space-y-2">
            {hasHeaderTitle && (
              <div 
                style={{
                  ...getHeaderTitleStyle(),
                  textAlign: content?.header_title_text_align || 'center'
                }} 
                className="section-header-title"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(header_title) }}
              />
            )}
            {hasHeaderSubtitle && (
              <div 
                style={{
                  ...getSubtitleStyle(),
                  textAlign: content?.header_subtitle_text_align || 'center'
                }} 
                className="section-header-subtitle"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(header_subtitle) }}
              />
            )}
            {hasHeaderContentText && (
              <div 
                style={{
                  ...getContentStyle(),
                  textAlign: content?.header_content_text_align || 'center'
                }} 
                className="max-w-3xl mx-auto section-header-content"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(header_content) }}
              />
            )}
          </div>
        )}

        <div 
          className="grid grid-cols-1 md:grid-cols-2 items-stretch"
          style={{ gap: `${column_gap}px` }}
        >
          <div 
            className={`${reverse_on_mobile ? 'order-2 md:order-1' : ''} flex flex-col`}
            style={{
              ...(left_content_type === 'text' && left_column_bg_color ? { 
                backgroundColor: left_column_bg_color,
                paddingTop: `${left_column_padding_top + left_column_padding}px`,
                paddingBottom: `${left_column_padding_bottom + left_column_padding}px`,
                paddingLeft: `${left_column_padding}px`,
                paddingRight: `${left_column_padding}px`,
                borderRadius: `${column_border_radius}px`
              } : left_content_type === 'text' ? {
                paddingTop: `${left_column_padding_top}px`,
                paddingBottom: `${left_column_padding_bottom}px`
              } : {}),
              ...(left_content_type === 'image' ? { minHeight: 0 } : {})
            }}
          >
            {left_content_type === 'image' ? (
              <div 
                className="relative flex-1 w-full overflow-hidden"
                style={{ 
                  borderRadius: `${column_border_radius}px`,
                  minHeight: '200px'
                }}
              >
                {left_image_url ? (
                  <img 
                    src={left_image_url} 
                    alt="" 
                    className="absolute inset-0 h-full w-full"
                    style={{ 
                      objectFit: left_image_fit || 'cover'
                    }}
                  />
                ) : (
                  <div className="absolute inset-0 bg-slate-200 flex items-center justify-center">
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
                    className={`flex ${button_align === 'left' ? 'justify-start' : button_align === 'center' ? 'justify-center' : 'justify-end'}`}
                    style={{
                      marginTop: `${button_top_padding}px`,
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
                paddingTop: `${right_column_padding_top + right_column_padding}px`,
                paddingBottom: `${right_column_padding_bottom + right_column_padding}px`,
                paddingLeft: `${right_column_padding}px`,
                paddingRight: `${right_column_padding}px`,
                borderRadius: `${column_border_radius}px`
              } : right_content_type === 'text' ? {
                paddingTop: `${right_column_padding_top}px`,
                paddingBottom: `${right_column_padding_bottom}px`
              } : {}),
              ...(right_content_type === 'image' ? { minHeight: 0 } : {})
            }}
          >
            {right_content_type === 'image' ? (
              <div 
                className="relative flex-1 w-full overflow-hidden"
                style={{ 
                  borderRadius: `${column_border_radius}px`,
                  minHeight: '200px'
                }}
              >
                {right_image_url ? (
                  <img 
                    src={right_image_url} 
                    alt="" 
                    className="absolute inset-0 h-full w-full"
                    style={{ 
                      objectFit: right_image_fit || 'cover'
                    }}
                  />
                ) : (
                  <div className="absolute inset-0 bg-slate-200 flex items-center justify-center">
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
                    className={`flex ${button_align === 'left' ? 'justify-start' : button_align === 'center' ? 'justify-center' : 'justify-end'}`}
                    style={{
                      marginTop: `${button_top_padding}px`,
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
  const [viewportTab, setViewportTab] = useState('desktop');
  const [expandedSections, setExpandedSections] = useState({
    sectionHeader: true,
    background: false,
    leftColumn: false,
    rightColumn: false,
    button: false,
    layout: false,
    // Mobile sections
    mobileBackground: false,
    mobileLayout: false
  });
  const [buttonStyles, setButtonStyles] = useState([]);

  // Compute default mobile values for display in editor placeholders
  const defaultMobileVerticalPadding = Math.max(24, Math.round((content.vertical_padding || 48) * 0.6));
  const defaultMobileColumnGap = Math.max(16, Math.round((content.column_gap || 32) * 0.5));

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

  const AlignmentButtons = ({ value, onChange, label, testIdPrefix }) => (
    <div className="flex items-center gap-2">
      <Label className="text-xs">{label}</Label>
      <div className="flex border border-slate-300 rounded-md overflow-hidden">
        <button
          type="button"
          onClick={() => onChange('left')}
          className={`p-1.5 ${value === 'left' ? 'bg-slate-200' : 'bg-white hover:bg-slate-50'}`}
          data-testid={`${testIdPrefix}-left`}
        >
          <AlignLeft className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => onChange('center')}
          className={`p-1.5 border-x border-slate-300 ${value === 'center' ? 'bg-slate-200' : 'bg-white hover:bg-slate-50'}`}
          data-testid={`${testIdPrefix}-center`}
        >
          <AlignCenter className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => onChange('right')}
          className={`p-1.5 ${value === 'right' ? 'bg-slate-200' : 'bg-white hover:bg-slate-50'}`}
          data-testid={`${testIdPrefix}-right`}
        >
          <AlignRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );

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
              <div className="fifty-fifty-quill-editor border border-slate-300 rounded-md overflow-hidden bg-white">
                <ReactQuill
                  theme="snow"
                  value={content[`${side}_heading`] || ''}
                  onChange={(value) => updateContent(`${side}_heading`, value)}
                  modules={fiftyFiftyQuillModules}
                  placeholder="Enter heading..."
                  style={{ minHeight: '80px' }}
                />
              </div>
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
    const paddingTopKey = `${side}_column_padding_top`;
    const paddingBottomKey = `${side}_column_padding_bottom`;

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
            <h5 className="font-medium text-sm text-slate-700">Column Styling</h5>
            
            {/* Top and Bottom Padding */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Top Padding (px)</Label>
                <Input
                  type="number"
                  min="0"
                  value={content[paddingTopKey] || 0}
                  onChange={(e) => updateContent(paddingTopKey, parseInt(e.target.value) || 0)}
                  className="h-8"
                  data-testid={`input-${side}-column-padding-top`}
                />
              </div>
              <div>
                <Label className="text-xs">Bottom Padding (px)</Label>
                <Input
                  type="number"
                  min="0"
                  value={content[paddingBottomKey] || 0}
                  onChange={(e) => updateContent(paddingBottomKey, parseInt(e.target.value) || 0)}
                  className="h-8"
                  data-testid={`input-${side}-column-padding-bottom`}
                />
              </div>
            </div>

            {/* Background Color */}
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
                <Label className="text-xs">Inner Padding (with background): {content[paddingKey] || 24}px</Label>
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

  const backgroundType = content.background_type || 'none';
  const mobileBackgroundType = content.mobile_background_type || 'same';
  const gradientPreview = `linear-gradient(${content.gradient_angle || 135}deg, ${content.gradient_start_color || '#3b82f6'}, ${content.gradient_end_color || '#8b5cf6'})`;
  const mobileGradientPreview = `linear-gradient(${content.mobile_gradient_angle || 135}deg, ${content.mobile_gradient_start_color || '#3b82f6'}, ${content.mobile_gradient_end_color || '#8b5cf6'})`;

  return (
    <div className="space-y-4">
      {/* Anchor ID Field */}
      <div className="border rounded-lg p-3 bg-slate-50">
        <label className="block text-sm font-medium mb-1">Anchor ID</label>
        <input
          type="text"
          value={content.anchor || ''}
          onChange={(e) => {
            const sanitized = e.target.value
              .toLowerCase()
              .replace(/\s+/g, '-')
              .replace(/[^a-z0-9-_]/g, '');
            updateContent('anchor', sanitized);
          }}
          placeholder="e.g., about-section"
          className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
          data-testid="input-fiftyfifty-anchor"
        />
        <p className="text-xs text-slate-500 mt-1">
          Used for linking directly to this section (e.g., /page#anchor-id)
        </p>
      </div>

      {/* Desktop/Mobile Tab Selector */}
      <div className="flex gap-1 p-1 bg-slate-100 rounded-lg mb-4">
        <button
          type="button"
          onClick={() => setViewportTab('desktop')}
          data-testid="button-fiftyfifty-viewport-desktop"
          className={`flex-1 py-2 px-4 text-sm font-medium rounded-md transition-colors ${
            viewportTab === 'desktop' 
              ? 'bg-white shadow text-slate-900' 
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Desktop
        </button>
        <button
          type="button"
          onClick={() => setViewportTab('mobile')}
          data-testid="button-fiftyfifty-viewport-mobile"
          className={`flex-1 py-2 px-4 text-sm font-medium rounded-md transition-colors ${
            viewportTab === 'mobile' 
              ? 'bg-white shadow text-slate-900' 
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Mobile
        </button>
      </div>

      {/* Desktop Controls */}
      {viewportTab === 'desktop' && (
        <>
      {/* Section Header */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('sectionHeader')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
        >
          <span className="font-semibold text-sm">Section Header</span>
          {expandedSections.sectionHeader ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.sectionHeader && (
          <div className="p-4 space-y-4">
            {/* Header Title */}
            <div className="border-b pb-4">
              <h5 className="font-medium text-sm mb-3">Header Title</h5>
              <div className="space-y-3">
                <div>
                  <Label className="text-xs">Title Text</Label>
                  <div className="fifty-fifty-quill-editor border border-slate-300 rounded-md overflow-hidden bg-white">
                    <ReactQuill
                      theme="snow"
                      value={content.header_title || ''}
                      onChange={(value) => updateContent('header_title', value)}
                      modules={fiftyFiftyQuillModules}
                      placeholder="Enter header title..."
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
                  label="Header Title Typography Style"
                />
                <AlignmentButtons 
                  value={content.header_title_text_align || 'center'} 
                  onChange={(val) => updateContent('header_title_text_align', val)}
                  label="Alignment"
                  testIdPrefix="fiftyfifty-header-title-align"
                />
                <details className="text-xs">
                  <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
                  {renderTypographyControls('header', 'Header Title Typography')}
                </details>
              </div>
            </div>

            {/* Header Subtitle */}
            <div className="border-b pb-4">
              <h5 className="font-medium text-sm mb-3">Header Subtitle</h5>
              <div className="space-y-3">
                <div>
                  <Label className="text-xs">Subtitle Text</Label>
                  <div className="fifty-fifty-quill-editor border border-slate-300 rounded-md overflow-hidden bg-white">
                    <ReactQuill
                      theme="snow"
                      value={content.header_subtitle || ''}
                      onChange={(value) => updateContent('header_subtitle', value)}
                      modules={fiftyFiftyQuillModules}
                      placeholder="Enter header subtitle..."
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
                  label="Header Subtitle Typography Style"
                />
                <AlignmentButtons 
                  value={content.header_subtitle_text_align || 'center'} 
                  onChange={(val) => updateContent('header_subtitle_text_align', val)}
                  label="Alignment"
                  testIdPrefix="fiftyfifty-header-subtitle-align"
                />
                <details className="text-xs">
                  <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
                  {renderTypographyControls('subtitle', 'Header Subtitle Typography')}
                </details>
              </div>
            </div>

            {/* Header Content */}
            <div>
              <h5 className="font-medium text-sm mb-3">Header Content</h5>
              <div className="space-y-3">
                <div>
                  <Label className="text-xs">Content Text</Label>
                  <div className="fifty-fifty-quill-editor border border-slate-300 rounded-md overflow-hidden bg-white">
                    <ReactQuill
                      theme="snow"
                      value={content.header_content || ''}
                      onChange={(value) => updateContent('header_content', value)}
                      modules={fiftyFiftyQuillModules}
                      placeholder="Enter header content..."
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
                  label="Header Content Typography Style"
                />
                <AlignmentButtons 
                  value={content.header_content_text_align || 'center'} 
                  onChange={(val) => updateContent('header_content_text_align', val)}
                  label="Alignment"
                  testIdPrefix="fiftyfifty-header-content-align"
                />
                <details className="text-xs">
                  <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
                  {renderTypographyControls('content', 'Header Content Typography')}
                </details>
              </div>
            </div>
          </div>
        )}
      </div>

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
            </div>

            <div>
              <Label className="text-sm">Horizontal Alignment</Label>
              <div className="flex gap-1 mt-1">
                {[
                  { val: 'left', Icon: AlignLeft },
                  { val: 'center', Icon: AlignCenter },
                  { val: 'right', Icon: AlignRight }
                ].map(({ val, Icon }) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => updateContent('button_align', val)}
                    className={`p-2 rounded border ${
                      (content.button_align || 'right') === val 
                        ? 'bg-blue-600 text-white border-blue-600' 
                        : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                    }`}
                    data-testid={`button-align-${val}`}
                  >
                    <Icon className="w-4 h-4" />
                  </button>
                ))}
              </div>
            </div>

            <div>
              <Label className="text-xs">Top Padding: {content.button_top_padding || 0}px</Label>
              <input
                type="range"
                min="0"
                max="64"
                value={content.button_top_padding || 0}
                onChange={(e) => updateContent('button_top_padding', parseInt(e.target.value))}
                className="w-full"
                data-testid="slider-button-top-padding"
              />
              <p className="text-xs text-slate-500 mt-1">Gap between button and content above</p>
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
        </>
      )}

      {/* Mobile Controls */}
      {viewportTab === 'mobile' && (
        <>
          {/* Mobile Background Section */}
          <div className="border rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => toggleSection('mobileBackground')}
              className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
              data-testid="accordion-fiftyfifty-mobile-background"
            >
              <span className="font-semibold text-sm">Mobile Background</span>
              {expandedSections.mobileBackground ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
            
            {expandedSections.mobileBackground && (
              <div className="p-4 space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Background Type</label>
                  <select
                    value={mobileBackgroundType}
                    onChange={(e) => updateContent('mobile_background_type', e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md"
                    data-testid="select-fiftyfifty-mobile-background-type"
                  >
                    <option value="same">Same as Desktop</option>
                    <option value="none">None</option>
                    <option value="color">Solid Color</option>
                    <option value="gradient">Gradient</option>
                    <option value="image">Image</option>
                  </select>
                </div>

                {mobileBackgroundType !== 'same' && mobileBackgroundType === 'color' && (
                  <div>
                    <label className="block text-sm font-medium mb-1">Background Color</label>
                    <div className="flex gap-2 items-center">
                      <input
                        type="color"
                        value={content.mobile_background_color || '#ffffff'}
                        onChange={(e) => updateContent('mobile_background_color', e.target.value)}
                        className="w-16 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                      />
                      <input
                        type="text"
                        value={content.mobile_background_color || '#ffffff'}
                        onChange={(e) => updateContent('mobile_background_color', e.target.value)}
                        className="flex-1 px-3 py-2 border border-slate-300 rounded-md font-mono text-sm"
                        placeholder="#ffffff"
                      />
                    </div>
                  </div>
                )}

                {mobileBackgroundType !== 'same' && mobileBackgroundType === 'gradient' && (
                  <div className="space-y-3 p-3 bg-slate-50 rounded-md">
                    <div 
                      className="w-full h-16 rounded-md border border-slate-300"
                      style={{ background: mobileGradientPreview }}
                    />
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-sm font-medium mb-1">Start Color</label>
                        <div className="flex gap-2 items-center">
                          <input
                            type="color"
                            value={content.mobile_gradient_start_color || '#3b82f6'}
                            onChange={(e) => updateContent('mobile_gradient_start_color', e.target.value)}
                            className="w-12 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                          />
                          <input
                            type="text"
                            value={content.mobile_gradient_start_color || '#3b82f6'}
                            onChange={(e) => updateContent('mobile_gradient_start_color', e.target.value)}
                            className="flex-1 px-2 py-2 border border-slate-300 rounded-md font-mono text-xs"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-sm font-medium mb-1">End Color</label>
                        <div className="flex gap-2 items-center">
                          <input
                            type="color"
                            value={content.mobile_gradient_end_color || '#8b5cf6'}
                            onChange={(e) => updateContent('mobile_gradient_end_color', e.target.value)}
                            className="w-12 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                          />
                          <input
                            type="text"
                            value={content.mobile_gradient_end_color || '#8b5cf6'}
                            onChange={(e) => updateContent('mobile_gradient_end_color', e.target.value)}
                            className="flex-1 px-2 py-2 border border-slate-300 rounded-md font-mono text-xs"
                          />
                        </div>
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Angle: {content.mobile_gradient_angle || 135}°</label>
                      <input
                        type="range"
                        min="0"
                        max="360"
                        value={content.mobile_gradient_angle || 135}
                        onChange={(e) => updateContent('mobile_gradient_angle', parseInt(e.target.value))}
                        className="w-full"
                      />
                    </div>
                  </div>
                )}

                {mobileBackgroundType !== 'same' && mobileBackgroundType === 'image' && (
                  <div className="space-y-3">
                    <div>
                      <label className="inline-block">
                        <div className={`px-4 py-2 rounded-md text-sm font-medium cursor-pointer inline-flex items-center gap-2 ${
                          isUploading.mobile_background_image_url 
                            ? 'bg-slate-300 cursor-not-allowed' 
                            : 'bg-blue-600 hover:bg-blue-700 text-white'
                        }`}>
                          <Upload className="w-4 h-4" />
                          {isUploading.mobile_background_image_url ? 'Uploading...' : 'Upload Mobile Background'}
                        </div>
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          disabled={isUploading.mobile_background_image_url}
                          onChange={(e) => handleImageUpload(e.target.files?.[0], 'mobile_background_image_url')}
                        />
                      </label>
                    </div>
                    {content.mobile_background_image_url && (
                      <>
                        <div className="relative aspect-video w-full overflow-hidden rounded-md border border-slate-300">
                          <img 
                            src={content.mobile_background_image_url} 
                            alt="Mobile background preview" 
                            className="absolute inset-0 w-full h-full object-cover"
                          />
                          <button
                            type="button"
                            onClick={() => updateContent('mobile_background_image_url', '')}
                            className="absolute top-2 right-2 p-1 bg-red-500 text-white rounded-full hover:bg-red-600"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                        <div>
                          <label className="block text-sm font-medium mb-1">Image Fit</label>
                          <select
                            value={content.mobile_background_image_fit || 'cover'}
                            onChange={(e) => updateContent('mobile_background_image_fit', e.target.value)}
                            className="w-full px-3 py-2 border border-slate-300 rounded-md"
                          >
                            <option value="cover">Cover</option>
                            <option value="contain">Contain</option>
                            <option value="fill">Fill</option>
                          </select>
                        </div>
                      </>
                    )}

                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="mobile-overlay-enabled"
                        checked={content.mobile_overlay_enabled || false}
                        onChange={(e) => updateContent('mobile_overlay_enabled', e.target.checked)}
                        className="w-4 h-4"
                      />
                      <label htmlFor="mobile-overlay-enabled" className="cursor-pointer text-sm">Enable Overlay</label>
                    </div>

                    {content.mobile_overlay_enabled && (
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-sm font-medium mb-1">Overlay Color</label>
                          <input
                            type="color"
                            value={content.mobile_overlay_color || '#000000'}
                            onChange={(e) => updateContent('mobile_overlay_color', e.target.value)}
                            className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium mb-1">Overlay Opacity: {content.mobile_overlay_opacity || 50}%</label>
                          <input
                            type="range"
                            min="0"
                            max="100"
                            value={content.mobile_overlay_opacity || 50}
                            onChange={(e) => updateContent('mobile_overlay_opacity', parseInt(e.target.value))}
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

          {/* Mobile Layout Section */}
          <div className="border rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => toggleSection('mobileLayout')}
              className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
              data-testid="accordion-fiftyfifty-mobile-layout"
            >
              <span className="font-semibold text-sm">Mobile Layout & Spacing</span>
              {expandedSections.mobileLayout ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
            
            {expandedSections.mobileLayout && (
              <div className="p-4 space-y-4">
                <div className="flex items-center gap-2 mb-4">
                  <input
                    type="checkbox"
                    id="mobile-custom-layout"
                    checked={content.mobile_custom_layout || false}
                    onChange={(e) => updateContent('mobile_custom_layout', e.target.checked)}
                    className="w-4 h-4"
                  />
                  <Label htmlFor="mobile-custom-layout" className="cursor-pointer">
                    Use Custom Mobile Layout
                  </Label>
                </div>

                {content.mobile_custom_layout && (
                  <>
                    <div>
                      <Label className="text-sm">Mobile Vertical Padding (px)</Label>
                      <Input
                        type="number"
                        value={content.mobile_vertical_padding !== undefined ? content.mobile_vertical_padding : ''}
                        onChange={(e) => updateContent('mobile_vertical_padding', e.target.value ? parseInt(e.target.value) : undefined)}
                        min="0"
                        max="200"
                        placeholder={`Auto (${defaultMobileVerticalPadding}px)`}
                        data-testid="input-fiftyfifty-mobile-vertical-padding"
                      />
                    </div>

                    <div>
                      <Label className="text-sm">Mobile Column Gap (px)</Label>
                      <Input
                        type="number"
                        value={content.mobile_column_gap !== undefined ? content.mobile_column_gap : ''}
                        onChange={(e) => updateContent('mobile_column_gap', e.target.value ? parseInt(e.target.value) : undefined)}
                        min="0"
                        max="50"
                        placeholder={`Auto (${defaultMobileColumnGap}px)`}
                        data-testid="input-fiftyfifty-mobile-column-gap"
                      />
                    </div>
                  </>
                )}

                {!content.mobile_custom_layout && (
                  <p className="text-sm text-slate-500">
                    Mobile layout automatically adapts from desktop settings. Enable custom layout to override.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Info Panel */}
          <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <p className="text-sm text-blue-800">
              <strong>Mobile Typography:</strong> Font sizes automatically scale from the typography styles selected in Desktop tab. 
              To customize mobile font sizes, update the typography style in the Typography page.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
