import { useState, useId } from "react";
import ReactQuill from "react-quill";
import "react-quill/dist/quill.snow.css";
import DOMPurify from "dompurify";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import TypographyStyleSelector, { applyTypographyStyle } from "../TypographyStyleSelector";
import { AlignLeft, AlignCenter, AlignRight, ChevronDown, ChevronUp } from "lucide-react";

export default function IEditTextBlockElement({ content, variant, settings }) {
  const {
    heading = '',
    text = '',
    heading_font_family = 'Poppins',
    heading_font_size = 30,
    heading_font_weight = 700,
    heading_color = '#1e293b',
    heading_letter_spacing = 0,
    heading_line_height = 1.3,
    heading_align = 'left',
    heading_margin_bottom = 24,
    content_font_family = 'Poppins',
    content_font_size = 16,
    content_font_weight = 400,
    content_color = '#475569',
    content_letter_spacing = 0,
    content_line_height = 1.6,
    content_align = 'left',
    background_type = 'none',
    background_color = '#ffffff',
    gradient_start_color = '#3b82f6',
    gradient_end_color = '#8b5cf6',
    gradient_angle = 135,
    padding_top = 0,
    padding_bottom = 0,
    padding_left = 0,
    padding_right = 0,
    border_radius = 0,
    mobile_heading_font_size,
    mobile_content_font_size,
    mobile_heading_align,
    mobile_content_align,
    mobile_padding_top,
    mobile_padding_bottom,
    mobile_padding_left,
    mobile_padding_right
  } = content || {};

  const reactId = useId();
  const instanceId = `textblock-${reactId.replace(/:/g, '')}`;
  const fullWidth = settings?.fullWidth;

  const mobileHeadingFontSize = mobile_heading_font_size || Math.max(22, Math.round(heading_font_size * 0.75));
  const mobileContentFontSize = mobile_content_font_size || Math.max(14, Math.round(content_font_size * 0.9));
  const mobilePaddingTop = mobile_padding_top !== undefined ? mobile_padding_top : padding_top;
  const mobilePaddingBottom = mobile_padding_bottom !== undefined ? mobile_padding_bottom : padding_bottom;
  const mobilePaddingLeft = mobile_padding_left !== undefined ? mobile_padding_left : padding_left;
  const mobilePaddingRight = mobile_padding_right !== undefined ? mobile_padding_right : padding_right;

  const getBackgroundStyle = () => {
    if (background_type === 'color') {
      return `background-color: ${background_color};`;
    }
    if (background_type === 'gradient') {
      return `background: linear-gradient(${gradient_angle}deg, ${gradient_start_color}, ${gradient_end_color});`;
    }
    return '';
  };

  const scopedStyles = `
    .${instanceId} .textblock-background {
      ${getBackgroundStyle()}
      ${border_radius ? `border-radius: ${border_radius}px;` : ''}
    }

    .${instanceId} .textblock-inner {
      padding-top: ${padding_top}px;
      padding-bottom: ${padding_bottom}px;
      padding-left: ${padding_left}px;
      padding-right: ${padding_right}px;
    }

    .${instanceId} .textblock-heading {
      font-family: ${heading_font_family};
      font-size: ${heading_font_size}px;
      font-weight: ${heading_font_weight};
      color: ${heading_color};
      letter-spacing: ${heading_letter_spacing}px;
      line-height: ${heading_line_height};
      text-align: ${heading_align};
      margin: 0;
      margin-bottom: ${text ? `${heading_margin_bottom}px` : '0'};
    }

    .${instanceId} .textblock-content {
      font-family: ${content_font_family};
      font-size: ${content_font_size}px;
      font-weight: ${content_font_weight};
      color: ${content_color};
      letter-spacing: ${content_letter_spacing}px;
      line-height: ${content_line_height};
      text-align: ${content_align};
    }

    .${instanceId} .textblock-content p,
    .${instanceId} .textblock-content li,
    .${instanceId} .textblock-content span {
      color: inherit !important;
      font-size: inherit !important;
      line-height: inherit !important;
    }

    .${instanceId} .textblock-content h1,
    .${instanceId} .textblock-content h2,
    .${instanceId} .textblock-content h3 {
      color: inherit !important;
    }

    @media (max-width: 767px) {
      .${instanceId} .textblock-inner {
        padding-top: ${mobilePaddingTop}px;
        padding-bottom: ${mobilePaddingBottom}px;
        padding-left: ${mobilePaddingLeft}px;
        padding-right: ${mobilePaddingRight}px;
      }

      .${instanceId} .textblock-heading {
        font-size: ${mobileHeadingFontSize}px;
        text-align: ${mobile_heading_align || heading_align};
      }

      .${instanceId} .textblock-content {
        font-size: ${mobileContentFontSize}px;
        text-align: ${mobile_content_align || content_align};
      }
    }
  `;

  const fullWidthClass = fullWidth ? 'w-screen relative left-1/2 right-1/2 -ml-[50vw] -mr-[50vw]' : '';

  return (
    <div className={`${instanceId} ${fullWidthClass}`} data-testid="textblock-container">
      <style>{scopedStyles}</style>
      <div className="textblock-background">
        {fullWidth ? (
          <div className="max-w-7xl mx-auto px-4">
            <div className="textblock-inner">
              {heading && (
                <h2 
                  className="textblock-heading" 
                  data-testid="textblock-heading"
                  dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(heading) }}
                />
              )}
              {text && (
                <div 
                  className="prose max-w-none textblock-content"
                  data-testid="textblock-content"
                  dangerouslySetInnerHTML={{ __html: text }}
                />
              )}
            </div>
          </div>
        ) : (
          <div className="textblock-inner">
            {heading && (
              <h2 
                className="textblock-heading" 
                data-testid="textblock-heading"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(heading) }}
              />
            )}
            {text && (
              <div 
                className="prose max-w-none textblock-content"
                data-testid="textblock-content"
                dangerouslySetInnerHTML={{ __html: text }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

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

export function IEditTextBlockElementEditor({ element, onChange }) {
  const content = element.content || { heading: '', text: '' };
  const backgroundType = content.background_type || 'none';
  
  const [expandedSections, setExpandedSections] = useState({
    background: false,
    heading: true,
    content: false,
    mobile: false
  });

  const toggleSection = (section) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const updateContent = (key, value) => {
    onChange({ 
      ...element, 
      content: { ...content, [key]: value } 
    });
  };

  const updateMultipleContent = (updates) => {
    onChange({
      ...element,
      content: { ...content, ...updates }
    });
  };

  const quillModules = {
    toolbar: [
      [{ 'header': [1, 2, 3, false] }],
      ['bold', 'italic', 'underline', 'strike'],
      [{ 'color': [] }, { 'background': [] }],
      [{ 'list': 'ordered'}, { 'list': 'bullet' }],
      [{ 'align': [] }],
      ['link'],
      ['clean']
    ],
  };

  const quillFormats = [
    'header',
    'bold', 'italic', 'underline', 'strike',
    'color', 'background',
    'list', 'bullet',
    'align',
    'link'
  ];

  const gradientPreview = `linear-gradient(${content.gradient_angle || 135}deg, ${content.gradient_start_color || '#3b82f6'}, ${content.gradient_end_color || '#8b5cf6'})`;

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

  return (
    <div className="space-y-4">
      
      {/* Background & Layout Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('background')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
          data-testid="accordion-textblock-background"
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
                className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                data-testid="select-textblock-bg-type"
              >
                <option value="none">None (Transparent)</option>
                <option value="color">Solid Color</option>
                <option value="gradient">Gradient</option>
              </select>
            </div>

            {backgroundType === 'color' && (
              <div>
                <label className="block text-sm font-medium mb-1">Background Color</label>
                <div className="flex gap-2 items-center">
                  <input
                    type="color"
                    value={content.background_color || '#ffffff'}
                    onChange={(e) => updateContent('background_color', e.target.value)}
                    className="w-12 h-8 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                    data-testid="input-textblock-bg-color"
                  />
                  <input
                    type="text"
                    value={content.background_color || '#ffffff'}
                    onChange={(e) => updateContent('background_color', e.target.value)}
                    className="flex-1 px-2 py-1.5 border border-slate-300 rounded-md font-mono text-sm"
                    data-testid="input-textblock-bg-color-text"
                  />
                </div>
              </div>
            )}

            {backgroundType === 'gradient' && (
              <div className="space-y-3 p-3 bg-slate-50 rounded-md">
                <div 
                  className="w-full h-12 rounded-md border border-slate-300"
                  style={{ background: gradientPreview }}
                  data-testid="preview-textblock-gradient"
                />
                
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium mb-1">Start Color</label>
                    <div className="flex gap-1 items-center">
                      <input
                        type="color"
                        value={content.gradient_start_color || '#3b82f6'}
                        onChange={(e) => updateContent('gradient_start_color', e.target.value)}
                        className="w-10 h-8 border border-slate-300 rounded cursor-pointer"
                        data-testid="input-textblock-gradient-start"
                      />
                      <input
                        type="text"
                        value={content.gradient_start_color || '#3b82f6'}
                        onChange={(e) => updateContent('gradient_start_color', e.target.value)}
                        className="flex-1 px-2 py-1 border border-slate-300 rounded-md font-mono text-xs"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">End Color</label>
                    <div className="flex gap-1 items-center">
                      <input
                        type="color"
                        value={content.gradient_end_color || '#8b5cf6'}
                        onChange={(e) => updateContent('gradient_end_color', e.target.value)}
                        className="w-10 h-8 border border-slate-300 rounded cursor-pointer"
                        data-testid="input-textblock-gradient-end"
                      />
                      <input
                        type="text"
                        value={content.gradient_end_color || '#8b5cf6'}
                        onChange={(e) => updateContent('gradient_end_color', e.target.value)}
                        className="flex-1 px-2 py-1 border border-slate-300 rounded-md font-mono text-xs"
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
                    data-testid="input-textblock-gradient-angle"
                  />
                </div>
              </div>
            )}

            {backgroundType !== 'none' && (
              <>
                <div className="grid grid-cols-4 gap-2">
                  <div>
                    <label className="block text-sm font-medium mb-1">Pad Top</label>
                    <input
                      type="number"
                      value={content.padding_top || 0}
                      onChange={(e) => updateContent('padding_top', parseInt(e.target.value) || 0)}
                      className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                      min="0"
                      data-testid="input-textblock-padding-top"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">Pad Bottom</label>
                    <input
                      type="number"
                      value={content.padding_bottom || 0}
                      onChange={(e) => updateContent('padding_bottom', parseInt(e.target.value) || 0)}
                      className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                      min="0"
                      data-testid="input-textblock-padding-bottom"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">Pad Left</label>
                    <input
                      type="number"
                      value={content.padding_left || 0}
                      onChange={(e) => updateContent('padding_left', parseInt(e.target.value) || 0)}
                      className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                      min="0"
                      data-testid="input-textblock-padding-left"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">Pad Right</label>
                    <input
                      type="number"
                      value={content.padding_right || 0}
                      onChange={(e) => updateContent('padding_right', parseInt(e.target.value) || 0)}
                      className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                      min="0"
                      data-testid="input-textblock-padding-right"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Border Radius (px)</label>
                  <input
                    type="number"
                    value={content.border_radius || 0}
                    onChange={(e) => updateContent('border_radius', parseInt(e.target.value) || 0)}
                    className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                    min="0"
                    data-testid="input-textblock-border-radius"
                  />
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Heading Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('heading')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
          data-testid="accordion-textblock-heading"
        >
          <span className="font-semibold text-sm">Heading</span>
          {expandedSections.heading ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.heading && (
          <div className="p-4 space-y-4">
            <div>
              <Label className="text-sm">Heading Text</Label>
              <div className="border border-slate-200 rounded-md overflow-hidden mt-1">
                <ReactQuill
                  theme="snow"
                  value={content.heading || ''}
                  onChange={(value) => updateContent('heading', value)}
                  modules={quillModules}
                  placeholder="Enter heading text (optional)"
                  style={{ minHeight: '80px' }}
                  data-testid="input-textblock-heading"
                />
              </div>
            </div>

            <AlignmentButtons 
              value={content.heading_align || 'left'} 
              onChange={(val) => updateContent('heading_align', val)}
              label="Alignment"
              testIdPrefix="textblock-heading-align"
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
                  if (mapped.font_weight) updates.heading_font_weight = mapped.font_weight;
                  if (mapped.line_height) updates.heading_line_height = mapped.line_height;
                  if (mapped.letter_spacing !== undefined) updates.heading_letter_spacing = mapped.letter_spacing;
                  if (mapped.color) updates.heading_color = mapped.color;
                }
                updateMultipleContent(updates);
              }}
              label="Heading Typography Style"
            />

            <details className="text-sm">
              <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium" data-testid="toggle-textblock-heading-manual">Manual Font Settings</summary>
              <div className="grid grid-cols-2 gap-2 mt-2">
                <div>
                  <label className="block text-sm font-medium mb-1">Font</label>
                  <select
                    value={content.heading_font_family || 'Poppins'}
                    onChange={(e) => updateContent('heading_font_family', e.target.value)}
                    className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                    data-testid="select-textblock-heading-font"
                  >
                    {fontFamilies.map(f => <option key={f} value={f}>{f}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Weight</label>
                  <select
                    value={content.heading_font_weight || 700}
                    onChange={(e) => updateContent('heading_font_weight', parseInt(e.target.value))}
                    className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                    data-testid="select-textblock-heading-weight"
                  >
                    {fontWeights.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Size (px)</label>
                  <input
                    type="number"
                    value={content.heading_font_size || 30}
                    onChange={(e) => updateContent('heading_font_size', parseInt(e.target.value) || 30)}
                    className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                    min="10"
                    data-testid="input-textblock-heading-size"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Color</label>
                  <div className="flex gap-1">
                    <input
                      type="color"
                      value={content.heading_color || '#1e293b'}
                      onChange={(e) => updateContent('heading_color', e.target.value)}
                      className="w-10 h-8 border border-slate-300 rounded cursor-pointer"
                      data-testid="input-textblock-heading-color"
                    />
                    <input
                      type="text"
                      value={content.heading_color || '#1e293b'}
                      onChange={(e) => updateContent('heading_color', e.target.value)}
                      className="flex-1 px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Letter Spacing (px)</label>
                  <input
                    type="number"
                    value={content.heading_letter_spacing || 0}
                    onChange={(e) => updateContent('heading_letter_spacing', parseFloat(e.target.value) || 0)}
                    className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                    step="0.5"
                    data-testid="input-textblock-heading-spacing"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Line Height</label>
                  <input
                    type="number"
                    value={content.heading_line_height || 1.3}
                    onChange={(e) => updateContent('heading_line_height', parseFloat(e.target.value) || 1.3)}
                    className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                    step="0.1"
                    min="0.5"
                    data-testid="input-textblock-heading-line-height"
                  />
                </div>
              </div>
            </details>

            <div>
              <label className="block text-sm font-medium mb-1">Bottom Margin (px)</label>
              <input
                type="number"
                value={content.heading_margin_bottom || 24}
                onChange={(e) => updateContent('heading_margin_bottom', parseInt(e.target.value) || 24)}
                className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                min="0"
                data-testid="input-textblock-heading-margin"
              />
            </div>
          </div>
        )}
      </div>

      {/* Content Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('content')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
          data-testid="accordion-textblock-content"
        >
          <span className="font-semibold text-sm">Content</span>
          {expandedSections.content ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.content && (
          <div className="p-4 space-y-4">
            <div>
              <Label className="text-sm">Text Content</Label>
              <div className="border border-slate-200 rounded-md overflow-hidden mt-1">
                <ReactQuill
                  theme="snow"
                  value={content.text || ''}
                  onChange={(value) => updateContent('text', value)}
                  modules={quillModules}
                  formats={quillFormats}
                  placeholder="Enter your text content here..."
                  style={{ minHeight: '200px' }}
                  data-testid="editor-textblock-content"
                />
              </div>
              <p className="text-xs text-slate-500 mt-1">
                Use the toolbar to format your text with headings, lists, links, and more.
              </p>
            </div>

            <AlignmentButtons 
              value={content.content_align || 'left'} 
              onChange={(val) => updateContent('content_align', val)}
              label="Alignment"
              testIdPrefix="textblock-content-align"
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
                  if (mapped.font_weight) updates.content_font_weight = mapped.font_weight;
                  if (mapped.line_height) updates.content_line_height = mapped.line_height;
                  if (mapped.letter_spacing !== undefined) updates.content_letter_spacing = mapped.letter_spacing;
                  if (mapped.color) updates.content_color = mapped.color;
                }
                updateMultipleContent(updates);
              }}
              label="Content Typography Style"
            />

            <details className="text-sm">
              <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium" data-testid="toggle-textblock-content-manual">Manual Font Settings</summary>
              <div className="grid grid-cols-2 gap-2 mt-2">
                <div>
                  <label className="block text-sm font-medium mb-1">Font</label>
                  <select
                    value={content.content_font_family || 'Poppins'}
                    onChange={(e) => updateContent('content_font_family', e.target.value)}
                    className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                    data-testid="select-textblock-content-font"
                  >
                    {fontFamilies.map(f => <option key={f} value={f}>{f}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Weight</label>
                  <select
                    value={content.content_font_weight || 400}
                    onChange={(e) => updateContent('content_font_weight', parseInt(e.target.value))}
                    className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                    data-testid="select-textblock-content-weight"
                  >
                    {fontWeights.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Size (px)</label>
                  <input
                    type="number"
                    value={content.content_font_size || 16}
                    onChange={(e) => updateContent('content_font_size', parseInt(e.target.value) || 16)}
                    className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                    min="10"
                    data-testid="input-textblock-content-size"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Color</label>
                  <div className="flex gap-1">
                    <input
                      type="color"
                      value={content.content_color || '#475569'}
                      onChange={(e) => updateContent('content_color', e.target.value)}
                      className="w-10 h-8 border border-slate-300 rounded cursor-pointer"
                      data-testid="input-textblock-content-color"
                    />
                    <input
                      type="text"
                      value={content.content_color || '#475569'}
                      onChange={(e) => updateContent('content_color', e.target.value)}
                      className="flex-1 px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Letter Spacing (px)</label>
                  <input
                    type="number"
                    value={content.content_letter_spacing || 0}
                    onChange={(e) => updateContent('content_letter_spacing', parseFloat(e.target.value) || 0)}
                    className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                    step="0.5"
                    data-testid="input-textblock-content-spacing"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Line Height</label>
                  <input
                    type="number"
                    value={content.content_line_height || 1.6}
                    onChange={(e) => updateContent('content_line_height', parseFloat(e.target.value) || 1.6)}
                    className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                    step="0.1"
                    min="0.5"
                    data-testid="input-textblock-content-line-height"
                  />
                </div>
              </div>
            </details>
          </div>
        )}
      </div>

      {/* Mobile Settings Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('mobile')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
          data-testid="accordion-textblock-mobile"
        >
          <span className="font-semibold text-sm">Mobile Settings</span>
          {expandedSections.mobile ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.mobile && (
          <div className="p-4 space-y-4 bg-blue-50 rounded-lg">
            <p className="text-xs text-slate-600 mb-3">
              Leave fields empty to use automatic scaling based on desktop values.
            </p>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Heading Font Size</label>
                <input
                  type="number"
                  value={content.mobile_heading_font_size || ''}
                  onChange={(e) => updateContent('mobile_heading_font_size', e.target.value ? parseInt(e.target.value) : undefined)}
                  placeholder={`Auto: ${Math.max(22, Math.round((content.heading_font_size || 30) * 0.75))}px`}
                  className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                  min="10"
                  data-testid="input-textblock-mobile-heading-size"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Content Font Size</label>
                <input
                  type="number"
                  value={content.mobile_content_font_size || ''}
                  onChange={(e) => updateContent('mobile_content_font_size', e.target.value ? parseInt(e.target.value) : undefined)}
                  placeholder={`Auto: ${Math.max(14, Math.round((content.content_font_size || 16) * 0.9))}px`}
                  className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                  min="10"
                  data-testid="input-textblock-mobile-content-size"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Mobile Heading Alignment</label>
                <select
                  value={content.mobile_heading_align || ''}
                  onChange={(e) => updateContent('mobile_heading_align', e.target.value || undefined)}
                  className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                  data-testid="select-textblock-mobile-heading-align"
                >
                  <option value="">Use Desktop ({content.heading_align || 'left'})</option>
                  <option value="left">Left</option>
                  <option value="center">Center</option>
                  <option value="right">Right</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Mobile Content Alignment</label>
                <select
                  value={content.mobile_content_align || ''}
                  onChange={(e) => updateContent('mobile_content_align', e.target.value || undefined)}
                  className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                  data-testid="select-textblock-mobile-content-align"
                >
                  <option value="">Use Desktop ({content.content_align || 'left'})</option>
                  <option value="left">Left</option>
                  <option value="center">Center</option>
                  <option value="right">Right</option>
                </select>
              </div>
            </div>

            {(content.background_type && content.background_type !== 'none') && (
              <div className="grid grid-cols-4 gap-2 pt-2 border-t border-slate-200">
                <div>
                  <label className="block text-sm font-medium mb-1">M. Pad Top</label>
                  <input
                    type="number"
                    value={content.mobile_padding_top ?? ''}
                    onChange={(e) => updateContent('mobile_padding_top', e.target.value ? parseInt(e.target.value) : undefined)}
                    placeholder={content.padding_top || 0}
                    className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                    min="0"
                    data-testid="input-textblock-mobile-padding-top"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">M. Pad Bottom</label>
                  <input
                    type="number"
                    value={content.mobile_padding_bottom ?? ''}
                    onChange={(e) => updateContent('mobile_padding_bottom', e.target.value ? parseInt(e.target.value) : undefined)}
                    placeholder={content.padding_bottom || 0}
                    className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                    min="0"
                    data-testid="input-textblock-mobile-padding-bottom"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">M. Pad Left</label>
                  <input
                    type="number"
                    value={content.mobile_padding_left ?? ''}
                    onChange={(e) => updateContent('mobile_padding_left', e.target.value ? parseInt(e.target.value) : undefined)}
                    placeholder={content.padding_left || 0}
                    className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                    min="0"
                    data-testid="input-textblock-mobile-padding-left"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">M. Pad Right</label>
                  <input
                    type="number"
                    value={content.mobile_padding_right ?? ''}
                    onChange={(e) => updateContent('mobile_padding_right', e.target.value ? parseInt(e.target.value) : undefined)}
                    placeholder={content.padding_right || 0}
                    className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                    min="0"
                    data-testid="input-textblock-mobile-padding-right"
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
