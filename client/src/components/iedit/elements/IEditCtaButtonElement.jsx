import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChevronDown, ChevronUp, AlignLeft, AlignCenter, AlignRight } from "lucide-react";
import AGCASButton from "@/components/ui/AGCASButton";

// Hook to detect mobile viewport
function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(false);
  
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < breakpoint);
    };
    
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, [breakpoint]);
  
  return isMobile;
}

export default function IEditCtaButtonElement({ content, variant, settings, previewViewport }) {
  const fullWidth = settings?.fullWidth;
  const isActualMobile = useIsMobile();
  
  // Use previewViewport if provided (editor mode), otherwise detect actual viewport
  const isMobile = previewViewport ? previewViewport === 'mobile' : isActualMobile;
  
  const alignment = {
    left: "justify-start",
    center: "justify-center",
    right: "justify-end",
  };

  const alignClass = alignment[content?.alignment] || alignment.center;
  const button = content?.button || {};

  const shouldShowButton = button.link && (button.text || button.show_arrow);

  // Full width breakout class - extends background to screen edges
  const fullWidthClass = fullWidth ? 'w-screen relative left-1/2 right-1/2 -ml-[50vw] -mr-[50vw]' : '';

  // Determine padding values based on viewport
  const useCustomMobileSpacing = content?.mobile_custom_spacing && isMobile;
  const topMargin = useCustomMobileSpacing 
    ? (content?.mobile_top_margin ?? content?.top_margin ?? 16)
    : (content?.top_margin || 16);
  const bottomMargin = useCustomMobileSpacing 
    ? (content?.mobile_bottom_margin ?? content?.bottom_margin ?? 16)
    : (content?.bottom_margin || 16);
  const leftPadding = useCustomMobileSpacing 
    ? (content?.mobile_left_padding ?? content?.left_padding ?? 0)
    : (content?.left_padding || 0);
  const rightPadding = useCustomMobileSpacing 
    ? (content?.mobile_right_padding ?? content?.right_padding ?? 0)
    : (content?.right_padding || 0);

  if (!shouldShowButton) {
    return (
      <div className={`${fullWidthClass}`}>
        {fullWidth ? (
          <div className="max-w-7xl mx-auto px-4">
            <div className={`flex ${alignClass} py-4`}>
              <span className="text-slate-400 text-sm italic">Configure button in editor...</span>
            </div>
          </div>
        ) : (
          <div className={`flex ${alignClass} py-4`}>
            <span className="text-slate-400 text-sm italic">Configure button in editor...</span>
          </div>
        )}
      </div>
    );
  }

  const anchor = content?.anchor;
  const backgroundColor = content?.background_color;

  const renderButton = () => (
    <div className={`flex ${alignClass}`}>
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
        useGradientHover={button.use_gradient_hover}
      />
    </div>
  );

  return (
    <div 
      id={anchor || undefined}
      className={fullWidthClass}
      style={{ 
        paddingTop: `${topMargin}px`,
        paddingBottom: `${bottomMargin}px`,
        paddingLeft: `${leftPadding}px`,
        paddingRight: `${rightPadding}px`,
        backgroundColor: backgroundColor || undefined
      }}
    >
      {fullWidth ? (
        <div className="max-w-7xl mx-auto px-4">
          {renderButton()}
        </div>
      ) : (
        renderButton()
      )}
    </div>
  );
}

