import React, { useState } from "react";
import AGCASButton from "../../ui/AGCASButton";
import TypographyStyleSelector, { applyTypographyStyle } from "../TypographyStyleSelector";
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import DOMPurify from 'dompurify';
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { ChevronUp, ChevronDown } from "lucide-react";

export default function IEditButtonBlockElement({ content, variant, settings }) {
  const { 
    heading_text = '',
    heading_font_family = 'Poppins',
    heading_font_size = 32,
    heading_font_size_mobile,
    heading_font_weight = 700,
    heading_line_height = 1.2,
    heading_letter_spacing = 0,
    heading_color = '#1e293b',
    subheading_text = '',
    subheading_font_family = 'Poppins',
    subheading_font_size = 20,
    subheading_font_size_mobile,
    subheading_font_weight = 400,
    subheading_line_height = 1.5,
    subheading_letter_spacing = 0,
    subheading_color = '#475569',
    body_content = '',
    content_font_family = 'Poppins',
    content_font_size = 16,
    content_font_size_mobile,
    content_font_weight = 400,
    content_line_height = 1.6,
    content_letter_spacing = 0,
    content_color = '#64748b',
    text_align = 'center',
    background_color = '#ffffff',
    button_gap = '16',
    buttons = []
  } = content;

  const alignmentClasses = {
    left: 'text-left items-start',
    center: 'text-center items-center',
    right: 'text-right items-end'
  };

  const textAlignClass = alignmentClasses[text_align] || alignmentClasses.center;

  // Filter out empty buttons
  const validButtons = buttons.filter(btn => btn?.text && btn?.text.trim() !== '');

  const hasTextContent = heading_text || subheading_text || body_content;

  return (
    <div 
      className="py-12 px-4"
      style={{ backgroundColor: background_color }}
    >
      <div className="max-w-7xl mx-auto">
        {hasTextContent && (
          <div className={`flex flex-col ${textAlignClass} mb-8`}>
            {heading_text && (
              <div 
                className="prose max-w-none mb-4"
                style={{ 
                  fontFamily: heading_font_family,
                  fontSize: `${heading_font_size}px`,
                  fontWeight: heading_font_weight,
                  lineHeight: heading_line_height,
                  letterSpacing: `${heading_letter_spacing}px`,
                  color: heading_color,
                  textAlign: text_align
                }}
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(heading_text) }}
              />
            )}
            {subheading_text && (
              <div 
                className="prose max-w-none mb-4"
                style={{ 
                  fontFamily: subheading_font_family,
                  fontSize: `${subheading_font_size}px`,
                  fontWeight: subheading_font_weight,
                  lineHeight: subheading_line_height,
                  letterSpacing: `${subheading_letter_spacing}px`,
                  color: subheading_color,
                  textAlign: text_align
                }}
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(subheading_text) }}
              />
            )}
            {body_content && (
              <div 
                className="prose max-w-none"
                style={{ 
                  fontFamily: content_font_family,
                  fontSize: `${content_font_size}px`,
                  fontWeight: content_font_weight,
                  lineHeight: content_line_height,
                  letterSpacing: `${content_letter_spacing}px`,
                  color: content_color,
                  textAlign: text_align
                }}
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(body_content) }}
              />
            )}
          </div>
        )}
        
        <div 
          className={`flex flex-wrap ${
            text_align === 'center' ? 'justify-center' : 
            text_align === 'right' ? 'justify-end' : 
            'justify-start'
          }`}
          style={{ gap: `${button_gap}px` }}
        >
          {validButtons.map((button, index) => (
            <AGCASButton
              key={index}
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
          ))}
        </div>
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

// Editor Component
export function IEditButtonBlockElementEditor({ element, onChange }) {
  const [expandedSections, setExpandedSections] = useState({
    textContent: true,
    background: false,
    buttons: false
  });

  const toggleSection = (section) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const defaultButton = { text: '', link: '', button_style_id: '', open_in_new_tab: false, size: 'medium', show_arrow: false, custom_bg_color: '#000000', custom_text_color: '#ffffff', custom_border_color: '' };
  
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
    if ((currentContent.buttons || []).length < 4) {
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
  const [buttonStyles, setButtonStyles] = React.useState([]);
  
  React.useEffect(() => {
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

  const renderTypographyControls = (prefix, label) => {
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

    return (
      <div className="space-y-3 mt-3 p-3 bg-slate-50 rounded-md">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">Font Family</Label>
            <select
              value={content[`${prefix}_font_family`] || 'Poppins'}
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
              value={content[`${prefix}_font_weight`] || 400}
              onChange={(e) => updateContent(`${prefix}_font_weight`, parseInt(e.target.value))}
              className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-xs"
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
              value={content[`${prefix}_font_size`] || 16}
              onChange={(e) => updateContent(`${prefix}_font_size`, parseInt(e.target.value) || 16)}
              min="8"
              max="120"
              className="text-xs h-8"
            />
          </div>
          <div>
            <Label className="text-xs">Mobile Font Size (px)</Label>
            <Input
              type="number"
              value={content[`${prefix}_font_size_mobile`] || ''}
              onChange={(e) => updateContent(`${prefix}_font_size_mobile`, e.target.value ? parseInt(e.target.value) : null)}
              min="8"
              max="120"
              placeholder="Auto"
              className="text-xs h-8"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">Line Height</Label>
            <Input
              type="number"
              step="0.1"
              value={content[`${prefix}_line_height`] || 1.5}
              onChange={(e) => updateContent(`${prefix}_line_height`, parseFloat(e.target.value) || 1.5)}
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
              value={content[`${prefix}_color`] || '#1e293b'}
              onChange={(e) => updateContent(`${prefix}_color`, e.target.value)}
              className="w-10 h-8 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
            />
            <Input
              value={content[`${prefix}_color`] || '#1e293b'}
              onChange={(e) => updateContent(`${prefix}_color`, e.target.value)}
              className="flex-1 font-mono text-xs h-8"
              placeholder="#1e293b"
            />
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-3">
      {/* Header/Subheader/Content Accordion */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('textContent')}
          className="w-full flex items-center justify-between p-3 bg-slate-50 hover:bg-slate-100 transition-colors"
          data-testid="accordion-button-block-text-content"
        >
          <span className="font-medium text-sm">Header / Subheader / Content</span>
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
                      heading_font_size_mobile: styleProps.font_size_mobile || content.heading_font_size_mobile,
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
                {renderTypographyControls('heading', 'Heading')}
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
                      subheading_font_size_mobile: styleProps.font_size_mobile || content.subheading_font_size_mobile,
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
                {renderTypographyControls('subheading', 'Subheading')}
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
                      content_font_size_mobile: styleProps.font_size_mobile || content.content_font_size_mobile,
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
                {renderTypographyControls('content', 'Content')}
              </details>
            </div>
          </div>
        )}
      </div>

      {/* Background Settings Accordion */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('background')}
          className="w-full flex items-center justify-between p-3 bg-slate-50 hover:bg-slate-100 transition-colors"
          data-testid="accordion-button-block-background"
        >
          <span className="font-medium text-sm">Background & Layout</span>
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
          <span className="font-medium text-sm">Buttons ({(content.buttons || []).length}/4)</span>
          {expandedSections.buttons ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        
        {expandedSections.buttons && (
          <div className="p-4 space-y-4 border-t">
            <div className="flex items-center justify-end">
              {(content.buttons || []).length < 4 && (
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
        )}
      </div>
    </div>
  );
}