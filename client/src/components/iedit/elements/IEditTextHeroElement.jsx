import React from "react";
import AGCASButton from "../../ui/AGCASButton";
import TypographyStyleSelector, { applyTypographyStyle } from "../TypographyStyleSelector";

export default function IEditTextHeroElement({ content, variant, settings }) {
  const { 
    header = '',
    header_font_family = 'Poppins',
    header_font_size = '48',
    header_color = '#000000',
    header_alignment = 'center',
    text_content = '',
    content_font_family = 'Poppins',
    content_font_size = '18',
    content_color = '#333333',
    content_alignment = 'center',
    background_color = '#ffffff',
    button,
    anchor
  } = content;

  const alignmentClasses = {
    left: 'text-left',
    center: 'text-center',
    right: 'text-right'
  };

  const headerAlign = alignmentClasses[header_alignment] || alignmentClasses.center;
  const contentAlign = alignmentClasses[content_alignment] || alignmentClasses.center;

  const justifyClasses = {
    left: 'justify-start',
    center: 'justify-center',
    right: 'justify-end'
  };

  const buttonJustify = justifyClasses[content_alignment] || justifyClasses.center;

  return (
    <div 
      id={anchor || undefined}
      className="py-16 px-4"
      style={{ backgroundColor: background_color }}
    >
      <div className="max-w-4xl mx-auto space-y-6">
        {header && (
          <h1 
            className={`${headerAlign} font-bold`}
            style={{ 
              fontFamily: header_font_family,
              fontSize: `${header_font_size}px`,
              color: header_color
            }}
          >
            {header}
          </h1>
        )}
        
        {text_content && (
          <p 
            className={`${contentAlign}`}
            style={{ 
              fontFamily: content_font_family,
              fontSize: `${content_font_size}px`,
              color: content_color,
              whiteSpace: 'pre-wrap'
            }}
          >
            {text_content}
          </p>
        )}

        {button && button.text && (
          <div className={`flex ${buttonJustify} mt-8`}>
            <AGCASButton
              text={button.text}
              link={button.link}
              buttonStyleId={button.button_style_id}
              customBgColor={button.custom_bg_color}
              customTextColor={button.custom_text_color}
              customBorderColor={button.custom_border_color}
              openInNewTab={button.open_in_new_tab}
              size={button.size || 'large'}
              showArrow={button.show_arrow}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// Editor Component
export function IEditTextHeroElementEditor({ element, onChange }) {
  const defaultButton = { 
    text: '', 
    link: '', 
    button_style_id: '', 
    open_in_new_tab: false, 
    size: 'large', 
    show_arrow: false, 
    custom_bg_color: '#000000', 
    custom_text_color: '#ffffff', 
    custom_border_color: '' 
  };
  
  const content = element.content ? {
    header: element.content.header ?? '',
    header_font_family: element.content.header_font_family ?? 'Poppins',
    header_font_size: element.content.header_font_size ?? '48',
    header_font_size_mobile: element.content.header_font_size_mobile ?? '',
    header_font_weight: element.content.header_font_weight ?? '',
    header_letter_spacing: element.content.header_letter_spacing ?? '',
    header_color: element.content.header_color ?? '#000000',
    header_alignment: element.content.header_alignment ?? 'center',
    header_typography_style_id: element.content.header_typography_style_id ?? '',
    text_content: element.content.text_content ?? '',
    content_font_family: element.content.content_font_family ?? 'Poppins',
    content_font_size: element.content.content_font_size ?? '18',
    content_font_size_mobile: element.content.content_font_size_mobile ?? '',
    content_font_weight: element.content.content_font_weight ?? '',
    content_color: element.content.content_color ?? '#333333',
    content_alignment: element.content.content_alignment ?? 'center',
    content_typography_style_id: element.content.content_typography_style_id ?? '',
    background_color: element.content.background_color ?? '#ffffff',
    button: element.content.button ? { ...defaultButton, ...element.content.button } : defaultButton
  } : {
    header: '',
    header_font_family: 'Poppins',
    header_font_size: '48',
    header_font_size_mobile: '',
    header_font_weight: '',
    header_letter_spacing: '',
    header_color: '#000000',
    header_alignment: 'center',
    header_typography_style_id: '',
    text_content: '',
    content_font_family: 'Poppins',
    content_font_size: '18',
    content_font_size_mobile: '',
    content_font_weight: '',
    content_color: '#333333',
    content_alignment: 'center',
    content_typography_style_id: '',
    background_color: '#ffffff',
    button: defaultButton
  };

  const updateContent = (key, value) => {
    onChange({ ...element, content: { ...content, [key]: value } });
  };

  const updateButton = (key, value) => {
    updateContent('button', { ...content.button, [key]: value });
  };

  // Fetch button styles
  const [buttonStyles, setButtonStyles] = React.useState([]);
  
  React.useEffect(() => {
    const fetchStyles = async () => {
      try {
        const { base44 } = await import("@/api/base44Client");
        const styles = await base44.entities.ButtonStyle.list() || [];
        setButtonStyles(styles.filter(s => s.is_active));
      } catch (error) {
        console.error('Failed to fetch button styles:', error);
      }
    };
    fetchStyles();
  }, []);

  return (
    <div className="space-y-6">
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
          placeholder="e.g., text-hero"
          className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
          data-testid="input-texthero-anchor"
        />
        <p className="text-xs text-slate-500 mt-1">
          Used for linking directly to this section (e.g., /page#anchor-id)
        </p>
      </div>

      {/* Header Settings */}
      <div className="space-y-4 p-4 bg-slate-50 rounded-lg">
        <h4 className="font-semibold text-sm">Header Settings</h4>
        
        <div>
          <label className="block text-sm font-medium mb-1">Header Text</label>
          <input
            type="text"
            value={content.header || ''}
            onChange={(e) => updateContent('header', e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 rounded-md"
            placeholder="Enter header text..."
          />
        </div>

        <TypographyStyleSelector
          value={content.header_typography_style_id}
          onChange={(styleId) => updateContent('header_typography_style_id', styleId)}
          onApplyStyle={(style) => {
            const styleProps = applyTypographyStyle(style);
            if (styleProps.font_family) updateContent('header_font_family', styleProps.font_family);
            if (styleProps.font_size) updateContent('header_font_size', styleProps.font_size);
            if (styleProps.font_size_mobile) updateContent('header_font_size_mobile', styleProps.font_size_mobile);
            if (styleProps.font_weight) updateContent('header_font_weight', styleProps.font_weight);
            if (styleProps.letter_spacing) updateContent('header_letter_spacing', styleProps.letter_spacing);
            if (styleProps.color) updateContent('header_color', styleProps.color);
            updateContent('header_typography_style_id', style.id);
          }}
          filterTypes={['h1', 'h2', 'h3']}
          label="Header Typography Style"
        />

        <details className="mt-3">
          <summary className="text-sm font-medium cursor-pointer text-slate-600 hover:text-slate-800">
            Manual Font Settings
          </summary>
          <div className="mt-3 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Font</label>
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
                  min="12"
                  max="120"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Mobile Font Size (px)</label>
                <input
                  type="number"
                  value={content.header_font_size_mobile || ''}
                  onChange={(e) => updateContent('header_font_size_mobile', e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                  min="12"
                  max="120"
                  placeholder="Same as desktop"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Color</label>
                <input
                  type="color"
                  value={content.header_color || '#000000'}
                  onChange={(e) => updateContent('header_color', e.target.value)}
                  className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                />
              </div>
            </div>
          </div>
        </details>

        <div>
          <label className="block text-sm font-medium mb-1">Alignment</label>
          <select
            value={content.header_alignment || 'center'}
            onChange={(e) => updateContent('header_alignment', e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 rounded-md"
          >
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
        </div>
      </div>

      {/* Content Settings */}
      <div className="space-y-4 p-4 bg-slate-50 rounded-lg">
        <h4 className="font-semibold text-sm">Content Settings</h4>
        
        <div>
          <label className="block text-sm font-medium mb-1">Content Text</label>
          <textarea
            value={content.text_content || ''}
            onChange={(e) => updateContent('text_content', e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 rounded-md"
            rows="4"
            placeholder="Enter content text..."
          />
        </div>

        <TypographyStyleSelector
          value={content.content_typography_style_id}
          onChange={(styleId) => updateContent('content_typography_style_id', styleId)}
          onApplyStyle={(style) => {
            const styleProps = applyTypographyStyle(style);
            if (styleProps.font_family) updateContent('content_font_family', styleProps.font_family);
            if (styleProps.font_size) updateContent('content_font_size', styleProps.font_size);
            if (styleProps.font_size_mobile) updateContent('content_font_size_mobile', styleProps.font_size_mobile);
            if (styleProps.font_weight) updateContent('content_font_weight', styleProps.font_weight);
            if (styleProps.color) updateContent('content_color', styleProps.color);
            updateContent('content_typography_style_id', style.id);
          }}
          filterTypes={['paragraph']}
          label="Content Typography Style"
        />

        <details className="mt-3">
          <summary className="text-sm font-medium cursor-pointer text-slate-600 hover:text-slate-800">
            Manual Font Settings
          </summary>
          <div className="mt-3 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Font</label>
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
                <label className="block text-sm font-medium mb-1">Font Size (px)</label>
                <input
                  type="number"
                  value={content.content_font_size || 18}
                  onChange={(e) => updateContent('content_font_size', e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                  min="12"
                  max="48"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Mobile Font Size (px)</label>
                <input
                  type="number"
                  value={content.content_font_size_mobile || ''}
                  onChange={(e) => updateContent('content_font_size_mobile', e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                  min="12"
                  max="48"
                  placeholder="Same as desktop"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Color</label>
                <input
                  type="color"
                  value={content.content_color || '#333333'}
                  onChange={(e) => updateContent('content_color', e.target.value)}
                  className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                />
              </div>
            </div>
          </div>
        </details>

        <div>
          <label className="block text-sm font-medium mb-1">Alignment</label>
          <select
            value={content.content_alignment || 'center'}
            onChange={(e) => updateContent('content_alignment', e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 rounded-md"
          >
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
        </div>
      </div>

      {/* Background Color */}
      <div className="space-y-4 p-4 bg-slate-50 rounded-lg">
        <h4 className="font-semibold text-sm">Background</h4>
        
        <div>
          <label className="block text-sm font-medium mb-1">Background Color</label>
          <input
            type="color"
            value={content.background_color || '#ffffff'}
            onChange={(e) => updateContent('background_color', e.target.value)}
            className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
          />
        </div>
      </div>

      {/* CTA Button */}
      <div className="space-y-4 p-4 bg-slate-50 rounded-lg">
        <h4 className="font-semibold text-sm">CTA Button</h4>
        
        <div>
          <label className="block text-sm font-medium mb-1">Button Text</label>
          <input
            type="text"
            value={content.button.text || ''}
            onChange={(e) => updateButton('text', e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 rounded-md"
            placeholder="e.g., Get Started"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Link URL</label>
          <input
            type="text"
            value={content.button.link || ''}
            onChange={(e) => updateButton('link', e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 rounded-md"
            placeholder="https://..."
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Button Style</label>
          <select
            value={content.button.button_style_id || ''}
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
            <label className="block text-sm font-medium mb-1">Background</label>
            <input
              type="color"
              value={content.button.custom_bg_color || '#000000'}
              onChange={(e) => updateButton('custom_bg_color', e.target.value)}
              className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Text</label>
            <input
              type="color"
              value={content.button.custom_text_color || '#ffffff'}
              onChange={(e) => updateButton('custom_text_color', e.target.value)}
              className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Border (opt.)</label>
            <input
              type="color"
              value={content.button.custom_border_color || ''}
              onChange={(e) => updateButton('custom_border_color', e.target.value)}
              className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Button Size</label>
          <select
            value={content.button.size || 'large'}
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
            id="arrow-texthero"
            checked={content.button.show_arrow || false}
            onChange={(e) => updateButton('show_arrow', e.target.checked)}
            className="w-4 h-4"
          />
          <label htmlFor="arrow-texthero" className="text-sm cursor-pointer">
            Show arrow icon →
          </label>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="new-tab-texthero"
            checked={content.button.open_in_new_tab || false}
            onChange={(e) => updateButton('open_in_new_tab', e.target.checked)}
            className="w-4 h-4"
          />
          <label htmlFor="new-tab-texthero" className="text-sm cursor-pointer">
            Open in new tab
          </label>
        </div>
      </div>
    </div>
  );
}
