import { useState, useEffect, useId } from "react";
import AGCASButton from "../../ui/AGCASButton";
import TypographyStyleSelector, { applyTypographyStyle, useTypographyStyles } from "../TypographyStyleSelector";
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import DOMPurify from 'dompurify';
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ChevronUp, ChevronDown, Monitor, Smartphone } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function IEditButtonBlockElement({ content, variant, settings, previewViewport }) {
  const instanceId = useId().replace(/:/g, '_');
  const isMobilePreview = previewViewport === 'mobile';
  const fullWidth = settings?.fullWidth;
  const { getStyleById } = useTypographyStyles();
  
  // Debug log - check if mobile preview class is being set
  
  const { 
    anchor,
    heading_typography_style_id,
    subheading_typography_style_id,
    content_typography_style_id,
    // Desktop typography - Heading
    heading_text = '',
    heading_font_family = 'Poppins',
    heading_font_size = 32,
    heading_font_weight = 700,
    heading_line_height = 1.2,
    heading_letter_spacing = 0,
    heading_color = '#1e293b',
    // Desktop typography - Subheading
    subheading_text = '',
    subheading_font_family = 'Poppins',
    subheading_font_size = 20,
    subheading_font_weight = 400,
    subheading_line_height = 1.5,
    subheading_letter_spacing = 0,
    subheading_color = '#475569',
    // Desktop typography - Content
    body_content = '',
    content_font_family = 'Poppins',
    content_font_size = 16,
    content_font_weight = 400,
    content_line_height = 1.6,
    content_letter_spacing = 0,
    content_color = '#64748b',
    // Desktop layout
    text_align = 'center',
    button_alignment,  // Separate alignment for buttons (left, center, right)
    background_color = '#ffffff',
    padding_top = 48,
    padding_bottom = 48,
    padding_left = 16,
    padding_right = 16,
    button_gap = '16',
    buttons = [],
    // Uniform button width
    uniform_button_width = false,
    mobile_uniform_button_width,
    // Mobile button alignment
    mobile_button_alignment,
    // Mobile custom flags
    mobile_custom_typography = false,
    mobile_custom_padding = false,
    // Mobile typography overrides
    mobile_heading_font_size,
    mobile_heading_line_height,
    mobile_heading_letter_spacing,
    mobile_subheading_font_size,
    mobile_subheading_line_height,
    mobile_content_font_size,
    mobile_content_line_height,
    mobile_text_align,
    mobile_text_color,
    // Mobile padding overrides
    mobile_padding_top,
    mobile_padding_bottom,
    mobile_padding_left,
    mobile_padding_right,
    // Mobile button gap
    mobile_button_gap,
  } = content;

  // Compute effective mobile values (respecting toggle flags)
  const defaultMobileHeadingSize = Math.max(24, Math.round(heading_font_size * 0.7));
  const defaultMobileSubheadingSize = Math.max(16, Math.round(subheading_font_size * 0.85));
  const defaultMobileContentSize = Math.max(14, Math.round(content_font_size * 0.9));
  const defaultMobilePaddingTop = Math.max(32, Math.round(padding_top * 0.6));
  const defaultMobilePaddingBottom = Math.max(32, Math.round(padding_bottom * 0.6));
  const defaultMobilePaddingLeft = Math.max(16, Math.round(padding_left * 0.8));
  const defaultMobilePaddingRight = Math.max(16, Math.round(padding_right * 0.8));

  // Effective mobile values
  const headingTypographyStyle = getStyleById(heading_typography_style_id);
  const subheadingTypographyStyle = getStyleById(subheading_typography_style_id);
  const contentTypographyStyle = getStyleById(content_typography_style_id);

  const mobileHeadingFontSize = headingTypographyStyle?.font_size_mobile || (mobile_custom_typography && mobile_heading_font_size ? mobile_heading_font_size : defaultMobileHeadingSize);
  const mobileHeadingLineHeight = mobile_custom_typography && mobile_heading_line_height ? mobile_heading_line_height : heading_line_height;
  const mobileHeadingLetterSpacing = mobile_custom_typography && mobile_heading_letter_spacing !== undefined ? mobile_heading_letter_spacing : heading_letter_spacing;
  const mobileSubheadingFontSize = subheadingTypographyStyle?.font_size_mobile || (mobile_custom_typography && mobile_subheading_font_size ? mobile_subheading_font_size : defaultMobileSubheadingSize);
  const mobileSubheadingLineHeight = mobile_custom_typography && mobile_subheading_line_height ? mobile_subheading_line_height : subheading_line_height;
  const mobileContentFontSize = contentTypographyStyle?.font_size_mobile || (mobile_custom_typography && mobile_content_font_size ? mobile_content_font_size : defaultMobileContentSize);
  const mobileContentLineHeight = mobile_custom_typography && mobile_content_line_height ? mobile_content_line_height : content_line_height;
  const mobileTextAlign = mobile_custom_typography && mobile_text_align ? mobile_text_align : text_align;
  const effectiveMobileTextColor = mobile_custom_typography && mobile_text_color ? mobile_text_color : null;

  const mobilePaddingTop = mobile_custom_padding && mobile_padding_top !== undefined ? mobile_padding_top : defaultMobilePaddingTop;
  const mobilePaddingBottom = mobile_custom_padding && mobile_padding_bottom !== undefined ? mobile_padding_bottom : defaultMobilePaddingBottom;
  const mobilePaddingLeft = mobile_custom_padding && mobile_padding_left !== undefined ? mobile_padding_left : defaultMobilePaddingLeft;
  const mobilePaddingRight = mobile_custom_padding && mobile_padding_right !== undefined ? mobile_padding_right : defaultMobilePaddingRight;

  // Effective uniform width (mobile inherits from desktop if not explicitly set)
  const effectiveMobileUniformWidth = mobile_uniform_button_width !== undefined ? mobile_uniform_button_width : uniform_button_width;
  
  // Effective mobile button gap (inherits from desktop if not set)
  const effectiveMobileButtonGap = mobile_button_gap !== undefined ? mobile_button_gap : button_gap;
  
  // Effective button alignment (defaults to text_align if not set)
  const effectiveButtonAlignment = button_alignment || text_align;
  const effectiveMobileButtonAlignment = mobile_button_alignment !== undefined ? mobile_button_alignment : (mobile_text_align || effectiveButtonAlignment);

  // Filter out empty buttons
  const validButtons = buttons.filter(btn => btn?.text && btn?.text.trim() !== '');
  const hasTextContent = heading_text || subheading_text || body_content;

  // Full width breakout class
  const fullWidthClass = fullWidth ? 'w-screen relative left-1/2 right-1/2 -ml-[50vw] -mr-[50vw]' : '';

  // Generate responsive CSS (for actual mobile viewport AND preview mode)
  const responsiveStyles = `
    /* Desktop styles */
    .buttonblock-${instanceId} .bb-container {
      background-color: ${background_color};
      padding-top: ${padding_top}px;
      padding-bottom: ${padding_bottom}px;
      padding-left: ${padding_left}px;
      padding-right: ${padding_right}px;
    }
    
    .buttonblock-${instanceId} .bb-text-wrapper {
      align-items: ${text_align === 'center' ? 'center' : text_align === 'right' ? 'flex-end' : 'flex-start'};
    }
    
    .buttonblock-${instanceId} .bb-heading {
      font-family: ${headingTypographyStyle?.font_family || heading_font_family};
      font-size: ${headingTypographyStyle?.font_size || heading_font_size}px;
      font-weight: ${headingTypographyStyle?.font_weight || heading_font_weight};
      line-height: ${headingTypographyStyle?.line_height || heading_line_height};
      letter-spacing: ${headingTypographyStyle?.letter_spacing || heading_letter_spacing}px;
      color: ${headingTypographyStyle?.color || heading_color};
      text-align: ${text_align};
    }
    
    .buttonblock-${instanceId} .bb-subheading {
      font-family: ${subheadingTypographyStyle?.font_family || subheading_font_family};
      font-size: ${subheadingTypographyStyle?.font_size || subheading_font_size}px;
      font-weight: ${subheadingTypographyStyle?.font_weight || subheading_font_weight};
      line-height: ${subheadingTypographyStyle?.line_height || subheading_line_height};
      letter-spacing: ${subheadingTypographyStyle?.letter_spacing || subheading_letter_spacing}px;
      color: ${subheadingTypographyStyle?.color || subheading_color};
      text-align: ${text_align};
    }
    
    .buttonblock-${instanceId} .bb-content {
      font-family: ${contentTypographyStyle?.font_family || content_font_family};
      font-size: ${contentTypographyStyle?.font_size || content_font_size}px;
      font-weight: ${contentTypographyStyle?.font_weight || content_font_weight};
      line-height: ${contentTypographyStyle?.line_height || content_line_height};
      letter-spacing: ${contentTypographyStyle?.letter_spacing || content_letter_spacing}px;
      color: ${contentTypographyStyle?.color || content_color};
      text-align: ${text_align};
    }
    
    .buttonblock-${instanceId} .bb-buttons {
      display: flex;
      flex-wrap: wrap;
      gap: ${button_gap}px;
      justify-content: ${effectiveButtonAlignment === 'center' ? 'center' : effectiveButtonAlignment === 'right' ? 'flex-end' : 'flex-start'};
    }
    
    /* Uniform button width - desktop */
    .buttonblock-${instanceId} .bb-button-wrapper {
      ${uniform_button_width ? 'flex: 1 1 0;' : 'flex: none;'}
    }
    
    /* Mobile preview styles (for editor preview mode) - using data attribute */
    .buttonblock-${instanceId}[data-viewport="mobile"] .bb-container {
      padding-top: ${mobilePaddingTop}px;
      padding-bottom: ${mobilePaddingBottom}px;
      padding-left: ${mobilePaddingLeft}px;
      padding-right: ${mobilePaddingRight}px;
    }
    
    .buttonblock-${instanceId}[data-viewport="mobile"] .bb-text-wrapper {
      align-items: ${mobileTextAlign === 'center' ? 'center' : mobileTextAlign === 'right' ? 'flex-end' : 'flex-start'};
    }
    
    .buttonblock-${instanceId}[data-viewport="mobile"] .bb-heading {
      font-size: ${mobileHeadingFontSize}px;
      line-height: ${mobileHeadingLineHeight};
      letter-spacing: ${mobileHeadingLetterSpacing}px;
      text-align: ${mobileTextAlign};
      ${effectiveMobileTextColor ? `color: ${effectiveMobileTextColor};` : ''}
    }
    
    .buttonblock-${instanceId}[data-viewport="mobile"] .bb-subheading {
      font-size: ${mobileSubheadingFontSize}px;
      line-height: ${mobileSubheadingLineHeight};
      text-align: ${mobileTextAlign};
      ${effectiveMobileTextColor ? `color: ${effectiveMobileTextColor};` : ''}
    }
    
    .buttonblock-${instanceId}[data-viewport="mobile"] .bb-content {
      font-size: ${mobileContentFontSize}px;
      line-height: ${mobileContentLineHeight};
      text-align: ${mobileTextAlign};
      ${effectiveMobileTextColor ? `color: ${effectiveMobileTextColor};` : ''}
    }
    
    .buttonblock-${instanceId}[data-viewport="mobile"] .bb-buttons {
      justify-content: ${effectiveMobileButtonAlignment === 'center' ? 'center' : effectiveMobileButtonAlignment === 'right' ? 'flex-end' : 'flex-start'};
      gap: ${effectiveMobileButtonGap}px;
    }
    
    .buttonblock-${instanceId}[data-viewport="mobile"] .bb-button-wrapper {
      ${effectiveMobileUniformWidth ? 'flex: 1 1 0;' : 'flex: none;'}
    }
    
    /* Mobile styles via media query (for actual mobile devices) */
    @media (max-width: 767px) {
      .buttonblock-${instanceId} .bb-container {
        padding-top: ${mobilePaddingTop}px;
        padding-bottom: ${mobilePaddingBottom}px;
        padding-left: ${mobilePaddingLeft}px;
        padding-right: ${mobilePaddingRight}px;
      }
      
      .buttonblock-${instanceId} .bb-text-wrapper {
        align-items: ${mobileTextAlign === 'center' ? 'center' : mobileTextAlign === 'right' ? 'flex-end' : 'flex-start'};
      }
      
      .buttonblock-${instanceId} .bb-heading {
        font-size: ${mobileHeadingFontSize}px;
        line-height: ${mobileHeadingLineHeight};
        letter-spacing: ${mobileHeadingLetterSpacing}px;
        text-align: ${mobileTextAlign};
        ${effectiveMobileTextColor ? `color: ${effectiveMobileTextColor};` : ''}
      }
      
      .buttonblock-${instanceId} .bb-subheading {
        font-size: ${mobileSubheadingFontSize}px;
        line-height: ${mobileSubheadingLineHeight};
        text-align: ${mobileTextAlign};
        ${effectiveMobileTextColor ? `color: ${effectiveMobileTextColor};` : ''}
      }
      
      .buttonblock-${instanceId} .bb-content {
        font-size: ${mobileContentFontSize}px;
        line-height: ${mobileContentLineHeight};
        text-align: ${mobileTextAlign};
        ${effectiveMobileTextColor ? `color: ${effectiveMobileTextColor};` : ''}
      }
      
      .buttonblock-${instanceId} .bb-buttons {
        justify-content: ${effectiveMobileButtonAlignment === 'center' ? 'center' : effectiveMobileButtonAlignment === 'right' ? 'flex-end' : 'flex-start'};
        gap: ${effectiveMobileButtonGap}px;
      }
      
      .buttonblock-${instanceId} .bb-button-wrapper {
        ${effectiveMobileUniformWidth ? 'flex: 1 1 0;' : 'flex: none;'}
      }
    }
  `;

  // NOTE: All responsive styles (font-size, line-height, padding, text-align, gap, justify-content)
  // are handled via CSS only to ensure @media queries work on real mobile devices.
  // Inline styles should only contain non-responsive properties.

  const renderContent = () => (
    <>
      {hasTextContent && (
        <div className="bb-text-wrapper flex flex-col mb-8">
          {heading_text && (
            <div 
              className="bb-heading prose max-w-none mb-4"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(heading_text) }}
            />
          )}
          {subheading_text && (
            <div 
              className="bb-subheading prose max-w-none mb-4"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(subheading_text) }}
            />
          )}
          {body_content && (
            <div 
              className="bb-content prose max-w-none"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(body_content) }}
            />
          )}
        </div>
      )}
      <div className="bb-buttons">
        {validButtons.map((button, index) => (
          <div key={index} className="bb-button-wrapper">
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
              className="w-full"
            />
          </div>
        ))}
      </div>
    </>
  );

  return (
    <div 
      id={anchor || undefined}
      className={`buttonblock-${instanceId} ${fullWidthClass}`}
      data-viewport={isMobilePreview ? 'mobile' : 'desktop'}
    >
      <style>{responsiveStyles}</style>
      <div className="bb-container">
        {fullWidth ? (
          <div className="max-w-7xl mx-auto px-4">
            {renderContent()}
          </div>
        ) : (
          <div className="max-w-7xl mx-auto">
            {renderContent()}
          </div>
        )}
      </div>
    </div>
  );
}

