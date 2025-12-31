import { useState, useId } from "react";
import TypographyStyleSelector, { applyTypographyStyle, useTypographyStyles } from "../TypographyStyleSelector";
import ReactQuill from "react-quill";
import "react-quill/dist/quill.snow.css";
import DOMPurify from "dompurify";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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

const safeHexColor = (color, fallback = '#ffffff') => {
  if (!color || typeof color !== 'string') return fallback;
  const trimmed = color.trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(trimmed)) return trimmed;
  if (/^#[0-9A-Fa-f]{3}$/.test(trimmed)) {
    return '#' + trimmed[1] + trimmed[1] + trimmed[2] + trimmed[2] + trimmed[3] + trimmed[3];
  }
  return fallback;
};

// Quill editor modules configuration for hero text content
const heroQuillModules = {
  toolbar: {
    container: [
      [{ 'header': [1, 2, 3, false] }],
      ['bold', 'italic', 'underline', 'strike'],
      [{ 'list': 'ordered'}, { 'list': 'bullet' }],
      [{ 'indent': '-1'}, { 'indent': '+1' }],
      ['blockquote'],
      ['link'],
      ['clean']
    ]
  }
};

export default function IEditPageHeaderHeroElement({ content = {}, variant, settings, isFirst, previewViewport }) {
  // DEBUG: Log component mount and props IMMEDIATELY
  try {
    console.log('[PageHeaderHero] RENDER START - content:', JSON.stringify({
      hasContent: !!content,
      contentType: typeof content,
      contentKeys: content ? Object.keys(content).slice(0, 10) : [],
      header_text_preview: content?.header_text?.substring(0, 30),
      background_type: content?.background_type,
      previewViewport
    }));
  } catch (e) {
    console.error('[PageHeaderHero] Error in initial log:', e);
  }

  const isMobilePreview = previewViewport === 'mobile';
  const { 
    anchor,
    background_type = 'color',
    background_color = '#1e3a5f',
    gradient_start_color = '#1e3a5f',
    gradient_end_color = '#3b82f6',
    gradient_angle = 135,
    image_url,
    header_text,
    subheading_text = '',
    content_text = '',
    header_position = 'left',
    header_font_family = 'Poppins',
    header_font_size = '48',
    header_color = '#ffffff',
    subheading_color = '#ffffff',
    subheading_font_size = '24',
    content_color = '#ffffff',
    content_font_size = '16',
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
    mobile_subheading_font_size,
    mobile_content_font_size,
    mobile_height_type = 'auto',
    mobile_custom_height = '250',
    mobile_padding_vertical,
    mobile_padding_horizontal,
    mobile_text_alignment,
    // Mobile background settings (matching Hero element)
    mobile_background_type = 'same',
    mobile_background_color = '#1e3a5f',
    mobile_gradient_start_color = '#1e3a5f',
    mobile_gradient_end_color = '#3b82f6',
    mobile_gradient_angle = 135,
    mobile_image_url,
    mobile_image_fit = 'cover',
    mobile_overlay_enabled = false,
    mobile_overlay_color = '#000000',
    mobile_overlay_opacity = '50',
    // Mobile typography settings
    mobile_custom_typography,
    mobile_text_color,
    mobile_heading_line_height,
    mobile_heading_letter_spacing,
    mobile_subheading_line_height,
    mobile_content_line_height
  } = content;

  // Generate unique ID for this instance to scope CSS
  // Use 'phhero-' prefix (distinct from 'hero-' in IEditHeroElement) to prevent CSS collisions
  const reactId = useId();
  const instanceId = `phhero-${reactId.replace(/:/g, '')}`;

  // Look up typography styles at render time to use current values from InstalledFonts
  const { getStyleById } = useTypographyStyles();
  console.log('[PageHeaderHero] Typography hook called, getStyleById type:', typeof getStyleById);
  
  const headerTypographyStyle = getStyleById ? getStyleById(content.header_typography_style_id) : null;
  const subheadingTypographyStyle = getStyleById ? getStyleById(content.subheading_typography_style_id) : null;
  const contentTypographyStyle = getStyleById ? getStyleById(content.content_typography_style_id) : null;

  // Desktop typography: Priority - 1) Live typography style, 2) Saved value
  const effectiveHeaderFontFamily = headerTypographyStyle?.font_family || header_font_family;
  const effectiveHeaderFontSize = headerTypographyStyle?.font_size || parseInt(header_font_size);
  const effectiveHeaderFontWeight = headerTypographyStyle?.font_weight || content?.header_font_weight;
  const effectiveHeaderLetterSpacing = headerTypographyStyle?.letter_spacing ?? (content?.header_letter_spacing || 0);
  const effectiveHeaderLineHeight = headerTypographyStyle?.line_height || content?.header_line_height || line_spacing;

  const effectiveSubheadingFontFamily = subheadingTypographyStyle?.font_family || content?.subheading_font_family || 'Poppins';
  const effectiveSubheadingFontSize = subheadingTypographyStyle?.font_size || parseInt(subheading_font_size);
  const effectiveSubheadingFontWeight = subheadingTypographyStyle?.font_weight || content?.subheading_font_weight;
  const effectiveSubheadingLetterSpacing = subheadingTypographyStyle?.letter_spacing ?? (content?.subheading_letter_spacing || 0);
  const effectiveSubheadingLineHeight = subheadingTypographyStyle?.line_height || content?.subheading_line_height || 1.5;

  const effectiveContentFontFamily = contentTypographyStyle?.font_family || content?.content_font_family || 'Poppins';
  const effectiveContentFontSize = contentTypographyStyle?.font_size || parseInt(content_font_size);
  const effectiveContentFontWeight = contentTypographyStyle?.font_weight || content?.content_font_weight;
  const effectiveContentLetterSpacing = contentTypographyStyle?.letter_spacing ?? (content?.content_letter_spacing || 0);
  const effectiveContentLineHeight = contentTypographyStyle?.line_height || content?.content_line_height || 1.6;

  // Auto-scaled default values for mobile (fallback only - used when "Use Desktop Typography" is checked)
  // Guard against NaN by ensuring we have valid numbers
  const safeHeaderFontSize = isNaN(effectiveHeaderFontSize) ? 48 : effectiveHeaderFontSize;
  const safeSubheadingFontSize = isNaN(effectiveSubheadingFontSize) ? 24 : effectiveSubheadingFontSize;
  const safeContentFontSize = isNaN(effectiveContentFontSize) ? 16 : effectiveContentFontSize;
  
  const defaultMobileHeadingSize = Math.max(24, Math.round(safeHeaderFontSize * 0.6));
  const defaultMobileSubheadingSize = Math.max(16, Math.round(safeSubheadingFontSize * 0.75));
  const defaultMobileContentSize = Math.max(14, Math.round(safeContentFontSize * 0.9));

  // Typography: Determine mobile font sizes based on "Use Desktop Typography" toggle
  // When mobile_custom_typography is FALSE (Use Desktop Typography is checked):
  //   - Use auto-scaled desktop sizes, bypassing typography style's font_size_mobile
  // When mobile_custom_typography is TRUE (custom mobile settings):
  //   - Priority: 1) Typography style's font_size_mobile, 2) Saved mobile value, 3) Auto-scaled default
  const mobileFontSize = mobile_custom_typography
    ? (headerTypographyStyle?.font_size_mobile || mobile_font_size || defaultMobileHeadingSize)
    : defaultMobileHeadingSize;
  const mobileSubheadingFontSize = mobile_custom_typography
    ? (subheadingTypographyStyle?.font_size_mobile || mobile_subheading_font_size || defaultMobileSubheadingSize)
    : defaultMobileSubheadingSize;
  const mobileContentFontSize = mobile_custom_typography
    ? (contentTypographyStyle?.font_size_mobile || mobile_content_font_size || defaultMobileContentSize)
    : defaultMobileContentSize;

  // For non-font-size properties: use custom values only if mobile_custom_typography is enabled
  const effectiveMobileTextColor = mobile_custom_typography && mobile_text_color ? mobile_text_color : header_color;
  const mobileHeadingLineHeight = mobile_custom_typography && mobile_heading_line_height ? mobile_heading_line_height : effectiveHeaderLineHeight;
  const mobileHeadingLetterSpacing = mobile_custom_typography && mobile_heading_letter_spacing !== undefined ? mobile_heading_letter_spacing : effectiveHeaderLetterSpacing;
  const mobileSubheadingLineHeight = mobile_custom_typography && mobile_subheading_line_height ? mobile_subheading_line_height : effectiveSubheadingLineHeight;
  const mobileContentLineHeight = mobile_custom_typography && mobile_content_line_height ? mobile_content_line_height : effectiveContentLineHeight;
  const mobileTextAlignment = mobile_custom_typography && mobile_text_alignment ? mobile_text_alignment : text_alignment;

  const mobilePaddingVertical = mobile_padding_vertical || Math.max(32, Math.round(parseInt(padding_vertical) * 0.5));
  const mobilePaddingHorizontal = mobile_padding_horizontal || Math.max(16, parseInt(padding_horizontal));

  // Compute effective mobile background values (use desktop values if 'same')
  const effectiveMobileBgType = mobile_background_type === 'same' ? background_type : mobile_background_type;
  const effectiveMobileBgColor = mobile_background_type === 'same' ? background_color : mobile_background_color;
  const effectiveMobileGradientStart = mobile_background_type === 'same' ? gradient_start_color : mobile_gradient_start_color;
  const effectiveMobileGradientEnd = mobile_background_type === 'same' ? gradient_end_color : mobile_gradient_end_color;
  const effectiveMobileGradientAngle = mobile_background_type === 'same' ? gradient_angle : mobile_gradient_angle;
  const effectiveMobileImageUrl = mobile_background_type === 'same' ? image_url : mobile_image_url;
  const effectiveMobileImageFit = mobile_background_type === 'same' ? (image_fit || 'cover') : (mobile_image_fit || 'cover');
  const effectiveMobileOverlayEnabled = mobile_background_type === 'same' ? overlay_enabled : mobile_overlay_enabled;
  const effectiveMobileOverlayColor = mobile_background_type === 'same' ? overlay_color : mobile_overlay_color;
  const effectiveMobileOverlayOpacity = mobile_background_type === 'same' ? overlay_opacity : mobile_overlay_opacity;

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

  const desktopHeight = getDesktopHeight();
  const mobileHeight = getMobileHeight();
  const mobilePreviewClass = isMobilePreview ? 'mobile-preview' : '';

  // DEBUG: Final render values
  console.log('[PageHeaderHero] About to render:', {
    instanceId,
    background_type,
    background_color,
    effectiveMobileBgType,
    header_text: header_text?.substring(0, 30),
    desktopHeight,
    mobileHeight,
    isMobilePreview
  });

  // DEBUG: If no header text and no background, show debug element
  if (!header_text && !subheading_text && !content_text && background_type === 'color' && !image_url) {
    console.log('[PageHeaderHero] Rendering with minimal content - showing debug placeholder');
  }

  return (
    <>
      {/* DEBUG: Visible marker to confirm component renders - hidden but kept for debugging */}
      {false && <div style={{ 
        background: 'red', 
        color: 'white', 
        padding: '10px', 
        fontSize: '12px',
        position: 'relative',
        zIndex: 9999
      }}>
        DEBUG: PageHeaderHero rendered - bg_type: {background_type}, instanceId: {instanceId}
      </div>}
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
            font-family: ${effectiveHeaderFontFamily};
            font-size: ${effectiveHeaderFontSize}px;
            color: ${header_color};
            line-height: ${effectiveHeaderLineHeight};
            ${effectiveHeaderFontWeight ? `font-weight: ${effectiveHeaderFontWeight};` : ''}
            letter-spacing: ${effectiveHeaderLetterSpacing}px;
          }
          
          .${instanceId} .hero-subheading {
            font-family: ${effectiveSubheadingFontFamily};
            ${effectiveSubheadingFontWeight ? `font-weight: ${effectiveSubheadingFontWeight};` : 'font-weight: 400;'}
            font-size: ${effectiveSubheadingFontSize}px;
            color: ${subheading_color};
            letter-spacing: ${effectiveSubheadingLetterSpacing}px;
            line-height: ${effectiveSubheadingLineHeight};
            margin-top: 16px;
          }
          
          .${instanceId} .hero-body-text {
            font-family: ${effectiveContentFontFamily};
            ${effectiveContentFontWeight ? `font-weight: ${effectiveContentFontWeight};` : 'font-weight: 400;'}
            font-size: ${effectiveContentFontSize}px;
            color: ${content_color};
            letter-spacing: ${effectiveContentLetterSpacing}px;
            line-height: ${effectiveContentLineHeight};
            margin-top: 16px;
          }
          
          .${instanceId} .hero-subheading p,
          .${instanceId} .hero-body-text p {
            margin: 0 0 0.5em 0;
          }
          
          .${instanceId} .hero-subheading p:last-child,
          .${instanceId} .hero-body-text p:last-child {
            margin-bottom: 0;
          }
          
          /* Desktop/Mobile background visibility */
          .${instanceId} .hero-bg-desktop {
            display: block;
          }
          .${instanceId} .hero-bg-mobile {
            display: none;
          }
          
          /* Mobile styles - below 768px */
          @media (max-width: 767px) {
            .${instanceId} {
              min-height: ${mobileHeight.minHeight || '400px'};
              ${mobileHeight.height ? `height: ${mobileHeight.height};` : ''}
            }
            
            .${instanceId} .hero-bg-desktop {
              display: none !important;
            }
            .${instanceId} .hero-bg-mobile {
              display: block !important;
              position: ${effectiveMobileImageFit === 'contain' && effectiveMobileBgType === 'image' ? 'relative' : 'absolute'} !important;
              ${effectiveMobileImageFit !== 'contain' || effectiveMobileBgType !== 'image' ? 'inset: 0 !important;' : ''}
            }
            
            .${instanceId} .hero-content {
              padding-left: ${mobilePaddingHorizontal}px;
              padding-right: ${mobilePaddingHorizontal}px;
              padding-top: ${mobilePaddingVertical}px;
              padding-bottom: ${mobilePaddingVertical}px;
              align-items: flex-start !important;
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
              line-height: ${mobileHeadingLineHeight};
              letter-spacing: ${mobileHeadingLetterSpacing}px;
              color: ${effectiveMobileTextColor};
            }
            
            .${instanceId} .hero-subheading {
              font-size: ${mobileSubheadingFontSize}px;
              line-height: ${mobileSubheadingLineHeight};
              margin-top: 12px;
            }
            
            .${instanceId} .hero-body-text {
              font-size: ${mobileContentFontSize}px;
              line-height: ${mobileContentLineHeight};
              margin-top: 12px;
            }
          }
          
          /* Mobile preview class override for editor preview mode */
          .${instanceId}.mobile-preview {
            min-height: ${mobileHeight.minHeight || '400px'};
            ${mobileHeight.height ? `height: ${mobileHeight.height};` : ''}
          }
          .${instanceId}.mobile-preview .hero-bg-desktop {
            display: none !important;
          }
          .${instanceId}.mobile-preview .hero-bg-mobile {
            display: block !important;
            position: ${effectiveMobileImageFit === 'contain' && effectiveMobileBgType === 'image' ? 'relative' : 'absolute'} !important;
            ${effectiveMobileImageFit !== 'contain' || effectiveMobileBgType !== 'image' ? 'inset: 0 !important;' : ''}
          }
          .${instanceId}.mobile-preview .hero-content {
            padding-left: ${mobilePaddingHorizontal}px;
            padding-right: ${mobilePaddingHorizontal}px;
            padding-top: ${mobilePaddingVertical}px;
            padding-bottom: ${mobilePaddingVertical}px;
            align-items: flex-start !important;
          }
          .${instanceId}.mobile-preview .hero-text-box {
            max-width: 100% !important;
            margin-left: 0 !important;
            margin-right: 0 !important;
            text-align: ${mobileTextAlignment};
          }
          .${instanceId}.mobile-preview .hero-title {
            font-size: ${mobileFontSize}px;
            line-height: ${mobileHeadingLineHeight};
            letter-spacing: ${mobileHeadingLetterSpacing}px;
            color: ${effectiveMobileTextColor};
          }
          .${instanceId}.mobile-preview .hero-subheading {
            font-size: ${mobileSubheadingFontSize}px;
            line-height: ${mobileSubheadingLineHeight};
          }
          .${instanceId}.mobile-preview .hero-body-text {
            font-size: ${mobileContentFontSize}px;
            line-height: ${mobileContentLineHeight};
          }
        `}
      </style>
      
      <div 
        id={anchor || undefined}
        className={`${instanceId} ${mobilePreviewClass} relative w-full overflow-hidden`}
      >
        {/* Desktop background - special handling for 'original' image fit which needs to be in document flow */}
        {background_type === 'image' && image_url && image_fit === 'original' ? (
          <>
            {/* Original fit image in document flow (desktop only via CSS) */}
            <div className="hero-bg-desktop relative">
              <img 
                src={image_url} 
                alt={header_text || 'Hero image'} 
                className="w-full h-auto block"
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
            </div>
            {/* Mobile background for 'original' desktop image */}
            <div className="hero-bg-mobile absolute inset-0">
              {effectiveMobileBgType === 'color' && (
                <div className="absolute inset-0" style={{ backgroundColor: effectiveMobileBgColor }} />
              )}
              {effectiveMobileBgType === 'gradient' && (
                <div 
                  className="absolute inset-0" 
                  style={{ background: `linear-gradient(${effectiveMobileGradientAngle}deg, ${effectiveMobileGradientStart}, ${effectiveMobileGradientEnd})` }} 
                />
              )}
              {effectiveMobileBgType === 'image' && effectiveMobileImageUrl && (
                <>
                  <img 
                    src={effectiveMobileImageUrl} 
                    alt={header_text || 'Hero image'} 
                    className="hero-mobile-img block w-full"
                    style={{ 
                      height: effectiveMobileImageFit === 'contain' ? 'auto' : '100%',
                      objectFit: effectiveMobileImageFit === 'contain' ? 'contain' : effectiveMobileImageFit,
                      position: effectiveMobileImageFit === 'contain' ? 'relative' : 'absolute',
                      inset: effectiveMobileImageFit === 'contain' ? 'auto' : '0'
                    }}
                  />
                  {effectiveMobileOverlayEnabled && (
                    <div 
                      className="absolute inset-0" 
                      style={{ 
                        backgroundColor: effectiveMobileOverlayColor, 
                        opacity: parseInt(effectiveMobileOverlayOpacity) / 100 
                      }} 
                    />
                  )}
                </>
              )}
            </div>
          </>
        ) : (
          <>
            {/* Non-original desktop backgrounds (absolute positioned) */}
            <div className="hero-bg-desktop absolute inset-0">
              {background_type === 'color' && (
                <div className="absolute inset-0" style={{ backgroundColor: background_color }} />
              )}
              {background_type === 'gradient' && (
                <div 
                  className="absolute inset-0" 
                  style={{ background: `linear-gradient(${gradient_angle}deg, ${gradient_start_color}, ${gradient_end_color})` }} 
                />
              )}
              {background_type === 'image' && image_url && (
                <>
                  <img 
                    src={image_url} 
                    alt={header_text || 'Hero image'} 
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
            </div>
            
            {/* Mobile background (absolute positioned) */}
            <div className="hero-bg-mobile absolute inset-0">
              {effectiveMobileBgType === 'color' && (
                <div className="absolute inset-0" style={{ backgroundColor: effectiveMobileBgColor }} />
              )}
              {effectiveMobileBgType === 'gradient' && (
                <div 
                  className="absolute inset-0" 
                  style={{ background: `linear-gradient(${effectiveMobileGradientAngle}deg, ${effectiveMobileGradientStart}, ${effectiveMobileGradientEnd})` }} 
                />
              )}
              {effectiveMobileBgType === 'image' && effectiveMobileImageUrl && (
                <>
                  <img 
                    src={effectiveMobileImageUrl} 
                    alt={header_text || 'Hero image'} 
                    className="hero-mobile-img block w-full"
                    style={{ 
                      height: effectiveMobileImageFit === 'contain' ? 'auto' : '100%',
                      objectFit: effectiveMobileImageFit === 'contain' ? 'contain' : effectiveMobileImageFit,
                      position: effectiveMobileImageFit === 'contain' ? 'relative' : 'absolute',
                      inset: effectiveMobileImageFit === 'contain' ? 'auto' : '0'
                    }}
                  />
                  {effectiveMobileOverlayEnabled && (
                    <div 
                      className="absolute inset-0" 
                      style={{ 
                        backgroundColor: effectiveMobileOverlayColor, 
                        opacity: parseInt(effectiveMobileOverlayOpacity) / 100 
                      }} 
                    />
                  )}
                </>
              )}
            </div>
          </>
        )}
        
        {/* DEBUG: Show background status - hidden but kept for debugging */}
        {false && <div style={{ background: 'blue', color: 'white', padding: '5px', fontSize: '10px', position: 'relative', zIndex: 9999, wordBreak: 'break-all' }}>
          Desktop: type={background_type}, fit={image_fit} | Mobile: type={effectiveMobileBgType} | 
          Padding: desktop H={padding_horizontal} V={padding_vertical}, mobile H={mobilePaddingHorizontal} V={mobilePaddingVertical} (raw: {mobile_padding_horizontal}/{mobile_padding_vertical})
        </div>}
        
        <div 
          className={`hero-content ${background_type === 'image' && image_fit === 'original' ? 'absolute inset-0 flex items-center' : 'relative h-full flex items-center'} max-w-7xl mx-auto z-10`}
        >
          <div 
            className={`hero-text-box max-w-2xl ${header_position === 'right' ? 'ml-auto' : 'mr-auto'} ${textAlignClass}`}
          >
            {header_text && (
              <div 
                className="hero-title"
                dangerouslySetInnerHTML={{ 
                  __html: DOMPurify.sanitize(header_text) 
                }}
              />
            )}
            {subheading_text && (
              <div 
                className="hero-subheading"
                dangerouslySetInnerHTML={{ 
                  __html: DOMPurify.sanitize(subheading_text) 
                }}
              />
            )}
            {content_text && (
              <div 
                className="hero-body-text"
                dangerouslySetInnerHTML={{ 
                  __html: DOMPurify.sanitize(content_text) 
                }}
              />
            )}
          </div>
        </div>
      </div>
    </>
  );
}

export function IEditPageHeaderHeroElementEditor({ element, onChange }) {
  const content = element.content || {};

  const [isUploading, setIsUploading] = useState(false);
  const [isMobileUploading, setIsMobileUploading] = useState(false);
  const [viewportTab, setViewportTab] = useState('desktop');
  const [expandedSections, setExpandedSections] = useState({
    textContent: true,
    background: false,
    mobileBackground: false,
    mobileTypography: false,
    mobilePadding: false
  });

  const toggleSection = (section) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const updateContent = (key, value) => {
    onChange({ ...element, content: { ...(element.content || {}), [key]: value } });
  };

  const updateMultipleContent = (updates) => {
    onChange({ ...element, content: { ...(element.content || {}), ...updates } });
  };

  const renderTypographyControls = (prefix, label, defaultValues = {}) => {
    const defaults = {
      font_family: 'Poppins',
      font_weight: 400,
      font_size: prefix === 'subheading' ? 24 : 16,
      color: '#ffffff',
      letter_spacing: 0,
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
              min="10"
              max="120"
              className="h-8"
            />
          </div>
          <div>
            <Label className="text-xs">Mobile Size (px)</Label>
            <Input
              type="number"
              value={content[`mobile_${prefix}_font_size`] || ''}
              onChange={(e) => updateContent(`mobile_${prefix}_font_size`, e.target.value ? parseInt(e.target.value) : '')}
              min="10"
              max="120"
              placeholder="Auto"
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

  const handleMobileImageUpload = async (file) => {
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

    setIsMobileUploading(true);
    try {
      const { base44 } = await import("@/api/base44Client");
      const response = await base44.integrations.Core.UploadFile({ file });
      updateContent('mobile_image_url', response.file_url);
    } catch (error) {
      alert('Failed to upload image: ' + error.message);
    } finally {
      setIsMobileUploading(false);
    }
  };
  
  const mobileBackgroundType = content.mobile_background_type || 'same';

  // Calculate default mobile values for display (with NaN guards)
  const safeHeaderFontSizeEditor = parseInt(content.header_font_size) || 48;
  const safeSubheadingFontSizeEditor = parseInt(content.subheading_font_size) || 24;
  const safeContentFontSizeEditor = parseInt(content.content_font_size) || 16;
  const safePaddingVerticalEditor = parseInt(content.padding_vertical) || 80;
  const safePaddingHorizontalEditor = parseInt(content.padding_horizontal) || 16;
  
  const defaultMobileFontSize = Math.max(24, Math.round(safeHeaderFontSizeEditor * 0.6));
  const defaultMobileSubheadingFontSize = Math.max(16, Math.round(safeSubheadingFontSizeEditor * 0.75));
  const defaultMobileContentFontSize = Math.max(14, Math.round(safeContentFontSizeEditor * 0.9));
  const defaultMobilePaddingVertical = Math.max(32, Math.round(safePaddingVerticalEditor * 0.5));
  const defaultMobilePaddingHorizontal = Math.max(16, safePaddingHorizontalEditor);

  return (
    <div className="space-y-2">
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
          placeholder="e.g., page-header"
          className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
          data-testid="input-pageheaderhero-anchor"
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
          data-testid="button-viewport-desktop"
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
          data-testid="button-viewport-mobile"
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
      {/* Section 1: Header / Subheader / Content */}
      <div className="border border-slate-200 rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('textContent')}
          className="w-full flex items-center justify-between p-3 bg-slate-50 hover:bg-slate-100 transition-colors text-left"
          data-testid="accordion-text-content"
        >
          <span className="font-medium text-sm">Header / Subheader / Content</span>
          <svg 
            className={`w-4 h-4 transition-transform ${expandedSections.textContent ? 'rotate-180' : ''}`} 
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        
        {expandedSections.textContent && (
          <div className="p-4 space-y-4 border-t border-slate-200">
            {/* Header Text */}
            <div>
              <label className="block text-sm font-medium mb-1">Header Text</label>
              <div className="border border-slate-300 rounded-md overflow-hidden bg-white">
                <ReactQuill
                  theme="snow"
                  value={content.header_text || ''}
                  onChange={(value) => updateContent('header_text', value)}
                  modules={heroQuillModules}
                  placeholder="Enter header text..."
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
                  if (mapped.font_size_mobile) updates.mobile_font_size = mapped.font_size_mobile;
                  if (mapped.font_weight) updates.header_font_weight = mapped.font_weight;
                  if (mapped.line_height) updates.line_spacing = mapped.line_height;
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

            {/* Subheading Text */}
            <div className="pt-4 border-t border-slate-100">
              <label className="block text-sm font-medium mb-1">Subheading Text</label>
              <div className="border border-slate-300 rounded-md overflow-hidden bg-white">
                <ReactQuill
                  theme="snow"
                  value={content.subheading_text || ''}
                  onChange={(value) => updateContent('subheading_text', value)}
                  modules={heroQuillModules}
                  placeholder="Enter subheading text..."
                  style={{ minHeight: '100px' }}
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

            {/* Content Text */}
            <div className="pt-4 border-t border-slate-100">
              <label className="block text-sm font-medium mb-1">Content Text</label>
              <div className="border border-slate-300 rounded-md overflow-hidden bg-white">
                <ReactQuill
                  theme="snow"
                  value={content.content_text || ''}
                  onChange={(value) => updateContent('content_text', value)}
                  modules={heroQuillModules}
                  placeholder="Enter content text..."
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

            {/* Text Alignment */}
            <div className="pt-4 border-t border-slate-100">
              <label className="block text-sm font-medium mb-1">Text Alignment</label>
              <select
                value={content.text_alignment || 'left'}
                onChange={(e) => updateContent('text_alignment', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
                data-testid="select-text-alignment"
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </div>
          </div>
        )}
      </div>

      {/* Section 2: Background & Layout */}
      <div className="border border-slate-200 rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('background')}
          className="w-full flex items-center justify-between p-3 bg-slate-50 hover:bg-slate-100 transition-colors text-left"
          data-testid="accordion-background"
        >
          <span className="font-medium text-sm">Background & Layout</span>
          <svg 
            className={`w-4 h-4 transition-transform ${expandedSections.background ? 'rotate-180' : ''}`} 
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        
        {expandedSections.background && (
          <div className="p-4 space-y-4 border-t border-slate-200">
            {/* Background Type Selection */}
            <div>
              <label className="block text-sm font-medium mb-1">Background Type</label>
              <select
                value={content.background_type || 'color'}
                onChange={(e) => updateContent('background_type', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
                data-testid="select-background-type"
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
                  data-testid="input-background-color"
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
                  <label className="block text-sm font-medium mb-1">Hero Image</label>
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
                        data-testid="input-image-upload"
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
                        data-testid="button-remove-image"
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
                    data-testid="select-image-fit"
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
                      data-testid="checkbox-overlay"
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

            {/* Header Position */}
            <div className="pt-4 border-t border-slate-100">
              <label className="block text-sm font-medium mb-1">Header Position</label>
              <select
                value={content.header_position || 'left'}
                onChange={(e) => updateContent('header_position', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
                data-testid="select-header-position"
              >
                <option value="left">Left</option>
                <option value="right">Right</option>
              </select>
            </div>

            {/* Container Height */}
            {(content.background_type !== 'image' || content.image_fit !== 'original') && (
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium mb-1">Container Height</label>
                  <select
                    value={content.height_type || 'auto'}
                    onChange={(e) => updateContent('height_type', e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md"
                    data-testid="select-height-type"
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

            {/* Container Padding */}
            <div className="space-y-3 pt-4 border-t border-slate-100">
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
            <div className="space-y-3 pt-4 border-t border-slate-100">
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
          </div>
        )}
      </div>
        </>
      )}

      {/* Mobile Controls */}
      {viewportTab === 'mobile' && (
        <>
          {/* Mobile Background Section */}
          <div className="border border-slate-200 rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => toggleSection('mobileBackground')}
              className="w-full flex items-center justify-between p-3 bg-slate-50 hover:bg-slate-100 transition-colors text-left"
              data-testid="accordion-mobile-background"
            >
              <span className="font-medium text-sm">Mobile Background</span>
              <svg 
                className={`w-4 h-4 transition-transform ${expandedSections.mobileBackground ? 'rotate-180' : ''}`} 
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            
            {expandedSections.mobileBackground && (
              <div className="p-4 space-y-4 border-t border-slate-200">
                <p className="text-xs text-slate-600 mb-3">
                  Configure mobile-specific background. Select "Same as Desktop" to inherit desktop settings.
                </p>

                <div>
                  <label className="block text-sm font-medium mb-1">Background Type</label>
                  <select
                    value={mobileBackgroundType}
                    onChange={(e) => updateContent('mobile_background_type', e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md"
                    data-testid="select-mobile-background-type"
                  >
                    <option value="same">Same as Desktop</option>
                    <option value="color">Solid Color</option>
                    <option value="gradient">Gradient</option>
                    <option value="image">Image</option>
                  </select>
                </div>

              {/* Mobile Color Background */}
              {mobileBackgroundType === 'color' && (
                <div>
                  <label className="block text-sm font-medium mb-1">Mobile Background Color</label>
                  <input
                    type="color"
                    value={content.mobile_background_color || '#1e3a5f'}
                    onChange={(e) => updateContent('mobile_background_color', e.target.value)}
                    className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                  />
                </div>
              )}

              {/* Mobile Gradient Background */}
              {mobileBackgroundType === 'gradient' && (
                <div className="space-y-3">
                  <div 
                    className="w-full h-12 rounded-md border border-slate-300"
                    style={{ 
                      background: `linear-gradient(${content.mobile_gradient_angle || 135}deg, ${content.mobile_gradient_start_color || '#1e3a5f'}, ${content.mobile_gradient_end_color || '#3b82f6'})` 
                    }}
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium mb-1">Start Color</label>
                      <input
                        type="color"
                        value={content.mobile_gradient_start_color || '#1e3a5f'}
                        onChange={(e) => updateContent('mobile_gradient_start_color', e.target.value)}
                        className="w-full h-8 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">End Color</label>
                      <input
                        type="color"
                        value={content.mobile_gradient_end_color || '#3b82f6'}
                        onChange={(e) => updateContent('mobile_gradient_end_color', e.target.value)}
                        className="w-full h-8 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">Angle: {content.mobile_gradient_angle || 135}°</label>
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

              {/* Mobile Image Background */}
              {mobileBackgroundType === 'image' && (
                <div className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium mb-1">Mobile Hero Image</label>
                    <label className="inline-block">
                      <div className={`px-4 py-2 rounded-md text-sm font-medium cursor-pointer ${
                        isMobileUploading 
                          ? 'bg-slate-300 cursor-not-allowed' 
                          : 'bg-blue-600 hover:bg-blue-700 text-white'
                      }`}>
                        {isMobileUploading ? 'Uploading...' : 'Upload Mobile Image'}
                      </div>
                      <input
                        type="file"
                        accept="image/*"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) handleMobileImageUpload(file);
                          e.target.value = '';
                        }}
                        className="hidden"
                        disabled={isMobileUploading}
                        data-testid="input-mobile-image-upload"
                      />
                    </label>
                  </div>
                  {content.mobile_image_url && (
                    <div className="relative">
                      <img
                        src={content.mobile_image_url}
                        alt="Mobile Preview"
                        className="w-full h-24 object-cover rounded"
                        onError={(e) => { e.target.style.display = 'none'; }}
                      />
                      <button
                        onClick={() => updateContent('mobile_image_url', '')}
                        className="absolute bottom-2 right-2 px-2 py-1 bg-red-600 hover:bg-red-700 text-white text-xs rounded"
                        type="button"
                      >
                        Remove
                      </button>
                    </div>
                  )}
                  <div>
                    <label className="block text-sm font-medium mb-1">Mobile Image Display</label>
                    <select
                      value={content.mobile_image_fit || 'cover'}
                      onChange={(e) => updateContent('mobile_image_fit', e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md"
                    >
                      <option value="cover">Cover (Fill & Crop)</option>
                      <option value="contain">Contain (Fit Within)</option>
                    </select>
                  </div>

                  {/* Mobile Overlay */}
                  <div className="space-y-2 p-2 bg-white rounded border border-slate-200">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="mobile_overlay_enabled"
                        checked={content.mobile_overlay_enabled || false}
                        onChange={(e) => updateContent('mobile_overlay_enabled', e.target.checked)}
                        className="rounded"
                      />
                      <label htmlFor="mobile_overlay_enabled" className="text-sm font-medium">Enable Mobile Overlay</label>
                    </div>
                    {content.mobile_overlay_enabled && (
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-xs font-medium mb-1">Overlay Color</label>
                          <input
                            type="color"
                            value={content.mobile_overlay_color || '#000000'}
                            onChange={(e) => updateContent('mobile_overlay_color', e.target.value)}
                            className="w-full h-8 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium mb-1">Opacity (%)</label>
                          <input
                            type="number"
                            value={content.mobile_overlay_opacity || 50}
                            onChange={(e) => updateContent('mobile_overlay_opacity', e.target.value)}
                            className="w-full px-2 py-1 border border-slate-300 rounded-md text-sm"
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

          {/* Mobile Typography Section */}
          <div className="border border-slate-200 rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => toggleSection('mobileTypography')}
              className="w-full flex items-center justify-between p-3 bg-slate-50 hover:bg-slate-100 transition-colors text-left"
              data-testid="accordion-mobile-typography"
            >
              <span className="font-medium text-sm">Mobile Typography</span>
              <svg 
                className={`w-4 h-4 transition-transform ${expandedSections.mobileTypography ? 'rotate-180' : ''}`} 
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            
            {expandedSections.mobileTypography && (
              <div className="p-4 space-y-4 border-t border-slate-200">
                <div className="flex items-center gap-2 mb-3">
                  <input
                    type="checkbox"
                    id="mobile_use_desktop_typography"
                    checked={!content.mobile_custom_typography}
                    onChange={(e) => updateContent('mobile_custom_typography', !e.target.checked)}
                    className="rounded"
                  />
                  <label htmlFor="mobile_use_desktop_typography" className="text-sm font-medium">
                    Use Desktop Typography
                  </label>
                </div>

                {content.mobile_custom_typography && (
                  <div className="space-y-4 pl-2 border-l-2 border-blue-200">
                    {/* Mobile Text Color */}
                    <div>
                      <label className="block text-sm font-medium mb-1">Mobile Text Color</label>
                      <div className="flex gap-2 items-center">
                        <input
                          type="color"
                          value={content.mobile_text_color || content.header_color || '#ffffff'}
                          onChange={(e) => updateContent('mobile_text_color', e.target.value)}
                          className="w-16 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                        />
                        <input
                          type="text"
                          value={content.mobile_text_color || content.header_color || '#ffffff'}
                          onChange={(e) => updateContent('mobile_text_color', e.target.value)}
                          className="flex-1 px-3 py-2 border border-slate-300 rounded-md font-mono text-sm"
                          placeholder={content.header_color || '#ffffff'}
                        />
                        <button
                          type="button"
                          onClick={() => updateContent('mobile_text_color', '')}
                          className="text-xs text-slate-500 hover:text-slate-700 underline"
                        >
                          Reset
                        </button>
                      </div>
                      <p className="text-xs text-slate-500 mt-1">This is the main text color for mobile. Set this to ensure text is visible on mobile backgrounds.</p>
                    </div>

                    {/* Heading Settings */}
                    <div className="space-y-3 p-3 bg-slate-50 rounded-lg">
                      <h5 className="text-sm font-semibold">Heading</h5>
                      <div className="grid grid-cols-3 gap-3">
                        <div>
                          <label className="block text-sm font-medium mb-1">
                            Font Size
                            <span className="text-xs text-slate-500 block">Default: {defaultMobileFontSize}px</span>
                          </label>
                          <input
                            type="number"
                            value={content.mobile_font_size || ''}
                            onChange={(e) => updateContent('mobile_font_size', e.target.value ? parseInt(e.target.value) : '')}
                            placeholder={defaultMobileFontSize}
                            className="w-full px-3 py-2 border border-slate-300 rounded-md"
                            min="16"
                            max="96"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium mb-1">
                            Line Height
                            <span className="text-xs text-slate-500 block">Default: {content.line_spacing || 1.2}</span>
                          </label>
                          <input
                            type="number"
                            step="0.1"
                            value={content.mobile_heading_line_height || ''}
                            onChange={(e) => updateContent('mobile_heading_line_height', e.target.value ? parseFloat(e.target.value) : '')}
                            placeholder={content.line_spacing || 1.2}
                            className="w-full px-3 py-2 border border-slate-300 rounded-md"
                            min="0.8"
                            max="3"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium mb-1">
                            Letter Spacing
                            <span className="text-xs text-slate-500 block">Default: {content.header_letter_spacing || 0}px</span>
                          </label>
                          <input
                            type="number"
                            step="0.5"
                            value={content.mobile_heading_letter_spacing || ''}
                            onChange={(e) => updateContent('mobile_heading_letter_spacing', e.target.value ? parseFloat(e.target.value) : '')}
                            placeholder={content.header_letter_spacing || 0}
                            className="w-full px-3 py-2 border border-slate-300 rounded-md"
                            min="-5"
                            max="20"
                          />
                        </div>
                      </div>
                    </div>

                    {/* Subheading Settings */}
                    <div className="space-y-3 p-3 bg-slate-50 rounded-lg">
                      <h5 className="text-sm font-semibold">Subheading</h5>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-sm font-medium mb-1">
                            Font Size
                            <span className="text-xs text-slate-500 block">Default: {defaultMobileSubheadingFontSize}px</span>
                          </label>
                          <input
                            type="number"
                            value={content.mobile_subheading_font_size || ''}
                            onChange={(e) => updateContent('mobile_subheading_font_size', e.target.value ? parseInt(e.target.value) : '')}
                            placeholder={defaultMobileSubheadingFontSize}
                            className="w-full px-3 py-2 border border-slate-300 rounded-md"
                            min="12"
                            max="48"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium mb-1">
                            Line Height
                            <span className="text-xs text-slate-500 block">Default: {content.subheading_line_height || 1.5}</span>
                          </label>
                          <input
                            type="number"
                            step="0.1"
                            value={content.mobile_subheading_line_height || ''}
                            onChange={(e) => updateContent('mobile_subheading_line_height', e.target.value ? parseFloat(e.target.value) : '')}
                            placeholder={content.subheading_line_height || 1.5}
                            className="w-full px-3 py-2 border border-slate-300 rounded-md"
                            min="0.8"
                            max="3"
                          />
                        </div>
                      </div>
                    </div>

                    {/* Content Settings */}
                    <div className="space-y-3 p-3 bg-slate-50 rounded-lg">
                      <h5 className="text-sm font-semibold">Content</h5>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-sm font-medium mb-1">
                            Font Size
                            <span className="text-xs text-slate-500 block">Default: {defaultMobileContentFontSize}px</span>
                          </label>
                          <input
                            type="number"
                            value={content.mobile_content_font_size || ''}
                            onChange={(e) => updateContent('mobile_content_font_size', e.target.value ? parseInt(e.target.value) : '')}
                            placeholder={defaultMobileContentFontSize}
                            className="w-full px-3 py-2 border border-slate-300 rounded-md"
                            min="12"
                            max="32"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium mb-1">
                            Line Height
                            <span className="text-xs text-slate-500 block">Default: {content.content_line_height || 1.6}</span>
                          </label>
                          <input
                            type="number"
                            step="0.1"
                            value={content.mobile_content_line_height || ''}
                            onChange={(e) => updateContent('mobile_content_line_height', e.target.value ? parseFloat(e.target.value) : '')}
                            placeholder={content.content_line_height || 1.6}
                            className="w-full px-3 py-2 border border-slate-300 rounded-md"
                            min="0.8"
                            max="3"
                          />
                        </div>
                      </div>
                    </div>

                    {/* Mobile Text Alignment */}
                    <div>
                      <label className="block text-sm font-medium mb-1">Mobile Text Alignment</label>
                      <select
                        value={content.mobile_text_alignment || ''}
                        onChange={(e) => updateContent('mobile_text_alignment', e.target.value)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md"
                      >
                        <option value="">Use Desktop ({content.text_alignment || 'left'})</option>
                        <option value="left">Left</option>
                        <option value="center">Center</option>
                        <option value="right">Right</option>
                      </select>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Mobile Padding Section */}
          <div className="border border-slate-200 rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => toggleSection('mobilePadding')}
              className="w-full flex items-center justify-between p-3 bg-slate-50 hover:bg-slate-100 transition-colors text-left"
              data-testid="accordion-mobile-padding"
            >
              <span className="font-medium text-sm">Mobile Padding & Layout</span>
              <svg 
                className={`w-4 h-4 transition-transform ${expandedSections.mobilePadding ? 'rotate-180' : ''}`} 
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            
            {expandedSections.mobilePadding && (
              <div className="p-4 space-y-4 border-t border-slate-200">
                {/* Mobile Height */}
                {(content.background_type !== 'image' || content.image_fit !== 'original') && (
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
                      placeholder={String(defaultMobilePaddingVertical)}
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
                      placeholder={String(defaultMobilePaddingHorizontal)}
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
        </>
      )}
    </div>
  );
}