export function IEditCtaButtonElementEditor({ element, onChange }) {
  const content = element.content || {};
  const button = content.button || {};
  const [buttonStyles, setButtonStyles] = useState([]);
  const [viewportTab, setViewportTab] = useState('desktop');
  const [expandedSections, setExpandedSections] = useState({
    button: true,
    spacing: false,
    mobileSpacing: true
  });

  useEffect(() => {
    const fetchButtonStyles = async () => {
      try {
        const { base44 } = await import("@/api/base44Client");
        const styles = await base44.entities.ButtonStyle.list();
        setButtonStyles(styles || []);
      } catch (error) {
        console.error('Failed to fetch button styles:', error);
      }
    };
    fetchButtonStyles();
  }, []);

  const updateContent = (key, value) => {
    onChange({ ...element, content: { ...content, [key]: value } });
  };

  const updateButton = (keyOrObj, value) => {
    if (typeof keyOrObj === 'object') {
      onChange({ 
        ...element, 
        content: { 
          ...content, 
          button: { ...button, ...keyOrObj } 
        } 
      });
    } else {
      onChange({ 
        ...element, 
        content: { 
          ...content, 
          button: { ...button, [keyOrObj]: value } 
        } 
      });
    }
  };

  const toggleSection = (section) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

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
          placeholder="e.g., cta-button"
          className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
          data-testid="input-ctabutton-anchor"
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
          data-testid="button-ctabutton-viewport-desktop"
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
          data-testid="button-ctabutton-viewport-mobile"
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
      {/* Button Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('button')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
          data-testid="accordion-cta-button"
        >
          <span className="font-semibold text-sm">Button Settings</span>
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
                data-testid="input-cta-button-text"
              />
              <p className="text-xs text-slate-500 mt-1">
                Leave empty for arrow-only button (if arrow is enabled)
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Link URL</label>
              <input
                type="text"
                value={button.link || ''}
                onChange={(e) => updateButton('link', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
                placeholder="https://..."
                data-testid="input-cta-button-link"
              />
            </div>

            <AlignmentButtons 
              value={content.alignment || 'center'} 
              onChange={(val) => updateContent('alignment', val)}
              label="Button Alignment"
              testIdPrefix="cta-button-align"
            />

            <div>
              <label className="block text-sm font-medium mb-1">Button Style Type</label>
              <select
                value={button.style_type || 'custom'}
                onChange={(e) => updateButton('style_type', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
                data-testid="select-cta-style-type"
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
                    data-testid="select-cta-button-style"
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
                    id="transparent-bg-cta"
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
                    data-testid="checkbox-cta-transparent-bg"
                  />
                  <label htmlFor="transparent-bg-cta" className="text-sm cursor-pointer">
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
                        data-testid="input-cta-bg-color"
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
                      data-testid="input-cta-text-color"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">Border</label>
                    <input
                      type="color"
                      value={button.custom_border_color || '#000000'}
                      onChange={(e) => updateButton('custom_border_color', e.target.value)}
                      className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                      data-testid="input-cta-border-color"
                    />
                  </div>
                </div>

                <div className="flex items-center gap-2 p-3 bg-slate-50 rounded-md">
                  <input
                    type="checkbox"
                    id="gradient-hover-cta"
                    checked={button.use_gradient_hover || false}
                    onChange={(e) => updateButton('use_gradient_hover', e.target.checked)}
                    className="w-4 h-4"
                    data-testid="checkbox-cta-gradient-hover"
                  />
                  <div>
                    <label htmlFor="gradient-hover-cta" className="text-sm cursor-pointer font-medium">
                      Gradient hover effect
                    </label>
                    <p className="text-xs text-slate-500">
                      Show gradient background on hover
                    </p>
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
                data-testid="select-cta-button-size"
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
                id="arrow-cta"
                checked={button.show_arrow || false}
                onChange={(e) => updateButton('show_arrow', e.target.checked)}
                className="w-4 h-4"
                data-testid="checkbox-cta-show-arrow"
              />
              <label htmlFor="arrow-cta" className="text-sm cursor-pointer">
                Show arrow icon
              </label>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="new-tab-cta"
                checked={button.open_in_new_tab || false}
                onChange={(e) => updateButton('open_in_new_tab', e.target.checked)}
                className="w-4 h-4"
                data-testid="checkbox-cta-new-tab"
              />
              <label htmlFor="new-tab-cta" className="text-sm cursor-pointer">
                Open in new tab
              </label>
            </div>
          </div>
        )}
      </div>

      {/* Spacing & Background Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('spacing')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
          data-testid="accordion-cta-spacing"
        >
          <span className="font-semibold text-sm">Spacing & Background</span>
          {expandedSections.spacing ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.spacing && (
          <div className="p-4 space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Background Color</label>
              <div className="flex gap-2 items-center">
                <input
                  type="color"
                  value={content.background_color || '#ffffff'}
                  onChange={(e) => updateContent('background_color', e.target.value)}
                  className="w-10 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                  data-testid="input-cta-background-color"
                />
                <Input
                  value={content.background_color || ''}
                  onChange={(e) => updateContent('background_color', e.target.value)}
                  className="flex-1 font-mono text-sm"
                  placeholder="transparent"
                />
                {content.background_color && (
                  <button
                    type="button"
                    onClick={() => updateContent('background_color', '')}
                    className="text-xs text-slate-500 hover:text-slate-700 underline"
                  >
                    Clear
                  </button>
                )}
              </div>
              <p className="text-xs text-slate-500 mt-1">
                Leave empty for transparent. Most useful when Full Width is enabled.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Top Margin (px)</label>
              <input
                type="number"
                value={content.top_margin || 16}
                onChange={(e) => updateContent('top_margin', parseInt(e.target.value) || 0)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
                min="0"
                max="200"
                data-testid="input-cta-top-margin"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Bottom Margin (px)</label>
              <input
                type="number"
                value={content.bottom_margin || 16}
                onChange={(e) => updateContent('bottom_margin', parseInt(e.target.value) || 0)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
                min="0"
                max="200"
                data-testid="input-cta-bottom-margin"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Left Padding (px)</label>
              <input
                type="number"
                value={content.left_padding || 0}
                onChange={(e) => updateContent('left_padding', parseInt(e.target.value) || 0)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
                min="0"
                max="200"
                data-testid="input-cta-left-padding"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Right Padding (px)</label>
              <input
                type="number"
                value={content.right_padding || 0}
                onChange={(e) => updateContent('right_padding', parseInt(e.target.value) || 0)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
                min="0"
                max="200"
                data-testid="input-cta-right-padding"
              />
            </div>
          </div>
        )}
      </div>
        </>
      )}

      {/* Mobile Controls */}
      {viewportTab === 'mobile' && (
        <>
          {/* Mobile Spacing Section */}
          <div className="border rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => toggleSection('mobileSpacing')}
              className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
              data-testid="accordion-cta-mobile-spacing"
            >
              <span className="font-semibold text-sm">Mobile Spacing</span>
              {expandedSections.mobileSpacing ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
            
            {expandedSections.mobileSpacing && (
              <div className="p-4 space-y-4">
                <div className="bg-blue-50 text-blue-700 p-3 rounded-md text-sm">
                  <p className="font-medium mb-1">Mobile-Specific Padding</p>
                  <p className="text-xs">
                    Configure separate padding values for mobile devices. When not set, desktop values will be used.
                  </p>
                </div>

                {/* Use Custom Mobile Spacing Toggle */}
                <div className="flex items-center gap-2 p-3 bg-slate-50 rounded-md">
                  <input
                    type="checkbox"
                    id="mobile-custom-spacing"
                    checked={content.mobile_custom_spacing || false}
                    onChange={(e) => updateContent('mobile_custom_spacing', e.target.checked)}
                    className="w-4 h-4"
                    data-testid="checkbox-cta-mobile-custom-spacing"
                  />
                  <div>
                    <label htmlFor="mobile-custom-spacing" className="text-sm cursor-pointer font-medium">
                      Use custom mobile spacing
                    </label>
                    <p className="text-xs text-slate-500">
                      When disabled, desktop spacing values are used on mobile
                    </p>
                  </div>
                </div>

                {content.mobile_custom_spacing && (
                  <>
                    <div className="border-t pt-4">
                      <h5 className="font-medium text-sm mb-3">Vertical Padding</h5>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-sm font-medium mb-1">Top (px)</label>
                          <input
                            type="number"
                            value={content.mobile_top_margin ?? content.top_margin ?? 16}
                            onChange={(e) => updateContent('mobile_top_margin', parseInt(e.target.value) || 0)}
                            className="w-full px-3 py-2 border border-slate-300 rounded-md"
                            min="0"
                            max="200"
                            data-testid="input-cta-mobile-top-margin"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium mb-1">Bottom (px)</label>
                          <input
                            type="number"
                            value={content.mobile_bottom_margin ?? content.bottom_margin ?? 16}
                            onChange={(e) => updateContent('mobile_bottom_margin', parseInt(e.target.value) || 0)}
                            className="w-full px-3 py-2 border border-slate-300 rounded-md"
                            min="0"
                            max="200"
                            data-testid="input-cta-mobile-bottom-margin"
                          />
                        </div>
                      </div>
                    </div>

                    <div className="border-t pt-4">
                      <h5 className="font-medium text-sm mb-3">Horizontal Padding</h5>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-sm font-medium mb-1">Left (px)</label>
                          <input
                            type="number"
                            value={content.mobile_left_padding ?? content.left_padding ?? 0}
                            onChange={(e) => updateContent('mobile_left_padding', parseInt(e.target.value) || 0)}
                            className="w-full px-3 py-2 border border-slate-300 rounded-md"
                            min="0"
                            max="200"
                            data-testid="input-cta-mobile-left-padding"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium mb-1">Right (px)</label>
                          <input
                            type="number"
                            value={content.mobile_right_padding ?? content.right_padding ?? 0}
                            onChange={(e) => updateContent('mobile_right_padding', parseInt(e.target.value) || 0)}
                            className="w-full px-3 py-2 border border-slate-300 rounded-md"
                            min="0"
                            max="200"
                            data-testid="input-cta-mobile-right-padding"
                          />
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Info about button settings */}
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
            <p className="text-sm text-slate-600">
              <span className="font-medium">Note:</span> Button text, style, and alignment settings are configured in the Desktop tab and apply to both viewports.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