const buttonBlockQuillModules = {
  toolbar: [
    [{ 'header': [1, 2, 3, false] }],
    ['bold', 'italic', 'underline', 'strike'],
    [{ 'color': [] }, { 'background': [] }],
    [{ 'align': [] }],
    ['link'],
    ['clean']
  ]
};

export function IEditButtonBlockElementEditor({ element, onChange }) {
  const [activeTab, setActiveTab] = useState('desktop');
  const [expandedSections, setExpandedSections] = useState({
    textContent: true,
    background: false,
    buttons: false
  });

  const toggleSection = (section) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const content = element.content || {};

  const updateContent = (key, value) => {
    onChange({ ...element, content: { ...(element.content || {}), [key]: value } });
  };

  const updateMultipleContent = (updates) => {
    onChange({ ...element, content: { ...(element.content || {}), ...updates } });
  };

  const updateButton = (index, key, value) => {
    const currentContent = element.content || {};
    const newButtons = [...(currentContent.buttons || [])];
    newButtons[index] = { ...newButtons[index], [key]: value };
    onChange({ ...element, content: { ...currentContent, buttons: newButtons } });
  };

  const addButton = () => {
    const currentContent = element.content || {};
    if ((currentContent.buttons || []).length < 8) {
      onChange({ 
        ...element, 
        content: { 
          ...currentContent, 
          buttons: [
            ...(currentContent.buttons || []),
            { text: '', link: '', button_style_id: '', open_in_new_tab: false, size: 'medium', show_arrow: false, custom_bg_color: '#000000', custom_text_color: '#ffffff', custom_border_color: '' }
          ]
        }
      });
    }
  };

  const removeButton = (index) => {
    const currentContent = element.content || {};
    const newButtons = [...(currentContent.buttons || [])];
    newButtons.splice(index, 1);
    onChange({ ...element, content: { ...currentContent, buttons: newButtons } });
  };

  // Fetch button styles
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

  // Compute default mobile values for placeholders
  const defaultMobileHeadingSize = Math.max(24, Math.round((content.heading_font_size || 32) * 0.7));
  const defaultMobileSubheadingSize = Math.max(16, Math.round((content.subheading_font_size || 20) * 0.85));
  const defaultMobileContentSize = Math.max(14, Math.round((content.content_font_size || 16) * 0.9));
  const defaultMobilePaddingTop = Math.max(32, Math.round((content.padding_top || 48) * 0.6));
  const defaultMobilePaddingBottom = Math.max(32, Math.round((content.padding_bottom || 48) * 0.6));
  const defaultMobilePaddingLeft = Math.max(16, Math.round((content.padding_left || 16) * 0.8));
  const defaultMobilePaddingRight = Math.max(16, Math.round((content.padding_right || 16) * 0.8));

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

  const renderDesktopTypographyControls = (prefix, label, defaults) => (
    <div className="space-y-3 mt-3 p-3 bg-slate-50 rounded-md">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs">Font Family</Label>
          <select
            value={content[`${prefix}_font_family`] || defaults.fontFamily}
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
            value={content[`${prefix}_font_weight`] || defaults.fontWeight}
            onChange={(e) => updateContent(`${prefix}_font_weight`, parseInt(e.target.value))}
            className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-xs"
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
            value={content[`${prefix}_font_size`] || defaults.fontSize}
            onChange={(e) => updateContent(`${prefix}_font_size`, parseInt(e.target.value) || defaults.fontSize)}
            min="8"
            max="120"
            className="text-xs h-8"
          />
        </div>
        <div>
          <Label className="text-xs">Line Height</Label>
          <Input
            type="number"
            step="0.1"
            value={content[`${prefix}_line_height`] || defaults.lineHeight}
            onChange={(e) => updateContent(`${prefix}_line_height`, parseFloat(e.target.value) || defaults.lineHeight)}
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
            value={content[`${prefix}_color`] || defaults.color}
            onChange={(e) => updateContent(`${prefix}_color`, e.target.value)}
            className="w-10 h-8 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
          />
          <Input
            value={content[`${prefix}_color`] || defaults.color}
            onChange={(e) => updateContent(`${prefix}_color`, e.target.value)}
            className="flex-1 font-mono text-xs h-8"
            placeholder={defaults.color}
          />
        </div>
      </div>
    </div>
  );

  const renderMobileTypographySection = () => (
    <div className="space-y-4">
      <div className="flex items-center justify-between p-3 bg-blue-50 rounded-lg">
        <div>
          <Label className="text-sm font-medium">Use Desktop Values</Label>
          <p className="text-xs text-slate-500">When enabled, mobile uses auto-scaled desktop typography</p>
        </div>
        <Switch
          checked={!content.mobile_custom_typography}
          onCheckedChange={(checked) => updateContent('mobile_custom_typography', !checked)}
        />
      </div>

      {content.mobile_custom_typography && (
        <div className="space-y-4 p-3 border rounded-lg">
          <div>
            <Label className="text-sm font-medium">Text Alignment</Label>
            <select
              value={content.mobile_text_align || content.text_align || 'center'}
              onChange={(e) => updateContent('mobile_text_align', e.target.value)}
              className="w-full mt-1 px-3 py-2 border border-slate-300 rounded-md text-sm"
            >
              <option value="left">Left</option>
              <option value="center">Center</option>
              <option value="right">Right</option>
            </select>
          </div>

          <div>
            <Label className="text-sm font-medium">Text Color Override</Label>
            <div className="flex gap-2 items-center mt-1">
              <input
                type="color"
                value={content.mobile_text_color || content.heading_color || '#1e293b'}
                onChange={(e) => updateContent('mobile_text_color', e.target.value)}
                className="w-10 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
              />
              <Input
                value={content.mobile_text_color || ''}
                onChange={(e) => updateContent('mobile_text_color', e.target.value)}
                className="flex-1 font-mono text-sm"
                placeholder="Use desktop colors"
              />
            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm font-medium">Heading Typography</Label>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label className="text-xs">Font Size (px)</Label>
                <Input
                  type="number"
                  value={content.mobile_heading_font_size || ''}
                  onChange={(e) => updateContent('mobile_heading_font_size', e.target.value ? parseInt(e.target.value) : null)}
                  placeholder={String(defaultMobileHeadingSize)}
                  min="12"
                  max="80"
                  className="text-xs h-8"
                />
              </div>
              <div>
                <Label className="text-xs">Line Height</Label>
                <Input
                  type="number"
                  step="0.1"
                  value={content.mobile_heading_line_height || ''}
                  onChange={(e) => updateContent('mobile_heading_line_height', e.target.value ? parseFloat(e.target.value) : null)}
                  placeholder={String(content.heading_line_height || 1.2)}
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
                  value={content.mobile_heading_letter_spacing ?? ''}
                  onChange={(e) => updateContent('mobile_heading_letter_spacing', e.target.value ? parseFloat(e.target.value) : null)}
                  placeholder={String(content.heading_letter_spacing || 0)}
                  min="-5"
                  max="20"
                  className="text-xs h-8"
                />
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm font-medium">Subheading Typography</Label>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Font Size (px)</Label>
                <Input
                  type="number"
                  value={content.mobile_subheading_font_size || ''}
                  onChange={(e) => updateContent('mobile_subheading_font_size', e.target.value ? parseInt(e.target.value) : null)}
                  placeholder={String(defaultMobileSubheadingSize)}
                  min="12"
                  max="60"
                  className="text-xs h-8"
                />
              </div>
              <div>
                <Label className="text-xs">Line Height</Label>
                <Input
                  type="number"
                  step="0.1"
                  value={content.mobile_subheading_line_height || ''}
                  onChange={(e) => updateContent('mobile_subheading_line_height', e.target.value ? parseFloat(e.target.value) : null)}
                  placeholder={String(content.subheading_line_height || 1.5)}
                  min="0.8"
                  max="3"
                  className="text-xs h-8"
                />
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm font-medium">Content Typography</Label>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Font Size (px)</Label>
                <Input
                  type="number"
                  value={content.mobile_content_font_size || ''}
                  onChange={(e) => updateContent('mobile_content_font_size', e.target.value ? parseInt(e.target.value) : null)}
                  placeholder={String(defaultMobileContentSize)}
                  min="12"
                  max="40"
                  className="text-xs h-8"
                />
              </div>
              <div>
                <Label className="text-xs">Line Height</Label>
                <Input
                  type="number"
                  step="0.1"
                  value={content.mobile_content_line_height || ''}
                  onChange={(e) => updateContent('mobile_content_line_height', e.target.value ? parseFloat(e.target.value) : null)}
                  placeholder={String(content.content_line_height || 1.6)}
                  min="0.8"
                  max="3"
                  className="text-xs h-8"
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  const renderMobilePaddingSection = () => (
    <div className="space-y-4">
      <div className="flex items-center justify-between p-3 bg-blue-50 rounded-lg">
        <div>
          <Label className="text-sm font-medium">Use Desktop Values</Label>
          <p className="text-xs text-slate-500">When enabled, mobile uses auto-scaled desktop padding</p>
        </div>
        <Switch
          checked={!content.mobile_custom_padding}
          onCheckedChange={(checked) => updateContent('mobile_custom_padding', !checked)}
        />
      </div>

      {content.mobile_custom_padding && (
        <div className="p-3 border rounded-lg space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Padding Top (px)</Label>
              <Input
                type="number"
                value={content.mobile_padding_top ?? ''}
                onChange={(e) => updateContent('mobile_padding_top', e.target.value ? parseInt(e.target.value) : null)}
                placeholder={String(defaultMobilePaddingTop)}
                min="0"
                max="200"
                className="text-xs h-8"
              />
            </div>
            <div>
              <Label className="text-xs">Padding Bottom (px)</Label>
              <Input
                type="number"
                value={content.mobile_padding_bottom ?? ''}
                onChange={(e) => updateContent('mobile_padding_bottom', e.target.value ? parseInt(e.target.value) : null)}
                placeholder={String(defaultMobilePaddingBottom)}
                min="0"
                max="200"
                className="text-xs h-8"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Padding Left (px)</Label>
              <Input
                type="number"
                value={content.mobile_padding_left ?? ''}
                onChange={(e) => updateContent('mobile_padding_left', e.target.value ? parseInt(e.target.value) : null)}
                placeholder={String(defaultMobilePaddingLeft)}
                min="0"
                max="100"
                className="text-xs h-8"
              />
            </div>
            <div>
              <Label className="text-xs">Padding Right (px)</Label>
              <Input
                type="number"
                value={content.mobile_padding_right ?? ''}
                onChange={(e) => updateContent('mobile_padding_right', e.target.value ? parseInt(e.target.value) : null)}
                placeholder={String(defaultMobilePaddingRight)}
                min="0"
                max="100"
                className="text-xs h-8"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );

  const renderButtonsSection = () => (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        {(content.buttons || []).length < 8 && (
          <button
            onClick={addButton}
            className="px-3 py-1 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700"
            data-testid="button-add-button"
          >
            + Add Button
          </button>
        )}
      </div>

      {(content.buttons || []).map((button, index) => (
        <div key={index} className="p-4 border border-slate-200 rounded-lg space-y-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium">Button {index + 1}</span>
            <button
              onClick={() => removeButton(index)}
              className="text-red-600 hover:text-red-700 text-sm"
              data-testid={`button-remove-${index}`}
            >
              Remove
            </button>
          </div>

          <div>
            <Label className="text-sm">Button Text *</Label>
            <Input
              type="text"
              value={button.text || ''}
              onChange={(e) => updateButton(index, 'text', e.target.value)}
              placeholder="e.g., Learn More"
              className="mt-1"
              data-testid={`input-button-text-${index}`}
            />
          </div>

          <div>
            <Label className="text-sm">Link URL *</Label>
            <Input
              type="text"
              value={button.link || ''}
              onChange={(e) => updateButton(index, 'link', e.target.value)}
              placeholder="https://..."
              className="mt-1"
              data-testid={`input-button-link-${index}`}
            />
          </div>

          <div>
            <Label className="text-sm">Button Style</Label>
            <select
              value={button.button_style_id || ''}
              onChange={(e) => updateButton(index, 'button_style_id', e.target.value)}
              className="w-full mt-1 px-3 py-2 border border-slate-300 rounded-md text-sm"
              data-testid={`select-button-style-${index}`}
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
                value={button.custom_bg_color || '#000000'}
                onChange={(e) => updateButton(index, 'custom_bg_color', e.target.value)}
                className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
              />
            </div>
            <div>
              <Label className="text-xs">Text</Label>
              <input
                type="color"
                value={button.custom_text_color || '#ffffff'}
                onChange={(e) => updateButton(index, 'custom_text_color', e.target.value)}
                className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
              />
            </div>
            <div>
              <Label className="text-xs">Border (opt.)</Label>
              <input
                type="color"
                value={button.custom_border_color || ''}
                onChange={(e) => updateButton(index, 'custom_border_color', e.target.value)}
                className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
              />
            </div>
          </div>

          <div>
            <Label className="text-sm">Button Size</Label>
            <select
              value={button.size || 'medium'}
              onChange={(e) => updateButton(index, 'size', e.target.value)}
              className="w-full mt-1 px-3 py-2 border border-slate-300 rounded-md text-sm"
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
              id={`arrow-${index}`}
              checked={button.show_arrow || false}
              onChange={(e) => updateButton(index, 'show_arrow', e.target.checked)}
              className="w-4 h-4"
            />
            <label htmlFor={`arrow-${index}`} className="text-sm cursor-pointer">
              Show arrow icon
            </label>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id={`new-tab-${index}`}
              checked={button.open_in_new_tab || false}
              onChange={(e) => updateButton(index, 'open_in_new_tab', e.target.checked)}
              className="w-4 h-4"
            />
            <label htmlFor={`new-tab-${index}`} className="text-sm cursor-pointer">
              Open in new tab
            </label>
          </div>
        </div>
      ))}

      {(content.buttons || []).length === 0 && (
        <div className="text-center py-8 text-slate-500 text-sm">
          No buttons added yet. Click "Add Button" to get started.
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-3">
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
          placeholder="e.g., cta-section"
          className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
          data-testid="input-buttonblock-anchor"
        />
        <p className="text-xs text-slate-500 mt-1">
          Used for linking directly to this section (e.g., /page#anchor-id)
        </p>
      </div>

      {/* Desktop/Mobile Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="desktop" className="flex items-center gap-2">
            <Monitor className="h-4 w-4" />
            Desktop
          </TabsTrigger>
          <TabsTrigger value="mobile" className="flex items-center gap-2">
            <Smartphone className="h-4 w-4" />
            Mobile
          </TabsTrigger>
        </TabsList>

        {/* Desktop Tab Content */}
        <TabsContent value="desktop" className="space-y-3 mt-3">
          {/* Text Content Accordion */}
          <div className="border rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => toggleSection('textContent')}
              className="w-full flex items-center justify-between p-3 bg-slate-50 hover:bg-slate-100 transition-colors"
              data-testid="accordion-button-block-text-content"
            >
              <span className="font-medium text-sm">Text Content</span>
              {expandedSections.textContent ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
            
            {expandedSections.textContent && (
              <div className="p-4 space-y-6 border-t">
                {/* Text Alignment */}
                <div>
                  <Label className="text-sm font-medium">Text Alignment</Label>
                  <select
                    value={content.text_align || 'center'}
                    onChange={(e) => updateContent('text_align', e.target.value)}
                    className="w-full mt-1 px-3 py-2 border border-slate-300 rounded-md text-sm"
                  >
                    <option value="left">Left</option>
                    <option value="center">Center</option>
                    <option value="right">Right</option>
                  </select>
                </div>

                {/* Heading */}
                <div className="space-y-2">
                  <Label className="text-sm font-medium">Heading</Label>
                  <TypographyStyleSelector
                    value={content.heading_typography_style_id}
                    onChange={(styleId, style) => {
                      if (style) {
                        const styleProps = applyTypographyStyle(style);
                        updateMultipleContent({
                          heading_typography_style_id: styleId,
                          heading_font_family: styleProps.font_family || content.heading_font_family,
                          heading_font_size: styleProps.font_size || content.heading_font_size,
                          heading_font_weight: styleProps.font_weight || content.heading_font_weight,
                          heading_line_height: styleProps.line_height || content.heading_line_height,
                          heading_letter_spacing: styleProps.letter_spacing || content.heading_letter_spacing,
                          heading_color: styleProps.color || content.heading_color
                        });
                      } else {
                        updateContent('heading_typography_style_id', styleId);
                      }
                    }}
                    label="Typography Style"
                  />
                  <ReactQuill
                    theme="snow"
                    value={content.heading_text || ''}
                    onChange={(value) => updateContent('heading_text', value)}
                    modules={buttonBlockQuillModules}
                    placeholder="Enter heading text..."
                    className="bg-white"
                  />
                  <details className="text-xs">
                    <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
                    {renderDesktopTypographyControls('heading', 'Heading', { fontFamily: 'Poppins', fontWeight: 700, fontSize: 32, lineHeight: 1.2, color: '#1e293b' })}
                  </details>
                </div>

                {/* Subheading */}
                <div className="space-y-2">
                  <Label className="text-sm font-medium">Subheading</Label>
                  <TypographyStyleSelector
                    value={content.subheading_typography_style_id}
                    onChange={(styleId, style) => {
                      if (style) {
                        const styleProps = applyTypographyStyle(style);
                        updateMultipleContent({
                          subheading_typography_style_id: styleId,
                          subheading_font_family: styleProps.font_family || content.subheading_font_family,
                          subheading_font_size: styleProps.font_size || content.subheading_font_size,
                          subheading_font_weight: styleProps.font_weight || content.subheading_font_weight,
                          subheading_line_height: styleProps.line_height || content.subheading_line_height,
                          subheading_letter_spacing: styleProps.letter_spacing || content.subheading_letter_spacing,
                          subheading_color: styleProps.color || content.subheading_color
                        });
                      } else {
                        updateContent('subheading_typography_style_id', styleId);
                      }
                    }}
                    label="Typography Style"
                  />
                  <ReactQuill
                    theme="snow"
                    value={content.subheading_text || ''}
                    onChange={(value) => updateContent('subheading_text', value)}
                    modules={buttonBlockQuillModules}
                    placeholder="Enter subheading text..."
                    className="bg-white"
                  />
                  <details className="text-xs">
                    <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
                    {renderDesktopTypographyControls('subheading', 'Subheading', { fontFamily: 'Poppins', fontWeight: 400, fontSize: 20, lineHeight: 1.5, color: '#475569' })}
                  </details>
                </div>

                {/* Body Content */}
                <div className="space-y-2">
                  <Label className="text-sm font-medium">Body Content</Label>
                  <TypographyStyleSelector
                    value={content.content_typography_style_id}
                    onChange={(styleId, style) => {
                      if (style) {
                        const styleProps = applyTypographyStyle(style);
                        updateMultipleContent({
                          content_typography_style_id: styleId,
                          content_font_family: styleProps.font_family || content.content_font_family,
                          content_font_size: styleProps.font_size || content.content_font_size,
                          content_font_weight: styleProps.font_weight || content.content_font_weight,
                          content_line_height: styleProps.line_height || content.content_line_height,
                          content_letter_spacing: styleProps.letter_spacing || content.content_letter_spacing,
                          content_color: styleProps.color || content.content_color
                        });
                      } else {
                        updateContent('content_typography_style_id', styleId);
                      }
                    }}
                    label="Typography Style"
                  />
                  <ReactQuill
                    theme="snow"
                    value={content.body_content || ''}
                    onChange={(value) => updateContent('body_content', value)}
                    modules={buttonBlockQuillModules}
                    placeholder="Enter body content..."
                    className="bg-white"
                  />
                  <details className="text-xs">
                    <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
                    {renderDesktopTypographyControls('content', 'Content', { fontFamily: 'Poppins', fontWeight: 400, fontSize: 16, lineHeight: 1.6, color: '#64748b' })}
                  </details>
                </div>
              </div>
            )}
          </div>

          {/* Background & Padding Accordion */}
          <div className="border rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => toggleSection('background')}
              className="w-full flex items-center justify-between p-3 bg-slate-50 hover:bg-slate-100 transition-colors"
              data-testid="accordion-button-block-background"
            >
              <span className="font-medium text-sm">Background & Padding</span>
              {expandedSections.background ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
            
            {expandedSections.background && (
              <div className="p-4 space-y-4 border-t">
                <div>
                  <Label className="text-sm font-medium">Background Color</Label>
                  <div className="flex gap-2 items-center mt-1">
                    <input
                      type="color"
                      value={content.background_color || '#ffffff'}
                      onChange={(e) => updateContent('background_color', e.target.value)}
                      className="w-10 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                    />
                    <Input
                      value={content.background_color || '#ffffff'}
                      onChange={(e) => updateContent('background_color', e.target.value)}
                      className="flex-1 font-mono text-sm"
                      placeholder="#ffffff"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">Padding Top (px)</Label>
                    <Input
                      type="number"
                      value={content.padding_top ?? 48}
                      onChange={(e) => updateContent('padding_top', parseInt(e.target.value) || 0)}
                      min="0"
                      max="200"
                      className="text-xs h-8"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Padding Bottom (px)</Label>
                    <Input
                      type="number"
                      value={content.padding_bottom ?? 48}
                      onChange={(e) => updateContent('padding_bottom', parseInt(e.target.value) || 0)}
                      min="0"
                      max="200"
                      className="text-xs h-8"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">Padding Left (px)</Label>
                    <Input
                      type="number"
                      value={content.padding_left ?? 16}
                      onChange={(e) => updateContent('padding_left', parseInt(e.target.value) || 0)}
                      min="0"
                      max="100"
                      className="text-xs h-8"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Padding Right (px)</Label>
                    <Input
                      type="number"
                      value={content.padding_right ?? 16}
                      onChange={(e) => updateContent('padding_right', parseInt(e.target.value) || 0)}
                      min="0"
                      max="100"
                      className="text-xs h-8"
                    />
                  </div>
                </div>

                <div>
                  <Label className="text-sm font-medium">Button Gap (px)</Label>
                  <Input
                    type="number"
                    value={content.button_gap || 16}
                    onChange={(e) => updateContent('button_gap', e.target.value)}
                    className="w-full mt-1"
                    min="0"
                    max="100"
                  />
                </div>

                {/* Button Alignment */}
                <div>
                  <Label className="text-sm font-medium">Button Alignment</Label>
                  <div className="flex gap-2 mt-1">
                    {['left', 'center', 'right'].map((align) => (
                      <button
                        key={align}
                        type="button"
                        onClick={() => updateContent('button_alignment', align)}
                        className={`flex-1 px-3 py-2 text-sm capitalize rounded-md border transition-colors ${
                          (content.button_alignment || content.text_align || 'center') === align
                            ? 'bg-blue-600 text-white border-blue-600'
                            : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                        }`}
                      >
                        {align}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-slate-500 mt-1">How buttons are aligned within each row</p>
                </div>

                {/* Uniform Button Width Toggle */}
                <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                  <div>
                    <Label className="text-sm font-medium">Uniform Button Width</Label>
                    <p className="text-xs text-slate-500">Make all buttons the same width as the largest button</p>
                  </div>
                  <Switch
                    checked={content.uniform_button_width || false}
                    onCheckedChange={(checked) => updateContent('uniform_button_width', checked)}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Buttons Accordion */}
          <div className="border rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => toggleSection('buttons')}
              className="w-full flex items-center justify-between p-3 bg-slate-50 hover:bg-slate-100 transition-colors"
              data-testid="accordion-button-block-buttons"
            >
              <span className="font-medium text-sm">Buttons ({(content.buttons || []).length}/8)</span>
              {expandedSections.buttons ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
            
            {expandedSections.buttons && (
              <div className="p-4 border-t">
                {renderButtonsSection()}
              </div>
            )}
          </div>
        </TabsContent>

        {/* Mobile Tab Content */}
        <TabsContent value="mobile" className="space-y-3 mt-3">
          {/* Mobile Typography Section */}
          <div className="border rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => toggleSection('textContent')}
              className="w-full flex items-center justify-between p-3 bg-slate-50 hover:bg-slate-100 transition-colors"
            >
              <span className="font-medium text-sm">Typography</span>
              {expandedSections.textContent ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
            
            {expandedSections.textContent && (
              <div className="p-4 border-t">
                {renderMobileTypographySection()}
              </div>
            )}
          </div>

          {/* Mobile Padding Section */}
          <div className="border rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => toggleSection('background')}
              className="w-full flex items-center justify-between p-3 bg-slate-50 hover:bg-slate-100 transition-colors"
            >
              <span className="font-medium text-sm">Padding & Layout</span>
              {expandedSections.background ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
            
            {expandedSections.background && (
              <div className="p-4 border-t space-y-4">
                {renderMobilePaddingSection()}
                
                {/* Mobile Button Gap */}
                <div>
                  <Label className="text-sm font-medium">Button Gap (px)</Label>
                  <Input
                    type="number"
                    value={content.mobile_button_gap !== undefined ? content.mobile_button_gap : (content.button_gap || 16)}
                    onChange={(e) => updateContent('mobile_button_gap', parseInt(e.target.value) || 0)}
                    className="w-full mt-1"
                    min="0"
                    max="100"
                  />
                  <p className="text-xs text-slate-500 mt-1">Vertical and horizontal spacing between buttons on mobile</p>
                </div>

                {/* Mobile Button Alignment */}
                <div>
                  <Label className="text-sm font-medium">Button Alignment</Label>
                  <div className="flex gap-2 mt-1">
                    {['left', 'center', 'right'].map((align) => (
                      <button
                        key={align}
                        type="button"
                        onClick={() => updateContent('mobile_button_alignment', align)}
                        className={`flex-1 px-3 py-2 text-sm capitalize rounded-md border transition-colors ${
                          (content.mobile_button_alignment !== undefined ? content.mobile_button_alignment : (content.mobile_text_align || content.button_alignment || content.text_align || 'center')) === align
                            ? 'bg-blue-600 text-white border-blue-600'
                            : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                        }`}
                      >
                        {align}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-slate-500 mt-1">How buttons are aligned on mobile</p>
                </div>
                
                {/* Mobile Uniform Button Width Toggle */}
                <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                  <div>
                    <Label className="text-sm font-medium">Uniform Button Width</Label>
                    <p className="text-xs text-slate-500">Make all buttons the same width on mobile</p>
                  </div>
                  <Switch
                    checked={content.mobile_uniform_button_width !== undefined ? content.mobile_uniform_button_width : (content.uniform_button_width || false)}
                    onCheckedChange={(checked) => updateContent('mobile_uniform_button_width', checked)}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Buttons section same as desktop */}
          <div className="border rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => toggleSection('buttons')}
              className="w-full flex items-center justify-between p-3 bg-slate-50 hover:bg-slate-100 transition-colors"
            >
              <span className="font-medium text-sm">Buttons ({(content.buttons || []).length}/8)</span>
              {expandedSections.buttons ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
            
            {expandedSections.buttons && (
              <div className="p-4 border-t">
                {renderButtonsSection()}
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
