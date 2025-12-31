import { useState, useEffect, useCallback, useId } from "react";
import { ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Upload, X, Plus, Trash2, GripVertical, AlignLeft, AlignCenter, AlignRight } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import TypographyStyleSelector, { applyTypographyStyle } from "../TypographyStyleSelector";
import ReactQuill from "react-quill";
import "react-quill/dist/quill.snow.css";
import DOMPurify from "dompurify";

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

export default function IEditQuoteElement({ content, variant, settings }) {
  const {
    quotes = [],
    carousel_delay = 5000,
    show_navigation = true,
    show_indicators = true,
    pause_on_hover = true,
    // Quote panel background (existing)
    background_type = 'color',
    background_color = '#f8fafc',
    gradient_start_color = '#3b82f6',
    gradient_end_color = '#8b5cf6',
    gradient_angle = 135,
    background_image_url,
    background_image_fit = 'cover',
    overlay_enabled = false,
    overlay_color = '#000000',
    overlay_opacity = 50,
    // Element-level background (new - like Hero)
    element_background_type = 'none',
    element_background_color = '#ffffff',
    element_gradient_start_color = '#1e3a5f',
    element_gradient_end_color = '#3b82f6',
    element_gradient_angle = 135,
    element_background_image_url,
    element_background_image_fit = 'cover',
    element_overlay_enabled = false,
    element_overlay_color = '#000000',
    element_overlay_opacity = 50,
    element_padding_top = 40,
    element_padding_bottom = 40,
    // Quote panel styling
    box_padding = 40,
    box_border_radius = 12,
    box_border_color = '#e2e8f0',
    box_border_width = 1,
    quote_font_family = 'Georgia',
    quote_font_size = 20,
    quote_font_weight = 400,
    quote_color = '#1e293b',
    quote_font_style = 'italic',
    quote_letter_spacing = 0,
    quote_line_height = 1.6,
    quote_align = 'center',
    name_font_family = 'Poppins',
    name_font_size = 16,
    name_font_weight = 600,
    name_color = '#475569',
    name_letter_spacing = 0,
    name_align = 'center',
    quote_mark_color = '#cbd5e1',
    quote_mark_size = 48,
    quote_mark_opacity = 50,
    quote_mark_top_image_url,
    quote_mark_bottom_image_url,
    profile_size = 80,
    profile_border_radius = 50,
    profile_border_color = '#e2e8f0',
    profile_border_width = 2,
    layout = 'stacked',
    quote_text = '',
    author_name = '',
    profile_image_url,
    // Section Header fields
    header_title = '',
    header_subtitle = '',
    header_content = '',
    header_align = 'center',
    header_title_align = 'center',
    header_subtitle_align = 'center',
    header_content_align = 'center',
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
    content_letter_spacing = 0,
    // Manual container height for carousel (0 = auto)
    container_height = 0,
    // Vertical alignment for content within container
    content_vertical_align = 'middle',
    // Anchor ID for linking
    anchor,
    // Mobile-specific settings
    mobile_quote_font_size,
    mobile_name_font_size,
    mobile_quote_align,
    mobile_name_align,
    mobile_quote_mark_size,
    mobile_quote_mark_opacity,
    mobile_element_padding_top,
    mobile_element_padding_bottom,
    mobile_box_padding
  } = content || {};

  // Compute effective mobile values (priority: saved value > auto-scaled default)
  const effectiveMobileQuoteFontSize = mobile_quote_font_size || Math.max(16, Math.round(quote_font_size * 0.85));
  const effectiveMobileNameFontSize = mobile_name_font_size || Math.max(14, Math.round(name_font_size * 0.9));
  const effectiveMobileQuoteAlign = mobile_quote_align || quote_align;
  const effectiveMobileNameAlign = mobile_name_align || name_align;
  const effectiveMobileQuoteMarkSize = mobile_quote_mark_size || Math.max(32, Math.round(quote_mark_size * 0.7));
  const effectiveMobileQuoteMarkOpacity = mobile_quote_mark_opacity ?? quote_mark_opacity;
  const effectiveMobileElementPaddingTop = mobile_element_padding_top ?? element_padding_top;
  const effectiveMobileElementPaddingBottom = mobile_element_padding_bottom ?? element_padding_bottom;
  const effectiveMobileBoxPadding = mobile_box_padding ?? box_padding;

  const reactId = useId();
  const instanceId = `quote-${reactId.replace(/:/g, '')}`;
  const fullWidth = settings?.fullWidth;

  const allQuotes = quotes.length > 0 
    ? quotes 
    : (quote_text ? [{ quote_text, author_name, profile_image_url }] : []);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);

  const goToNext = useCallback(() => {
    if (allQuotes.length > 1) {
      setCurrentIndex((prev) => (prev + 1) % allQuotes.length);
    }
  }, [allQuotes.length]);

  const goToPrev = useCallback(() => {
    if (allQuotes.length > 1) {
      setCurrentIndex((prev) => (prev - 1 + allQuotes.length) % allQuotes.length);
    }
  }, [allQuotes.length]);

  useEffect(() => {
    if (allQuotes.length <= 1 || isPaused) return;

    const interval = setInterval(() => {
      goToNext();
    }, carousel_delay);

    return () => clearInterval(interval);
  }, [allQuotes.length, carousel_delay, isPaused, goToNext]);

  // Quote panel background
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

  // Element-level background (like Hero)
  const getElementBackgroundStyle = () => {
    if (element_background_type === 'color') {
      return { backgroundColor: element_background_color };
    }
    if (element_background_type === 'gradient') {
      return { 
        background: `linear-gradient(${element_gradient_angle}deg, ${element_gradient_start_color}, ${element_gradient_end_color})` 
      };
    }
    return {};
  };

  const fullWidthClass = fullWidth ? 'w-screen relative left-1/2 right-1/2 -ml-[50vw] -mr-[50vw]' : '';

  const quoteStyle = {
    fontFamily: quote_font_family,
    fontSize: `${quote_font_size}px`,
    fontWeight: quote_font_weight,
    color: quote_color,
    fontStyle: quote_font_style,
    letterSpacing: `${quote_letter_spacing}px`,
    lineHeight: quote_line_height,
    textAlign: quote_align
  };

  const nameStyle = {
    fontFamily: name_font_family,
    fontSize: `${name_font_size}px`,
    fontWeight: name_font_weight,
    color: name_color,
    letterSpacing: `${name_letter_spacing}px`,
    textAlign: name_align
  };

  const quoteMarkStyle = {
    color: quote_mark_color,
    fontSize: `${quote_mark_size}px`,
    opacity: quote_mark_opacity / 100,
    fontFamily: 'Georgia, serif',
    lineHeight: 1
  };

  const profileStyle = {
    width: `${profile_size}px`,
    height: `${profile_size}px`,
    borderRadius: `${profile_border_radius}%`,
    border: `${profile_border_width}px solid ${profile_border_color}`,
    objectFit: 'cover'
  };

  // Section Header styles (matching Hero/Accordion pattern)
  const sectionTitleStyle = {
    fontFamily: header_font_family,
    fontWeight: header_font_weight,
    fontSize: `${header_font_size}px`,
    color: header_color,
    lineHeight: header_line_height,
    letterSpacing: `${header_letter_spacing}px`,
    textAlign: header_title_align || header_align
  };

  const sectionSubtitleStyle = {
    fontFamily: subtitle_font_family,
    fontWeight: subtitle_font_weight,
    fontSize: `${subtitle_font_size}px`,
    color: subtitle_color,
    lineHeight: subtitle_line_height,
    letterSpacing: `${subtitle_letter_spacing}px`,
    textAlign: header_subtitle_align || header_align
  };

  const sectionContentStyle = {
    fontFamily: content_font_family,
    fontWeight: content_font_weight,
    fontSize: `${content_font_size}px`,
    color: content_color,
    lineHeight: content_line_height,
    letterSpacing: `${content_letter_spacing}px`,
    textAlign: header_content_align || header_align
  };

  const hasSectionHeader = header_title || header_subtitle || header_content;

  const currentQuote = allQuotes[currentIndex] || {};

  // Scoped styles for responsive design - desktop values handled by inline styles
  // Only padding classes needed for desktop (no inline style), all others via @media for mobile
  const scopedStyles = `
    .${instanceId} .quote-element-wrapper {
      padding-top: ${element_padding_top}px;
      padding-bottom: ${element_padding_bottom}px;
    }

    @media (max-width: 767px) {
      .${instanceId} .quote-text {
        font-size: ${effectiveMobileQuoteFontSize}px !important;
        text-align: ${effectiveMobileQuoteAlign} !important;
      }

      .${instanceId} .quote-name {
        font-size: ${effectiveMobileNameFontSize}px !important;
        text-align: ${effectiveMobileNameAlign} !important;
      }

      .${instanceId} .quote-mark {
        font-size: ${effectiveMobileQuoteMarkSize}px !important;
        opacity: ${effectiveMobileQuoteMarkOpacity / 100} !important;
      }

      .${instanceId} .quote-mark-img {
        width: ${effectiveMobileQuoteMarkSize}px !important;
        height: ${effectiveMobileQuoteMarkSize}px !important;
        opacity: ${effectiveMobileQuoteMarkOpacity / 100} !important;
      }

      .${instanceId} .quote-element-wrapper {
        padding-top: ${effectiveMobileElementPaddingTop}px !important;
        padding-bottom: ${effectiveMobileElementPaddingBottom}px !important;
      }

      .${instanceId} .quote-box {
        padding: ${effectiveMobileBoxPadding}px !important;
      }

      .${instanceId} .quote-header-title {
        font-size: ${header_font_size_mobile || Math.max(20, Math.round(header_font_size * 0.75))}px !important;
      }

      .${instanceId} .quote-header-subtitle {
        font-size: ${subtitle_font_size_mobile || Math.max(14, Math.round(subtitle_font_size * 0.85))}px !important;
      }

      .${instanceId} .quote-header-content {
        font-size: ${content_font_size_mobile || Math.max(12, Math.round(content_font_size * 0.9))}px !important;
      }
    }
  `;

  // Render a single quote's content (reusable for both measurement and display)
  const renderQuoteContent = (quoteData, isMeasuring = false) => {
    if (layout === 'stacked') {
      return (
        <div className="flex flex-col items-center gap-4">
          {quoteData.profile_image_url && (
            <img 
              src={quoteData.profile_image_url} 
              alt={quoteData.author_name || 'Profile'} 
              style={profileStyle}
            />
          )}
          {quoteData.quote_text && (
            <p style={quoteStyle} className={`quote-text max-w-3xl ${!isMeasuring ? 'transition-opacity duration-300' : ''}`}>
              {quoteData.quote_text}
            </p>
          )}
          {quoteData.author_name && (
            <p style={nameStyle} className="quote-name">
              — {quoteData.author_name}
            </p>
          )}
        </div>
      );
    } else {
      return (
        <div className="flex items-start gap-6">
          {quoteData.profile_image_url && (
            <img 
              src={quoteData.profile_image_url} 
              alt={quoteData.author_name || 'Profile'} 
              style={profileStyle}
              className="flex-shrink-0"
            />
          )}
          <div className="flex-1">
            {quoteData.quote_text && (
              <p style={{ ...quoteStyle, textAlign: 'left' }} className={`quote-text mb-4 ${!isMeasuring ? 'transition-opacity duration-300' : ''}`}>
                {quoteData.quote_text}
              </p>
            )}
            {quoteData.author_name && (
              <p style={{ ...nameStyle, textAlign: 'left' }} className="quote-name">
                — {quoteData.author_name}
              </p>
            )}
          </div>
        </div>
      );
    }
  };

  // Quote panel component
  const renderQuotePanel = () => (
    <div 
      className="quote-box relative w-full"
      style={{
        ...getBackgroundStyle(),
        padding: `${box_padding}px`,
        borderRadius: `${box_border_radius}px`,
        border: `${box_border_width}px solid ${box_border_color}`
      }}
      onMouseEnter={() => pause_on_hover && setIsPaused(true)}
      onMouseLeave={() => pause_on_hover && setIsPaused(false)}
    >
      {background_type === 'image' && background_image_url && (
        <>
          <img 
            src={background_image_url} 
            alt="Background" 
            className="absolute inset-0 w-full h-full"
            style={{ 
              objectFit: background_image_fit,
              borderRadius: `${box_border_radius}px`
            }}
          />
          {overlay_enabled && (
            <div 
              className="absolute inset-0" 
              style={{ 
                backgroundColor: overlay_color, 
                opacity: overlay_opacity / 100,
                borderRadius: `${box_border_radius}px`
              }} 
            />
          )}
        </>
      )}

      {quote_mark_top_image_url ? (
        <img 
          src={quote_mark_top_image_url}
          alt="Quote mark"
          className="quote-mark-img absolute select-none pointer-events-none"
          style={{ 
            top: `${box_padding / 2}px`,
            right: `${box_padding / 2}px`,
            width: `${quote_mark_size}px`,
            height: `${quote_mark_size}px`,
            objectFit: 'contain',
            opacity: quote_mark_opacity / 100
          }}
        />
      ) : (
        <div 
          className="quote-mark absolute select-none pointer-events-none"
          style={{ 
            ...quoteMarkStyle,
            top: `${box_padding / 2}px`,
            right: `${box_padding / 2}px`
          }}
        >
          "
        </div>
      )}

      {quote_mark_bottom_image_url ? (
        <img 
          src={quote_mark_bottom_image_url}
          alt="Quote mark"
          className="quote-mark-img absolute select-none pointer-events-none"
          style={{ 
            bottom: `${box_padding / 2}px`,
            left: `${box_padding / 2}px`,
            width: `${quote_mark_size}px`,
            height: `${quote_mark_size}px`,
            objectFit: 'contain',
            opacity: quote_mark_opacity / 100,
            transform: 'rotate(180deg)'
          }}
        />
      ) : (
        <div 
          className="quote-mark absolute select-none pointer-events-none"
          style={{ 
            ...quoteMarkStyle,
            bottom: `${box_padding / 2}px`,
            left: `${box_padding / 2}px`,
            transform: 'rotate(180deg)'
          }}
        >
          "
        </div>
      )}

      <div 
        className="relative z-10 flex flex-col"
        style={{
          ...(container_height > 0 ? { minHeight: `${container_height}px` } : {}),
          justifyContent: content_vertical_align === 'top' ? 'flex-start' : 
                          content_vertical_align === 'bottom' ? 'flex-end' : 'center'
        }}
      >
        {renderQuoteContent(currentQuote)}

        {allQuotes.length > 1 && (
          <>
            {show_navigation && (
              <div className="flex justify-center gap-4 mt-6">
                <button
                  onClick={goToPrev}
                  className="p-2 rounded-full bg-white/80 hover:bg-white shadow-sm transition-colors"
                  aria-label="Previous quote"
                >
                  <ChevronLeft className="w-5 h-5 text-slate-600" />
                </button>
                <button
                  onClick={goToNext}
                  className="p-2 rounded-full bg-white/80 hover:bg-white shadow-sm transition-colors"
                  aria-label="Next quote"
                >
                  <ChevronRight className="w-5 h-5 text-slate-600" />
                </button>
              </div>
            )}

            {show_indicators && (
              <div className="flex justify-center gap-2 mt-4">
                {allQuotes.map((_, index) => (
                  <button
                    key={index}
                    onClick={() => setCurrentIndex(index)}
                    className={`w-2 h-2 rounded-full transition-colors ${
                      index === currentIndex 
                        ? 'bg-slate-600' 
                        : 'bg-slate-300 hover:bg-slate-400'
                    }`}
                    aria-label={`Go to quote ${index + 1}`}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );

  // Empty state
  if (allQuotes.length === 0) {
    return (
      <div 
        id={anchor || undefined}
        className={`${instanceId} ${fullWidthClass} relative`}
      >
        <style>{scopedStyles}</style>
        <div 
          className="quote-element-wrapper relative"
          style={getElementBackgroundStyle()}
        >
          {/* Element-level background image */}
          {element_background_type === 'image' && element_background_image_url && (
            <>
              <img 
                src={element_background_image_url} 
                alt="Background" 
                className="absolute inset-0 w-full h-full"
                style={{ objectFit: element_background_image_fit }}
              />
              {element_overlay_enabled && (
                <div 
                  className="absolute inset-0" 
                  style={{ 
                    backgroundColor: element_overlay_color, 
                    opacity: element_overlay_opacity / 100 
                  }} 
                />
              )}
            </>
          )}
          <div className={fullWidth ? "max-w-7xl mx-auto px-4 relative z-10" : "relative z-10"}>
            {/* Section Header */}
            {hasSectionHeader && (
              <div className="mb-8">
                {header_title && (
                  <div 
                    className="quote-header-title"
                    style={sectionTitleStyle}
                    dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(header_title) }}
                  />
                )}
                {header_subtitle && (
                  <div 
                    className="quote-header-subtitle mt-2"
                    style={sectionSubtitleStyle}
                    dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(header_subtitle) }}
                  />
                )}
                {header_content && (
                  <div 
                    className="quote-header-content mt-4"
                    style={sectionContentStyle}
                    dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(header_content) }}
                  />
                )}
              </div>
            )}
            <div 
              className="quote-box relative w-full text-center"
              style={{
                ...getBackgroundStyle(),
                borderRadius: `${box_border_radius}px`,
                border: `${box_border_width}px solid ${box_border_color}`
              }}
            >
              <p className="text-slate-400 italic">Add quotes to display them here</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div 
      id={anchor || undefined}
      className={`${instanceId} ${fullWidthClass} relative`}
    >
      <style>{scopedStyles}</style>
      <div 
        className="quote-element-wrapper relative"
        style={getElementBackgroundStyle()}
      >
        {/* Element-level background image */}
        {element_background_type === 'image' && element_background_image_url && (
          <>
            <img 
              src={element_background_image_url} 
              alt="Background" 
              className="absolute inset-0 w-full h-full"
              style={{ objectFit: element_background_image_fit }}
            />
            {element_overlay_enabled && (
              <div 
                className="absolute inset-0" 
                style={{ 
                  backgroundColor: element_overlay_color, 
                  opacity: element_overlay_opacity / 100 
                }} 
              />
            )}
          </>
        )}

        <div className={fullWidth ? "max-w-7xl mx-auto px-4 relative z-10" : "relative z-10"}>
        {/* Section Header */}
        {hasSectionHeader && (
          <div className="mb-8">
            {header_title && (
              <div 
                className="quote-header-title"
                style={sectionTitleStyle}
                dangerouslySetInnerHTML={{ 
                  __html: DOMPurify.sanitize(header_title) 
                }}
              />
            )}
            {header_subtitle && (
              <div 
                className="quote-header-subtitle mt-2"
                style={sectionSubtitleStyle}
                dangerouslySetInnerHTML={{ 
                  __html: DOMPurify.sanitize(header_subtitle) 
                }}
              />
            )}
            {header_content && (
              <div 
                className="quote-header-content mt-4"
                style={sectionContentStyle}
                dangerouslySetInnerHTML={{ 
                  __html: DOMPurify.sanitize(header_content) 
                }}
              />
            )}
          </div>
        )}

          {renderQuotePanel()}
        </div>
      </div>
    </div>
  );
}

export function IEditQuoteElementEditor({ element, onChange }) {
  const content = element.content || {};
  const [isUploading, setIsUploading] = useState({});
  const [viewportTab, setViewportTab] = useState('desktop');
  const [expandedSections, setExpandedSections] = useState({
    sectionHeader: true,
    elementBackground: false,
    quotes: true,
    carousel: false,
    background: false,
    box: false,
    quoteTypography: false,
    nameTypography: false,
    quoteMarks: false,
    profile: false
  });
  const [expandedQuoteIndex, setExpandedQuoteIndex] = useState(0);

  // Compute default mobile values for display in editor placeholders
  const defaultMobileQuoteFontSize = Math.max(16, Math.round((content.quote_font_size || 20) * 0.85));
  const defaultMobileNameFontSize = Math.max(14, Math.round((content.name_font_size || 16) * 0.9));
  const defaultMobileQuoteMarkSize = Math.max(32, Math.round((content.quote_mark_size || 48) * 0.7));

  const quotes = content.quotes || [];

  const toggleSection = (section) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const updateContent = (key, value) => {
    onChange({ ...element, content: { ...element.content, [key]: value } });
  };

  const updateMultipleContent = (updates) => {
    onChange({ ...element, content: { ...element.content, ...updates } });
  };

  const addQuote = () => {
    if (quotes.length >= 10) {
      alert('Maximum of 10 quotes allowed');
      return;
    }
    const newQuotes = [...quotes, { quote_text: '', author_name: '', profile_image_url: '' }];
    updateContent('quotes', newQuotes);
    setExpandedQuoteIndex(newQuotes.length - 1);
  };

  const removeQuote = (index) => {
    const newQuotes = quotes.filter((_, i) => i !== index);
    updateContent('quotes', newQuotes);
    if (expandedQuoteIndex >= newQuotes.length) {
      setExpandedQuoteIndex(Math.max(0, newQuotes.length - 1));
    }
  };

  const updateQuote = (index, field, value) => {
    const newQuotes = [...quotes];
    newQuotes[index] = { ...newQuotes[index], [field]: value };
    updateContent('quotes', newQuotes);
  };

  const moveQuote = (index, direction) => {
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= quotes.length) return;
    
    const newQuotes = [...quotes];
    [newQuotes[index], newQuotes[newIndex]] = [newQuotes[newIndex], newQuotes[index]];
    updateContent('quotes', newQuotes);
    setExpandedQuoteIndex(newIndex);
  };

  const handleImageUpload = async (file, field, quoteIndex = null) => {
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

    const uploadKey = quoteIndex !== null ? `quote_${quoteIndex}_${field}` : field;
    setIsUploading(prev => ({ ...prev, [uploadKey]: true }));
    
    try {
      const { base44 } = await import("@/api/base44Client");
      const response = await base44.integrations.Core.UploadFile({ file });
      
      if (quoteIndex !== null) {
        updateQuote(quoteIndex, field, response.file_url);
      } else {
        updateContent(field, response.file_url);
      }
    } catch (error) {
      alert('Failed to upload image: ' + error.message);
    } finally {
      setIsUploading(prev => ({ ...prev, [uploadKey]: false }));
    }
  };

  const backgroundType = content.background_type || 'color';
  const gradientPreview = `linear-gradient(${content.gradient_angle || 135}deg, ${content.gradient_start_color || '#3b82f6'}, ${content.gradient_end_color || '#8b5cf6'})`;

  const SectionHeader = ({ title, section }) => (
    <button
      type="button"
      onClick={() => toggleSection(section)}
      className="w-full flex items-center justify-between py-2 px-3 bg-slate-100 hover:bg-slate-200 rounded-md text-sm font-medium text-slate-700"
    >
      {title}
      {expandedSections[section] ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
    </button>
  );

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
                ? 'bg-primary text-primary-foreground border-primary' 
                : 'bg-background border-input hover:bg-muted'
            }`}
          >
            <Icon className="h-4 w-4" />
          </button>
        ))}
      </div>
    </div>
  );

  const elementBackgroundType = content.element_background_type || 'none';
  const elementGradientPreview = `linear-gradient(${content.element_gradient_angle || 135}deg, ${content.element_gradient_start_color || '#1e3a5f'}, ${content.element_gradient_end_color || '#3b82f6'})`;

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
          placeholder="e.g., quote-section"
          className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
          data-testid="input-quote-anchor"
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
          data-testid="button-quote-viewport-desktop"
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
          data-testid="button-quote-viewport-mobile"
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
      {/* Section Header Settings */}
      <SectionHeader title="Section Header" section="sectionHeader" />
      {expandedSections.sectionHeader && (
        <div className="space-y-4 pl-2">
          {/* Header Title - Rich Text */}
          <div>
            <Label className="block text-sm font-medium mb-1">Header Title</Label>
            <div className="border border-slate-300 rounded-md overflow-hidden bg-white">
              <ReactQuill
                theme="snow"
                value={content.header_title || ''}
                onChange={(value) => updateContent('header_title', value)}
                modules={heroQuillModules}
                placeholder="e.g., What People Say"
                style={{ minHeight: '80px' }}
              />
            </div>
          </div>
          <AlignmentButtons 
            value={content.header_title_align || 'center'} 
            onChange={(val) => updateContent('header_title_align', val)}
            label="Title Alignment"
            testIdPrefix="quote-header-title-align"
          />
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
            label="Header Typography Style"
          />
          <details className="text-xs">
            <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Header Font Settings</summary>
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

          {/* Header Subtitle - Rich Text */}
          <div className="pt-4 border-t border-slate-100">
            <Label className="block text-sm font-medium mb-1">Header Subtitle</Label>
            <div className="border border-slate-300 rounded-md overflow-hidden bg-white">
              <ReactQuill
                theme="snow"
                value={content.header_subtitle || ''}
                onChange={(value) => updateContent('header_subtitle', value)}
                modules={heroQuillModules}
                placeholder="Optional subtitle text"
                style={{ minHeight: '80px' }}
              />
            </div>
          </div>
          <AlignmentButtons 
            value={content.header_subtitle_align || 'center'} 
            onChange={(val) => updateContent('header_subtitle_align', val)}
            label="Subtitle Alignment"
            testIdPrefix="quote-header-subtitle-align"
          />
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
            label="Subtitle Typography Style"
          />
          <details className="text-xs">
            <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Subtitle Font Settings</summary>
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Subtitle Font Family</Label>
                  <select
                    value={content.subtitle_font_family || 'Poppins'}
                    onChange={(e) => updateContent('subtitle_font_family', e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                  >
                    {fontFamilies.map(font => (
                      <option key={font} value={font}>{font}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label>Subtitle Font Weight</Label>
                  <select
                    value={content.subtitle_font_weight || 400}
                    onChange={(e) => updateContent('subtitle_font_weight', parseInt(e.target.value))}
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
                  <Label>Subtitle Font Size (px)</Label>
                  <Input
                    type="number"
                    value={content.subtitle_font_size || 18}
                    onChange={(e) => updateContent('subtitle_font_size', parseInt(e.target.value) || 18)}
                    min="12"
                    max="48"
                  />
                </div>
                <div>
                  <Label>Subtitle Color</Label>
                  <div className="flex gap-2 items-center">
                    <input
                      type="color"
                      value={content.subtitle_color || '#64748b'}
                      onChange={(e) => updateContent('subtitle_color', e.target.value)}
                      className="w-12 h-9 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                    />
                    <Input
                      value={content.subtitle_color || '#64748b'}
                      onChange={(e) => updateContent('subtitle_color', e.target.value)}
                      className="flex-1 font-mono text-xs"
                    />
                  </div>
                </div>
              </div>
            </div>
          </details>

          {/* Header Content - Rich Text */}
          <div className="pt-4 border-t border-slate-100">
            <Label className="block text-sm font-medium mb-1">Header Content</Label>
            <div className="border border-slate-300 rounded-md overflow-hidden bg-white">
              <ReactQuill
                theme="snow"
                value={content.header_content || ''}
                onChange={(value) => updateContent('header_content', value)}
                modules={heroQuillModules}
                placeholder="Optional content/body text for the header section"
                style={{ minHeight: '100px' }}
              />
            </div>
          </div>
          <AlignmentButtons 
            value={content.header_content_align || 'center'} 
            onChange={(val) => updateContent('header_content_align', val)}
            label="Content Alignment"
            testIdPrefix="quote-header-content-align"
          />
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
            label="Content Typography Style"
          />
          <details className="text-xs">
            <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Content Font Settings</summary>
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Content Font Family</Label>
                  <select
                    value={content.content_font_family || 'Poppins'}
                    onChange={(e) => updateContent('content_font_family', e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                  >
                    {fontFamilies.map(font => (
                      <option key={font} value={font}>{font}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label>Content Font Weight</Label>
                  <select
                    value={content.content_font_weight || 400}
                    onChange={(e) => updateContent('content_font_weight', parseInt(e.target.value))}
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
                  <Label>Content Font Size (px)</Label>
                  <Input
                    type="number"
                    value={content.content_font_size || 16}
                    onChange={(e) => updateContent('content_font_size', parseInt(e.target.value) || 16)}
                    min="12"
                    max="32"
                  />
                </div>
                <div>
                  <Label>Content Color</Label>
                  <div className="flex gap-2 items-center">
                    <input
                      type="color"
                      value={content.content_color || '#475569'}
                      onChange={(e) => updateContent('content_color', e.target.value)}
                      className="w-12 h-9 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                    />
                    <Input
                      value={content.content_color || '#475569'}
                      onChange={(e) => updateContent('content_color', e.target.value)}
                      className="flex-1 font-mono text-xs"
                    />
                  </div>
                </div>
              </div>
            </div>
          </details>
        </div>
      )}

      {/* Element Background Section */}
      <SectionHeader title="Element Background" section="elementBackground" />
      {expandedSections.elementBackground && (
        <div className="space-y-4 pl-2">
          <div>
            <Label className="block text-sm font-medium mb-1">Background Type</Label>
            <select
              value={elementBackgroundType}
              onChange={(e) => updateContent('element_background_type', e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
              data-testid="select-quote-element-bg-type"
            >
              <option value="none">None (Transparent)</option>
              <option value="color">Solid Color</option>
              <option value="gradient">Gradient</option>
              <option value="image">Image</option>
            </select>
          </div>

          {elementBackgroundType === 'color' && (
            <div>
              <Label className="block text-sm font-medium mb-1">Background Color</Label>
              <div className="flex gap-2 items-center">
                <input
                  type="color"
                  value={content.element_background_color || '#ffffff'}
                  onChange={(e) => updateContent('element_background_color', e.target.value)}
                  className="w-12 h-9 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                  data-testid="input-quote-element-bg-color"
                />
                <Input
                  value={content.element_background_color || '#ffffff'}
                  onChange={(e) => updateContent('element_background_color', e.target.value)}
                  className="flex-1 font-mono text-xs"
                />
              </div>
            </div>
          )}

          {elementBackgroundType === 'gradient' && (
            <div className="space-y-3 p-3 bg-slate-50 rounded-md">
              <div 
                className="w-full h-12 rounded-md border border-slate-300"
                style={{ background: elementGradientPreview }}
                data-testid="preview-quote-element-gradient"
              />
              
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Start Color</Label>
                  <div className="flex gap-1 items-center">
                    <input
                      type="color"
                      value={content.element_gradient_start_color || '#1e3a5f'}
                      onChange={(e) => updateContent('element_gradient_start_color', e.target.value)}
                      className="w-10 h-8 border border-slate-300 rounded cursor-pointer"
                    />
                    <Input
                      value={content.element_gradient_start_color || '#1e3a5f'}
                      onChange={(e) => updateContent('element_gradient_start_color', e.target.value)}
                      className="flex-1 font-mono text-xs"
                    />
                  </div>
                </div>
                <div>
                  <Label className="text-xs">End Color</Label>
                  <div className="flex gap-1 items-center">
                    <input
                      type="color"
                      value={content.element_gradient_end_color || '#3b82f6'}
                      onChange={(e) => updateContent('element_gradient_end_color', e.target.value)}
                      className="w-10 h-8 border border-slate-300 rounded cursor-pointer"
                    />
                    <Input
                      value={content.element_gradient_end_color || '#3b82f6'}
                      onChange={(e) => updateContent('element_gradient_end_color', e.target.value)}
                      className="flex-1 font-mono text-xs"
                    />
                  </div>
                </div>
              </div>
              
              <div>
                <Label className="text-xs">Angle: {content.element_gradient_angle || 135}°</Label>
                <input
                  type="range"
                  min="0"
                  max="360"
                  value={content.element_gradient_angle || 135}
                  onChange={(e) => updateContent('element_gradient_angle', parseInt(e.target.value))}
                  className="w-full"
                />
              </div>
            </div>
          )}

          {elementBackgroundType === 'image' && (
            <div className="space-y-3">
              <div>
                <Label className="block text-sm font-medium mb-1">Background Image</Label>
                {content.element_background_image_url ? (
                  <div className="relative">
                    <img 
                      src={content.element_background_image_url} 
                      alt="Element background" 
                      className="w-full h-32 object-cover rounded-md border border-slate-300"
                    />
                    <button
                      type="button"
                      onClick={() => updateContent('element_background_image_url', '')}
                      className="absolute top-2 right-2 p-1 bg-red-500 text-white rounded-full hover:bg-red-600"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-slate-300 rounded-md cursor-pointer hover:border-slate-400 bg-slate-50">
                    <Upload className="w-8 h-8 text-slate-400 mb-2" />
                    <span className="text-sm text-slate-500">Upload image</span>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => handleImageUpload(e.target.files?.[0], 'element_background_image_url')}
                      className="hidden"
                    />
                  </label>
                )}
              </div>

              <div>
                <Label className="block text-sm font-medium mb-1">Image Fit</Label>
                <select
                  value={content.element_background_image_fit || 'cover'}
                  onChange={(e) => updateContent('element_background_image_fit', e.target.value)}
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
                  id="element_overlay_enabled"
                  checked={content.element_overlay_enabled || false}
                  onChange={(e) => updateContent('element_overlay_enabled', e.target.checked)}
                  className="rounded border-slate-300"
                />
                <Label htmlFor="element_overlay_enabled">Enable Overlay</Label>
              </div>

              {content.element_overlay_enabled && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">Overlay Color</Label>
                    <input
                      type="color"
                      value={content.element_overlay_color || '#000000'}
                      onChange={(e) => updateContent('element_overlay_color', e.target.value)}
                      className="w-full h-9 border border-slate-300 rounded cursor-pointer"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Overlay Opacity: {content.element_overlay_opacity || 50}%</Label>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={content.element_overlay_opacity || 50}
                      onChange={(e) => updateContent('element_overlay_opacity', parseInt(e.target.value))}
                      className="w-full"
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Element Padding */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Top Padding (px)</Label>
              <Input
                type="number"
                min="0"
                value={content.element_padding_top || 40}
                onChange={(e) => updateContent('element_padding_top', parseInt(e.target.value) || 0)}
                className="h-8"
              />
            </div>
            <div>
              <Label className="text-xs">Bottom Padding (px)</Label>
              <Input
                type="number"
                min="0"
                value={content.element_padding_bottom || 40}
                onChange={(e) => updateContent('element_padding_bottom', parseInt(e.target.value) || 0)}
                className="h-8"
              />
            </div>
          </div>
        </div>
      )}

      {/* Quotes Section */}
      <SectionHeader title={`Quotes (${quotes.length}/10)`} section="quotes" />
      {expandedSections.quotes && (
        <div className="space-y-3 pl-2">
          {quotes.length === 0 && (
            <p className="text-sm text-slate-500 italic">No quotes added yet. Click "Add Quote" to get started.</p>
          )}
          
          {quotes.map((quote, index) => (
            <div key={index} className="border border-slate-200 rounded-lg overflow-hidden">
              <div 
                className="flex items-center gap-2 p-2 bg-slate-50 cursor-pointer"
                onClick={() => setExpandedQuoteIndex(expandedQuoteIndex === index ? -1 : index)}
              >
                <GripVertical className="w-4 h-4 text-slate-400" />
                <span className="flex-1 text-sm font-medium truncate">
                  {quote.author_name || quote.quote_text?.substring(0, 30) || `Quote ${index + 1}`}
                  {quote.quote_text && quote.quote_text.length > 30 && '...'}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); moveQuote(index, -1); }}
                    disabled={index === 0}
                    className="p-1 text-slate-400 hover:text-slate-600 disabled:opacity-30"
                  >
                    <ChevronUp className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); moveQuote(index, 1); }}
                    disabled={index === quotes.length - 1}
                    className="p-1 text-slate-400 hover:text-slate-600 disabled:opacity-30"
                  >
                    <ChevronDown className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); removeQuote(index); }}
                    className="p-1 text-red-400 hover:text-red-600"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
              
              {expandedQuoteIndex === index && (
                <div className="p-3 space-y-3 bg-white">
                  <div>
                    <label className="block text-sm font-medium mb-1">Quote Text</label>
                    <textarea
                      value={quote.quote_text || ''}
                      onChange={(e) => updateQuote(index, 'quote_text', e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                      rows={3}
                      placeholder="Enter the quote text..."
                    />
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium mb-1">Author Name</label>
                    <input
                      type="text"
                      value={quote.author_name || ''}
                      onChange={(e) => updateQuote(index, 'author_name', e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                      placeholder="Author name"
                    />
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium mb-1">Profile Picture</label>
                    <div className="space-y-2">
                      <label className="inline-block">
                        <div className={`px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer ${
                          isUploading[`quote_${index}_profile_image_url`]
                            ? 'bg-slate-300 cursor-not-allowed' 
                            : 'bg-blue-600 hover:bg-blue-700 text-white'
                        }`}>
                          {isUploading[`quote_${index}_profile_image_url`] ? 'Uploading...' : 'Upload'}
                        </div>
                        <input
                          type="file"
                          accept="image/*"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) handleImageUpload(file, 'profile_image_url', index);
                            e.target.value = '';
                          }}
                          className="hidden"
                          disabled={isUploading[`quote_${index}_profile_image_url`]}
                        />
                      </label>
                    </div>
                    {quote.profile_image_url && (
                      <div className="mt-2 relative inline-block">
                        <img
                          src={quote.profile_image_url}
                          alt="Profile"
                          className="w-16 h-16 object-cover rounded-full"
                        />
                        <button
                          onClick={() => updateQuote(index, 'profile_image_url', '')}
                          className="absolute -top-1 -right-1 p-0.5 bg-red-600 hover:bg-red-700 text-white rounded-full"
                          type="button"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
          
          <button
            type="button"
            onClick={addQuote}
            disabled={quotes.length >= 10}
            className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-blue-600 hover:text-blue-700 hover:bg-blue-50 rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus className="w-4 h-4" />
            Add Quote
          </button>
        </div>
      )}

      {/* Carousel Settings Section */}
      <SectionHeader title="Carousel Settings" section="carousel" />
      {expandedSections.carousel && (
        <div className="space-y-3 pl-2">
          <div>
            <label className="block text-sm font-medium mb-1">Layout</label>
            <select
              value={content.layout || 'stacked'}
              onChange={(e) => updateContent('layout', e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
            >
              <option value="stacked">Stacked (centered)</option>
              <option value="side">Side by Side</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              Container Height (px)
            </label>
            <Input
              type="number"
              min="0"
              step="10"
              value={content.container_height || 0}
              onChange={(e) => updateContent('container_height', parseInt(e.target.value) || 0)}
              placeholder="0 = auto"
            />
            <p className="text-xs text-slate-500 mt-1">
              Set a fixed height to prevent layout shift when rotating. 0 = auto height.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Vertical Alignment</label>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => updateContent('content_vertical_align', 'top')}
                className={`flex-1 px-3 py-2 text-sm rounded-md border ${
                  content.content_vertical_align === 'top' 
                    ? 'bg-blue-500 text-white border-blue-500' 
                    : 'bg-white border-slate-300 hover:bg-slate-50'
                }`}
              >
                Top
              </button>
              <button
                type="button"
                onClick={() => updateContent('content_vertical_align', 'middle')}
                className={`flex-1 px-3 py-2 text-sm rounded-md border ${
                  (!content.content_vertical_align || content.content_vertical_align === 'middle')
                    ? 'bg-blue-500 text-white border-blue-500' 
                    : 'bg-white border-slate-300 hover:bg-slate-50'
                }`}
              >
                Middle
              </button>
              <button
                type="button"
                onClick={() => updateContent('content_vertical_align', 'bottom')}
                className={`flex-1 px-3 py-2 text-sm rounded-md border ${
                  content.content_vertical_align === 'bottom' 
                    ? 'bg-blue-500 text-white border-blue-500' 
                    : 'bg-white border-slate-300 hover:bg-slate-50'
                }`}
              >
                Bottom
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              Auto-rotate Delay: {((content.carousel_delay || 5000) / 1000).toFixed(1)}s
            </label>
            <input
              type="range"
              min="2000"
              max="15000"
              step="500"
              value={content.carousel_delay || 5000}
              onChange={(e) => updateContent('carousel_delay', parseInt(e.target.value))}
              className="w-full"
            />
            <div className="flex justify-between text-xs text-slate-500 mt-1">
              <span>2s</span>
              <span>15s</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="show_navigation"
              checked={content.show_navigation !== false}
              onChange={(e) => updateContent('show_navigation', e.target.checked)}
              className="rounded"
            />
            <label htmlFor="show_navigation" className="text-sm">Show navigation arrows</label>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="show_indicators"
              checked={content.show_indicators !== false}
              onChange={(e) => updateContent('show_indicators', e.target.checked)}
              className="rounded"
            />
            <label htmlFor="show_indicators" className="text-sm">Show dot indicators</label>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="pause_on_hover"
              checked={content.pause_on_hover !== false}
              onChange={(e) => updateContent('pause_on_hover', e.target.checked)}
              className="rounded"
            />
            <label htmlFor="pause_on_hover" className="text-sm">Pause on hover</label>
          </div>
        </div>
      )}

      {/* Background Section */}
      <SectionHeader title="Background" section="background" />
      {expandedSections.background && (
        <div className="space-y-3 pl-2">
          <div>
            <label className="block text-sm font-medium mb-1">Background Type</label>
            <select
              value={backgroundType}
              onChange={(e) => updateContent('background_type', e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
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
                  value={content.background_color || '#f8fafc'}
                  onChange={(e) => updateContent('background_color', e.target.value)}
                  className="w-16 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                />
                <input
                  type="text"
                  value={content.background_color || '#f8fafc'}
                  onChange={(e) => updateContent('background_color', e.target.value)}
                  className="flex-1 px-3 py-2 border border-slate-300 rounded-md font-mono text-sm"
                />
              </div>
            </div>
          )}

          {backgroundType === 'gradient' && (
            <div className="space-y-3 p-3 bg-slate-50 rounded-md">
              <div 
                className="w-full h-12 rounded-md border border-slate-300"
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
                      isUploading.background_image_url
                        ? 'bg-slate-300 cursor-not-allowed' 
                        : 'bg-blue-600 hover:bg-blue-700 text-white'
                    }`}>
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
                      className="w-full h-24 object-cover rounded"
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
                <label className="block text-sm font-medium mb-1">Image Fit</label>
                <select
                  value={content.background_image_fit || 'cover'}
                  onChange={(e) => updateContent('background_image_fit', e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                >
                  <option value="cover">Cover</option>
                  <option value="contain">Contain</option>
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
                        onChange={(e) => updateContent('overlay_opacity', parseInt(e.target.value))}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
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

      {/* Box Settings Section */}
      <SectionHeader title="Box Settings" section="box" />
      {expandedSections.box && (
        <div className="space-y-3 pl-2">
          <div>
            <label className="block text-sm font-medium mb-1">Padding (px)</label>
            <input
              type="number"
              value={content.box_padding || 40}
              onChange={(e) => updateContent('box_padding', parseInt(e.target.value))}
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
              min="0"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Border Radius (px)</label>
            <input
              type="number"
              value={content.box_border_radius || 12}
              onChange={(e) => updateContent('box_border_radius', parseInt(e.target.value))}
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
              min="0"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">Border Color</label>
              <input
                type="color"
                value={content.box_border_color || '#e2e8f0'}
                onChange={(e) => updateContent('box_border_color', e.target.value)}
                className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Border Width (px)</label>
              <input
                type="number"
                value={content.box_border_width || 1}
                onChange={(e) => updateContent('box_border_width', parseInt(e.target.value))}
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                min="0"
              />
            </div>
          </div>
        </div>
      )}

      {/* Quote Typography Section */}
      <SectionHeader title="Quote Typography" section="quoteTypography" />
      {expandedSections.quoteTypography && (
        <div className="space-y-3 pl-2">
          <TypographyStyleSelector
            value={content.quote_typography_style_id}
            onChange={(styleId) => updateContent('quote_typography_style_id', styleId)}
            onApplyStyle={(style) => {
              const mapped = applyTypographyStyle(style);
              if (mapped.font_family) updateContent('quote_font_family', mapped.font_family);
              if (mapped.font_size) updateContent('quote_font_size', mapped.font_size);
              if (mapped.font_weight) updateContent('quote_font_weight', mapped.font_weight);
              if (mapped.line_height) updateContent('quote_line_height', mapped.line_height);
              if (mapped.letter_spacing !== undefined) updateContent('quote_letter_spacing', mapped.letter_spacing);
              if (mapped.color) updateContent('quote_color', mapped.color);
            }}
            filterTypes={['paragraph', 'quote']}
            label="Quote Typography Style"
          />

          <div>
            <label className="block text-sm font-medium mb-1">Font Family</label>
            <select
              value={content.quote_font_family || 'Georgia'}
              onChange={(e) => updateContent('quote_font_family', e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
            >
              {fontFamilies.map(font => (
                <option key={font} value={font}>{font}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">Font Size (px)</label>
              <input
                type="number"
                value={content.quote_font_size || 20}
                onChange={(e) => updateContent('quote_font_size', parseInt(e.target.value))}
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                min="12"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Font Weight</label>
              <select
                value={content.quote_font_weight || 400}
                onChange={(e) => updateContent('quote_font_weight', parseInt(e.target.value))}
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
              >
                {fontWeights.map(w => (
                  <option key={w.value} value={w.value}>{w.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">Font Style</label>
              <select
                value={content.quote_font_style || 'italic'}
                onChange={(e) => updateContent('quote_font_style', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
              >
                <option value="normal">Normal</option>
                <option value="italic">Italic</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Text Align</label>
              <select
                value={content.quote_align || 'center'}
                onChange={(e) => updateContent('quote_align', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Text Color</label>
            <div className="flex gap-2 items-center">
              <input
                type="color"
                value={content.quote_color || '#1e293b'}
                onChange={(e) => updateContent('quote_color', e.target.value)}
                className="w-16 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
              />
              <input
                type="text"
                value={content.quote_color || '#1e293b'}
                onChange={(e) => updateContent('quote_color', e.target.value)}
                className="flex-1 px-3 py-2 border border-slate-300 rounded-md font-mono text-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">Letter Spacing (px)</label>
              <input
                type="number"
                value={content.quote_letter_spacing || 0}
                onChange={(e) => updateContent('quote_letter_spacing', parseFloat(e.target.value))}
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                step="0.1"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Line Height</label>
              <input
                type="number"
                value={content.quote_line_height || 1.6}
                onChange={(e) => updateContent('quote_line_height', parseFloat(e.target.value))}
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                step="0.1"
                min="1"
              />
            </div>
          </div>
        </div>
      )}

      {/* Name Typography Section */}
      <SectionHeader title="Author Typography" section="nameTypography" />
      {expandedSections.nameTypography && (
        <div className="space-y-3 pl-2">
          <TypographyStyleSelector
            value={content.name_typography_style_id}
            onChange={(styleId) => updateContent('name_typography_style_id', styleId)}
            onApplyStyle={(style) => {
              const mapped = applyTypographyStyle(style);
              if (mapped.font_family) updateContent('name_font_family', mapped.font_family);
              if (mapped.font_size) updateContent('name_font_size', mapped.font_size);
              if (mapped.font_weight) updateContent('name_font_weight', mapped.font_weight);
              if (mapped.letter_spacing !== undefined) updateContent('name_letter_spacing', mapped.letter_spacing);
              if (mapped.color) updateContent('name_color', mapped.color);
            }}
            filterTypes={['paragraph']}
            label="Author Typography Style"
          />

          <div>
            <label className="block text-sm font-medium mb-1">Font Family</label>
            <select
              value={content.name_font_family || 'Poppins'}
              onChange={(e) => updateContent('name_font_family', e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
            >
              {fontFamilies.map(font => (
                <option key={font} value={font}>{font}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">Font Size (px)</label>
              <input
                type="number"
                value={content.name_font_size || 16}
                onChange={(e) => updateContent('name_font_size', parseInt(e.target.value))}
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                min="10"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Font Weight</label>
              <select
                value={content.name_font_weight || 600}
                onChange={(e) => updateContent('name_font_weight', parseInt(e.target.value))}
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
              >
                {fontWeights.map(w => (
                  <option key={w.value} value={w.value}>{w.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Text Color</label>
            <div className="flex gap-2 items-center">
              <input
                type="color"
                value={content.name_color || '#475569'}
                onChange={(e) => updateContent('name_color', e.target.value)}
                className="w-16 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
              />
              <input
                type="text"
                value={content.name_color || '#475569'}
                onChange={(e) => updateContent('name_color', e.target.value)}
                className="flex-1 px-3 py-2 border border-slate-300 rounded-md font-mono text-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">Letter Spacing (px)</label>
              <input
                type="number"
                value={content.name_letter_spacing || 0}
                onChange={(e) => updateContent('name_letter_spacing', parseFloat(e.target.value))}
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                step="0.1"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Text Align</label>
              <select
                value={content.name_align || 'center'}
                onChange={(e) => updateContent('name_align', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </div>
          </div>
        </div>
      )}

      {/* Quote Marks Section */}
      <SectionHeader title="Quote Marks" section="quoteMarks" />
      {expandedSections.quoteMarks && (
        <div className="space-y-3 pl-2">
          {/* Custom Quote Mark Images */}
          <div className="space-y-3 p-3 bg-slate-50 rounded-md">
            <p className="text-sm font-medium text-slate-700">Custom Quote Mark Images</p>
            <p className="text-xs text-slate-500">Upload PNG or SVG images to replace the default quote marks</p>
            
            {/* Top Right Quote Mark */}
            <div>
              <label className="block text-sm font-medium mb-1">Top Right Quote Mark</label>
              <div className="space-y-2">
                <label className="inline-block">
                  <div className={`px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer ${
                    isUploading['quote_mark_top_image_url']
                      ? 'bg-slate-300 cursor-not-allowed' 
                      : 'bg-blue-600 hover:bg-blue-700 text-white'
                  }`}>
                    {isUploading['quote_mark_top_image_url'] ? 'Uploading...' : 'Upload Image'}
                  </div>
                  <input
                    type="file"
                    accept="image/png,image/svg+xml"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleImageUpload(file, 'quote_mark_top_image_url');
                      e.target.value = '';
                    }}
                    className="hidden"
                    disabled={isUploading['quote_mark_top_image_url']}
                  />
                </label>
              </div>
              {content.quote_mark_top_image_url && (
                <div className="mt-2 relative inline-block">
                  <img
                    src={content.quote_mark_top_image_url}
                    alt="Top quote mark"
                    className="w-12 h-12 object-contain bg-slate-100 rounded p-1"
                  />
                  <button
                    onClick={() => updateContent('quote_mark_top_image_url', '')}
                    className="absolute -top-1 -right-1 p-0.5 bg-red-600 hover:bg-red-700 text-white rounded-full"
                    type="button"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              )}
            </div>

            {/* Bottom Left Quote Mark */}
            <div>
              <label className="block text-sm font-medium mb-1">Bottom Left Quote Mark</label>
              <div className="space-y-2">
                <label className="inline-block">
                  <div className={`px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer ${
                    isUploading['quote_mark_bottom_image_url']
                      ? 'bg-slate-300 cursor-not-allowed' 
                      : 'bg-blue-600 hover:bg-blue-700 text-white'
                  }`}>
                    {isUploading['quote_mark_bottom_image_url'] ? 'Uploading...' : 'Upload Image'}
                  </div>
                  <input
                    type="file"
                    accept="image/png,image/svg+xml"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleImageUpload(file, 'quote_mark_bottom_image_url');
                      e.target.value = '';
                    }}
                    className="hidden"
                    disabled={isUploading['quote_mark_bottom_image_url']}
                  />
                </label>
              </div>
              {content.quote_mark_bottom_image_url && (
                <div className="mt-2 relative inline-block">
                  <img
                    src={content.quote_mark_bottom_image_url}
                    alt="Bottom quote mark"
                    className="w-12 h-12 object-contain bg-slate-100 rounded p-1"
                    style={{ transform: 'rotate(180deg)' }}
                  />
                  <button
                    onClick={() => updateContent('quote_mark_bottom_image_url', '')}
                    className="absolute -top-1 -right-1 p-0.5 bg-red-600 hover:bg-red-700 text-white rounded-full"
                    type="button"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Default Quote Mark Styling (shown when no custom images) */}
          <div className={content.quote_mark_top_image_url && content.quote_mark_bottom_image_url ? 'opacity-50' : ''}>
            <p className="text-xs text-slate-500 mb-2">
              {content.quote_mark_top_image_url || content.quote_mark_bottom_image_url 
                ? 'Color applies to quote marks without custom images' 
                : 'Default quote mark styling'}
            </p>
            <div>
              <label className="block text-sm font-medium mb-1">Color</label>
              <div className="flex gap-2 items-center">
                <input
                  type="color"
                  value={content.quote_mark_color || '#cbd5e1'}
                  onChange={(e) => updateContent('quote_mark_color', e.target.value)}
                  className="w-16 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                />
                <input
                  type="text"
                  value={content.quote_mark_color || '#cbd5e1'}
                  onChange={(e) => updateContent('quote_mark_color', e.target.value)}
                  className="flex-1 px-3 py-2 border border-slate-300 rounded-md font-mono text-sm"
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">Size (px)</label>
              <input
                type="number"
                value={content.quote_mark_size || 48}
                onChange={(e) => updateContent('quote_mark_size', parseInt(e.target.value))}
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                min="20"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Opacity (%)</label>
              <input
                type="number"
                value={content.quote_mark_opacity || 50}
                onChange={(e) => updateContent('quote_mark_opacity', parseInt(e.target.value))}
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                min="0"
                max="100"
              />
            </div>
          </div>
        </div>
      )}

      {/* Profile Picture Section */}
      <SectionHeader title="Profile Picture Settings" section="profile" />
      {expandedSections.profile && (
        <div className="space-y-3 pl-2">
          <div>
            <label className="block text-sm font-medium mb-1">Size (px)</label>
            <input
              type="number"
              value={content.profile_size || 80}
              onChange={(e) => updateContent('profile_size', parseInt(e.target.value))}
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
              min="40"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Border Radius (%)</label>
            <input
              type="number"
              value={content.profile_border_radius || 50}
              onChange={(e) => updateContent('profile_border_radius', parseInt(e.target.value))}
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
              min="0"
              max="50"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">Border Color</label>
              <input
                type="color"
                value={content.profile_border_color || '#e2e8f0'}
                onChange={(e) => updateContent('profile_border_color', e.target.value)}
                className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Border Width (px)</label>
              <input
                type="number"
                value={content.profile_border_width || 2}
                onChange={(e) => updateContent('profile_border_width', parseInt(e.target.value))}
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                min="0"
              />
            </div>
          </div>
        </div>
      )}
        </>
      )}

      {/* Mobile Controls */}
      {viewportTab === 'mobile' && (
        <div className="space-y-4">
          <p className="text-xs text-slate-600 p-3 bg-blue-50 rounded-lg">
            Leave fields empty to use automatic scaling based on desktop values.
          </p>

          {/* Mobile Typography Section */}
          <div className="border rounded-lg p-4 space-y-4">
            <h4 className="font-semibold text-sm">Quote Typography</h4>
            
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Quote Font Size</label>
                <input
                  type="number"
                  value={content.mobile_quote_font_size || ''}
                  onChange={(e) => updateContent('mobile_quote_font_size', e.target.value ? parseInt(e.target.value) : undefined)}
                  placeholder={`Auto: ${defaultMobileQuoteFontSize}px`}
                  className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                  min="10"
                  data-testid="input-quote-mobile-quote-size"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Name Font Size</label>
                <input
                  type="number"
                  value={content.mobile_name_font_size || ''}
                  onChange={(e) => updateContent('mobile_name_font_size', e.target.value ? parseInt(e.target.value) : undefined)}
                  placeholder={`Auto: ${defaultMobileNameFontSize}px`}
                  className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                  min="10"
                  data-testid="input-quote-mobile-name-size"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Quote Alignment</label>
                <select
                  value={content.mobile_quote_align || ''}
                  onChange={(e) => updateContent('mobile_quote_align', e.target.value || undefined)}
                  className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                  data-testid="select-quote-mobile-quote-align"
                >
                  <option value="">Use Desktop ({content.quote_align || 'center'})</option>
                  <option value="left">Left</option>
                  <option value="center">Center</option>
                  <option value="right">Right</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Name Alignment</label>
                <select
                  value={content.mobile_name_align || ''}
                  onChange={(e) => updateContent('mobile_name_align', e.target.value || undefined)}
                  className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                  data-testid="select-quote-mobile-name-align"
                >
                  <option value="">Use Desktop ({content.name_align || 'center'})</option>
                  <option value="left">Left</option>
                  <option value="center">Center</option>
                  <option value="right">Right</option>
                </select>
              </div>
            </div>
          </div>

          {/* Mobile Quote Marks Section */}
          <div className="border rounded-lg p-4 space-y-4">
            <h4 className="font-semibold text-sm">Quote Marks</h4>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Quote Mark Size</label>
                <input
                  type="number"
                  value={content.mobile_quote_mark_size || ''}
                  onChange={(e) => updateContent('mobile_quote_mark_size', e.target.value ? parseInt(e.target.value) : undefined)}
                  placeholder={`Auto: ${defaultMobileQuoteMarkSize}px`}
                  className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                  min="16"
                  data-testid="input-quote-mobile-mark-size"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Quote Mark Opacity</label>
                <input
                  type="number"
                  value={content.mobile_quote_mark_opacity ?? ''}
                  onChange={(e) => updateContent('mobile_quote_mark_opacity', e.target.value ? parseInt(e.target.value) : undefined)}
                  placeholder={`Desktop: ${content.quote_mark_opacity || 50}%`}
                  className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                  min="0"
                  max="100"
                  data-testid="input-quote-mobile-mark-opacity"
                />
              </div>
            </div>
          </div>

          {/* Mobile Section Header Typography */}
          <div className="border rounded-lg p-4 space-y-4">
            <h4 className="font-semibold text-sm">Section Header</h4>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Header Font Size</label>
                <input
                  type="number"
                  value={content.header_font_size_mobile || ''}
                  onChange={(e) => updateContent('header_font_size_mobile', e.target.value ? parseInt(e.target.value) : undefined)}
                  placeholder={`Auto: ${Math.max(20, Math.round((content.header_font_size || 32) * 0.75))}px`}
                  className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                  min="12"
                  data-testid="input-quote-mobile-header-size"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Subtitle Font Size</label>
                <input
                  type="number"
                  value={content.subtitle_font_size_mobile || ''}
                  onChange={(e) => updateContent('subtitle_font_size_mobile', e.target.value ? parseInt(e.target.value) : undefined)}
                  placeholder={`Auto: ${Math.max(14, Math.round((content.subtitle_font_size || 18) * 0.85))}px`}
                  className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                  min="12"
                  data-testid="input-quote-mobile-subtitle-size"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Content Font Size</label>
              <input
                type="number"
                value={content.content_font_size_mobile || ''}
                onChange={(e) => updateContent('content_font_size_mobile', e.target.value ? parseInt(e.target.value) : undefined)}
                placeholder={`Auto: ${Math.max(12, Math.round((content.content_font_size || 16) * 0.9))}px`}
                className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                min="10"
                data-testid="input-quote-mobile-content-size"
              />
            </div>
          </div>

          {/* Mobile Padding Section */}
          <div className="border rounded-lg p-4 space-y-4">
            <h4 className="font-semibold text-sm">Padding</h4>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Element Pad Top</label>
                <input
                  type="number"
                  value={content.mobile_element_padding_top ?? ''}
                  onChange={(e) => updateContent('mobile_element_padding_top', e.target.value ? parseInt(e.target.value) : undefined)}
                  placeholder={`Desktop: ${content.element_padding_top || 40}`}
                  className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                  min="0"
                  data-testid="input-quote-mobile-padding-top"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Element Pad Bottom</label>
                <input
                  type="number"
                  value={content.mobile_element_padding_bottom ?? ''}
                  onChange={(e) => updateContent('mobile_element_padding_bottom', e.target.value ? parseInt(e.target.value) : undefined)}
                  placeholder={`Desktop: ${content.element_padding_bottom || 40}`}
                  className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                  min="0"
                  data-testid="input-quote-mobile-padding-bottom"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Box Padding</label>
              <input
                type="number"
                value={content.mobile_box_padding ?? ''}
                onChange={(e) => updateContent('mobile_box_padding', e.target.value ? parseInt(e.target.value) : undefined)}
                placeholder={`Desktop: ${content.box_padding || 40}`}
                className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                min="0"
                data-testid="input-quote-mobile-box-padding"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
