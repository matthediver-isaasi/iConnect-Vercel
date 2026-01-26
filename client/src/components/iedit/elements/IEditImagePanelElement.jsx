import { useState, useEffect, useRef } from "react";
import AGCASButton from "../../ui/AGCASButton";
import TypographyStyleSelector, { applyTypographyStyle } from "../TypographyStyleSelector";
import { useIsMobile } from "@/hooks/use-mobile";
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import DOMPurify from 'dompurify';
import { AlignLeft, AlignCenter, AlignRight, ChevronDown, ChevronUp, ChevronLeft, ChevronRight } from "lucide-react";

const panelQuillModules = {
  toolbar: [
    ['bold', 'italic', 'underline'],
    [{ 'list': 'ordered'}, { 'list': 'bullet' }],
    ['link'],
    ['clean']
  ]
};

export default function IEditImagePanelElement({ content, variant, settings, previewViewport }) {
  const isMobilePreview = previewViewport === 'mobile';
  const {
    anchor,
    full_width = false,
    background_type = 'color',
    background_color = '#1a1a2e',
    gradient_start_color = '#3b82f6',
    gradient_end_color = '#8b5cf6',
    gradient_angle = 135,
    image_url,
    image_fit = 'cover',
    overlay_enabled = false,
    overlay_color = '#000000',
    overlay_opacity = 50,
    height_type = 'custom',
    min_height = 500,
    divider_color = '#ffffff',
    divider_weight = 1,
    divider_opacity = 30,
    panels = [],
    // Mobile background settings
    mobile_background_type = 'same', // 'same', 'color', 'gradient', 'image'
    mobile_background_color = '#1a1a2e',
    mobile_gradient_start_color = '#3b82f6',
    mobile_gradient_end_color = '#8b5cf6',
    mobile_gradient_angle = 135,
    mobile_image_url,
    mobile_image_fit = 'cover',
    mobile_overlay_enabled = false,
    mobile_overlay_color = '#000000',
    mobile_overlay_opacity = 50,
    mobile_min_height,
    mobile_text_gap
  } = content || {};

  // Use all configured panels (up to 5) without filtering empty ones
  // This ensures dividers appear correctly even for blank panels
  const displayPanels = panels.length > 0 ? panels.slice(0, 5) : [{}];

  // Detect mobile for responsive font sizing
  const isMobile = useIsMobile();
  const isEffectivelyMobile = isMobile || isMobilePreview;

  // Determine effective background settings based on viewport
  const useMobileBackground = isEffectivelyMobile && mobile_background_type !== 'same';
  
  const effectiveBackgroundType = useMobileBackground ? mobile_background_type : background_type;
  const effectiveBackgroundColor = useMobileBackground ? mobile_background_color : background_color;
  const effectiveGradientStart = useMobileBackground ? mobile_gradient_start_color : gradient_start_color;
  const effectiveGradientEnd = useMobileBackground ? mobile_gradient_end_color : gradient_end_color;
  const effectiveGradientAngle = useMobileBackground ? mobile_gradient_angle : gradient_angle;
  const effectiveImageUrl = useMobileBackground ? mobile_image_url : image_url;
  const effectiveImageFit = useMobileBackground ? mobile_image_fit : image_fit;
  const effectiveOverlayEnabled = useMobileBackground ? mobile_overlay_enabled : overlay_enabled;
  const effectiveOverlayColor = useMobileBackground ? mobile_overlay_color : overlay_color;
  const effectiveOverlayOpacity = useMobileBackground ? mobile_overlay_opacity : overlay_opacity;
  const effectiveMinHeight = (isEffectivelyMobile && mobile_min_height) ? mobile_min_height : min_height;

  // Mobile swipe state
  const [currentPanelIndex, setCurrentPanelIndex] = useState(0);
  const touchStartX = useRef(0);
  const touchEndX = useRef(0);
  const containerRef = useRef(null);

  // Swipe threshold in pixels
  const SWIPE_THRESHOLD = 50;

  const handleTouchStart = (e) => {
    touchStartX.current = e.touches[0].clientX;
  };

  const handleTouchMove = (e) => {
    touchEndX.current = e.touches[0].clientX;
  };

  const handleTouchEnd = () => {
    const diff = touchStartX.current - touchEndX.current;
    if (Math.abs(diff) > SWIPE_THRESHOLD) {
      if (diff > 0 && currentPanelIndex < displayPanels.length - 1) {
        // Swipe left - go to next panel
        setCurrentPanelIndex(prev => prev + 1);
      } else if (diff < 0 && currentPanelIndex > 0) {
        // Swipe right - go to previous panel
        setCurrentPanelIndex(prev => prev - 1);
      }
    }
    touchStartX.current = 0;
    touchEndX.current = 0;
  };

  const goToPanel = (index) => {
    setCurrentPanelIndex(index);
  };

  const goToPrevPanel = () => {
    if (currentPanelIndex > 0) {
      setCurrentPanelIndex(prev => prev - 1);
    }
  };

  const goToNextPanel = () => {
    if (currentPanelIndex < displayPanels.length - 1) {
      setCurrentPanelIndex(prev => prev + 1);
    }
  };

  // When height_type is 'image' and we have an image, use CSS Grid to size based on image
  const isImageSized = height_type === 'image' && effectiveBackgroundType === 'image' && effectiveImageUrl;

  const getBackgroundStyle = () => {
    if (effectiveBackgroundType === 'color') {
      return { backgroundColor: effectiveBackgroundColor };
    }
    if (effectiveBackgroundType === 'gradient') {
      return { 
        background: `linear-gradient(${effectiveGradientAngle}deg, ${effectiveGradientStart}, ${effectiveGradientEnd})` 
      };
    }
    return {};
  };

  // Render a single panel (for mobile view)
  const renderSinglePanel = (panel, index, forMobile = false) => {
    const panelPaddingTop = panel.padding_top ?? 40;
    const panelPaddingBottom = panel.padding_bottom ?? 40;
    const panelPaddingLeft = panel.padding_left ?? 20;
    const panelPaddingRight = panel.padding_right ?? 20;
    // Use mobile_text_gap override when on mobile, otherwise use panel's individual text_gap
    const textGap = (forMobile && mobile_text_gap !== undefined && mobile_text_gap !== null) 
      ? mobile_text_gap 
      : (panel.text_gap ?? 0);
    const bottomVerticalAlign = panel.bottom_vertical_align || 'bottom';
    
    return (
      <div 
        key={index}
        className={`flex flex-col relative ${bottomVerticalAlign === 'bottom' ? 'justify-between' : 'justify-start'} ${forMobile ? 'w-full h-full' : 'flex-1'}`}
        style={{
          borderRight: !forMobile && index < displayPanels.length - 1 
            ? `${divider_weight}px solid rgba(${hexToRgb(divider_color)}, ${divider_opacity / 100})` 
            : 'none',
          paddingTop: `${panelPaddingTop}px`,
          paddingBottom: `${forMobile ? panelPaddingBottom + 40 : panelPaddingBottom}px`, // Extra bottom padding on mobile for indicators
          paddingLeft: `${panelPaddingLeft}px`,
          paddingRight: `${panelPaddingRight}px`
        }}
      >
        <div 
          style={{
            textAlign: panel.header_align || 'left'
          }}
        >
          {panel.header_text && (
            <div 
              className="panel-rich-text-content"
              style={{ 
                fontFamily: panel.header_font_family || 'Poppins, sans-serif',
                fontSize: `${(isMobile && panel.header_font_size_mobile) ? panel.header_font_size_mobile : (panel.header_font_size || 24)}px`,
                fontWeight: panel.header_font_weight || 600,
                color: panel.header_color || '#ffffff',
                letterSpacing: `${panel.header_letter_spacing || 0}px`,
                lineHeight: panel.header_line_height || 1.3,
                textTransform: panel.header_text_transform || 'none',
                margin: 0
              }}
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(panel.header_text) }}
            />
          )}
        </div>
        
        <div 
          className={bottomVerticalAlign === 'bottom' ? 'mt-auto' : ''}
          style={{
            textAlign: panel.bottom_align || 'left',
            marginTop: textGap > 0 ? `${textGap}px` : undefined
          }}
        >
          {panel.bottom_text && (
            <div 
              className="panel-rich-text-content"
              style={{ 
                fontFamily: panel.bottom_font_family || 'Poppins, sans-serif',
                fontSize: `${(isMobile && panel.bottom_font_size_mobile) ? panel.bottom_font_size_mobile : (panel.bottom_font_size || 16)}px`,
                fontWeight: panel.bottom_font_weight || 400,
                color: panel.bottom_color || '#ffffff',
                letterSpacing: `${panel.bottom_letter_spacing || 0}px`,
                lineHeight: panel.bottom_line_height || 1.5,
                textTransform: panel.bottom_text_transform || 'none',
                margin: 0,
                marginBottom: panel.button?.text ? '16px' : 0
              }}
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(panel.bottom_text) }}
            />
          )}
          
          {panel.button?.text && (
            <AGCASButton
              text={panel.button.text}
              link={panel.button.link}
              buttonStyleId={panel.button.button_style_id}
              customBgColor={panel.button.custom_bg_color}
              customTextColor={panel.button.custom_text_color}
              customBorderColor={panel.button.custom_border_color}
              transparentBg={panel.button.transparent_bg}
              openInNewTab={panel.button.open_in_new_tab}
              size={panel.button.size || 'default'}
              showArrow={panel.button.show_arrow}
            />
          )}
        </div>
      </div>
    );
  };

  // Render panels content - shared between both layouts (desktop only)
  const renderPanels = () => (
    displayPanels.map((panel, index) => renderSinglePanel(panel, index, false))
  );

  // Mobile carousel indicators and navigation
  const renderMobileIndicators = () => {
    if (displayPanels.length <= 1) return null;
    
    return (
      <div className="absolute bottom-4 left-0 right-0 flex items-center justify-center gap-3 z-10">
        {/* Previous arrow */}
        <button
          onClick={goToPrevPanel}
          disabled={currentPanelIndex === 0}
          className={`p-1 rounded-full transition-opacity ${
            currentPanelIndex === 0 ? 'opacity-30 cursor-not-allowed' : 'opacity-80 hover:opacity-100'
          }`}
          style={{ backgroundColor: 'rgba(255,255,255,0.2)' }}
          aria-label="Previous panel"
        >
          <ChevronLeft className="w-5 h-5 text-white" />
        </button>

        {/* Dot indicators */}
        <div className="flex items-center gap-2">
          {displayPanels.map((_, index) => (
            <button
              key={index}
              onClick={() => goToPanel(index)}
              className={`rounded-full transition-all ${
                index === currentPanelIndex 
                  ? 'w-3 h-3 bg-white' 
                  : 'w-2 h-2 bg-white/50 hover:bg-white/70'
              }`}
              aria-label={`Go to panel ${index + 1}`}
            />
          ))}
        </div>

        {/* Next arrow */}
        <button
          onClick={goToNextPanel}
          disabled={currentPanelIndex === displayPanels.length - 1}
          className={`p-1 rounded-full transition-opacity ${
            currentPanelIndex === displayPanels.length - 1 ? 'opacity-30 cursor-not-allowed' : 'opacity-80 hover:opacity-100'
          }`}
          style={{ backgroundColor: 'rgba(255,255,255,0.2)' }}
          aria-label="Next panel"
        >
          <ChevronRight className="w-5 h-5 text-white" />
        </button>
      </div>
    );
  };

  // Swipe hint text for mobile
  const renderSwipeHint = () => {
    if (displayPanels.length <= 1) return null;
    
    return (
      <div className="absolute top-4 right-4 flex items-center gap-1 text-white/60 text-xs z-10">
        <span>{currentPanelIndex + 1} / {displayPanels.length}</span>
      </div>
    );
  };

  // Check if we should show mobile carousel (more than 1 panel on mobile or mobile preview)
  const showMobileCarousel = isEffectivelyMobile && displayPanels.length > 1;

  // When using image-based sizing, use CSS Grid layout
  if (isImageSized) {
    return (
      <div 
        id={anchor || undefined}
        ref={containerRef}
        onTouchStart={showMobileCarousel ? handleTouchStart : undefined}
        onTouchMove={showMobileCarousel ? handleTouchMove : undefined}
        onTouchEnd={showMobileCarousel ? handleTouchEnd : undefined}
        style={{ 
          display: 'grid',
          gridTemplateColumns: '1fr',
          gridTemplateRows: '1fr',
          width: '100%',
          position: 'relative'
        }}
      >
        {/* Image layer - sets the size */}
        <img 
          src={effectiveImageUrl} 
          alt="Panel background" 
          style={{ 
            gridColumn: '1 / -1',
            gridRow: '1 / -1',
            display: 'block', 
            width: '100%', 
            height: 'auto' 
          }}
        />
        {/* Overlay layer */}
        {effectiveOverlayEnabled && (
          <div 
            style={{ 
              gridColumn: '1 / -1',
              gridRow: '1 / -1',
              backgroundColor: effectiveOverlayColor, 
              opacity: parseInt(effectiveOverlayOpacity) / 100
            }} 
          />
        )}
        {/* Panels layer */}
        <div 
          style={{ 
            gridColumn: '1 / -1',
            gridRow: '1 / -1',
            display: 'flex',
            width: '100%',
            height: '100%',
            maxWidth: full_width ? '80rem' : undefined,
            margin: full_width ? '0 auto' : undefined
          }}
        >
          {showMobileCarousel 
            ? renderSinglePanel(displayPanels[currentPanelIndex], currentPanelIndex, true)
            : renderPanels()
          }
        </div>
        {/* Mobile indicators */}
        {showMobileCarousel && renderSwipeHint()}
        {showMobileCarousel && renderMobileIndicators()}
      </div>
    );
  }

  // Default layout with min_height
  return (
    <div 
      id={anchor || undefined}
      ref={containerRef}
      onTouchStart={showMobileCarousel ? handleTouchStart : undefined}
      onTouchMove={showMobileCarousel ? handleTouchMove : undefined}
      onTouchEnd={showMobileCarousel ? handleTouchEnd : undefined}
      className="relative w-full overflow-hidden"
      style={{ 
        ...getBackgroundStyle(),
        minHeight: `${effectiveMinHeight}px`
      }}
    >
      {effectiveBackgroundType === 'image' && effectiveImageUrl && (
        <>
          <img 
            src={effectiveImageUrl} 
            alt="Panel background" 
            className="absolute inset-0 w-full h-full"
            style={{ objectFit: effectiveImageFit }}
          />
          {effectiveOverlayEnabled && (
            <div 
              className="absolute inset-0" 
              style={{ 
                backgroundColor: effectiveOverlayColor, 
                opacity: parseInt(effectiveOverlayOpacity) / 100 
              }} 
            />
          )}
        </>
      )}
      
      <div 
        className="relative h-full flex"
        style={{
          minHeight: `${effectiveMinHeight}px`,
          maxWidth: full_width ? '80rem' : undefined,
          margin: full_width ? '0 auto' : undefined,
          paddingLeft: full_width ? '1rem' : undefined,
          paddingRight: full_width ? '1rem' : undefined
        }}
      >
        {showMobileCarousel 
          ? renderSinglePanel(displayPanels[currentPanelIndex], currentPanelIndex, true)
          : renderPanels()
        }
      </div>
      {/* Mobile indicators */}
      {showMobileCarousel && renderSwipeHint()}
      {showMobileCarousel && renderMobileIndicators()}
    </div>
  );
}

function hexToRgb(hex) {
  if (!hex) return '255, 255, 255';
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result 
    ? `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}`
    : '255, 255, 255';
}

export function IEditImagePanelElementEditor({ element, onChange }) {
  const content = element.content || {};
  const backgroundType = content.background_type || 'color';
  const mobileBackgroundType = content.mobile_background_type || 'same';
  const [isUploading, setIsUploading] = useState(false);
  const [isUploadingMobile, setIsUploadingMobile] = useState(false);
  const [buttonStyles, setButtonStyles] = useState([]);
  const [expandedPanels, setExpandedPanels] = useState({ 0: true });
  const [expandedSections, setExpandedSections] = useState({
    settings: false,
    background: false,
    mobileBackground: false,
    layout: false,
    dividers: false,
    panels: true
  });

  const toggleSection = (section) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const AlignmentButtons = ({ value, onChange: onAlignChange, label }) => (
    <div>
      <label className="block text-xs font-medium mb-1">{label}</label>
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

  const defaultPanel = {
    header_text: '',
    header_font_family: 'Poppins',
    header_font_size: 24,
    header_font_weight: 600,
    header_color: '#ffffff',
    header_letter_spacing: 0,
    header_line_height: 1.3,
    header_align: 'left',
    bottom_text: '',
    bottom_font_family: 'Poppins',
    bottom_font_size: 16,
    bottom_font_weight: 400,
    bottom_color: '#ffffff',
    bottom_letter_spacing: 0,
    bottom_line_height: 1.5,
    bottom_align: 'left',
    bottom_vertical_align: 'bottom',
    text_gap: 0,
    padding_top: 40,
    padding_bottom: 40,
    padding_left: 20,
    padding_right: 20,
    button: null
  };

  const defaultButton = { 
    text: '', 
    link: '', 
    button_style_id: '', 
    open_in_new_tab: false, 
    size: 'default', 
    show_arrow: false, 
    custom_bg_color: '', 
    custom_text_color: '', 
    custom_border_color: '',
    transparent_bg: false
  };

  const panels = content.panels || [];

  const updateContent = (key, value) => {
    onChange({ ...element, content: { ...content, [key]: value } });
  };

  const updatePanel = (index, key, value) => {
    console.log(`[updatePanel] Called with index=${index}, key=${key}, value=${value}`);
    console.log(`[updatePanel] Current panels:`, JSON.stringify(panels.map((p, i) => ({ index: i, text_gap: p.text_gap, bottom_vertical_align: p.bottom_vertical_align }))));
    
    // Deep clone all panels using JSON to ensure no shared references whatsoever
    const newPanels = JSON.parse(JSON.stringify(panels));
    
    if (!newPanels[index]) {
      newPanels[index] = { ...defaultPanel };
    }
    newPanels[index] = { ...newPanels[index], [key]: value };
    
    console.log(`[updatePanel] New panels:`, JSON.stringify(newPanels.map((p, i) => ({ index: i, text_gap: p.text_gap, bottom_vertical_align: p.bottom_vertical_align }))));
    
    updateContent('panels', newPanels);
  };

  const updatePanelButton = (index, keyOrUpdates, value) => {
    // Deep clone all panels to ensure no shared references
    const newPanels = panels.map((p) => {
      const clonedPanel = { ...p };
      if (clonedPanel.button) {
        clonedPanel.button = { ...clonedPanel.button };
      }
      return clonedPanel;
    });
    if (!newPanels[index]) {
      newPanels[index] = { ...defaultPanel };
    }
    const currentButton = newPanels[index].button || { ...defaultButton };
    if (typeof keyOrUpdates === 'object') {
      newPanels[index] = { ...newPanels[index], button: { ...currentButton, ...keyOrUpdates } };
    } else {
      newPanels[index] = { ...newPanels[index], button: { ...currentButton, [keyOrUpdates]: value } };
    }
    updateContent('panels', newPanels);
  };

  const addPanel = () => {
    if (panels.length < 5) {
      const newPanels = [...panels, { ...defaultPanel }];
      updateContent('panels', newPanels);
      setExpandedPanels({ ...expandedPanels, [newPanels.length - 1]: true });
    }
  };

  const removePanel = (index) => {
    const newPanels = panels.filter((_, i) => i !== index);
    updateContent('panels', newPanels);
  };

  const togglePanelExpanded = (index) => {
    setExpandedPanels({ ...expandedPanels, [index]: !expandedPanels[index] });
  };

  useEffect(() => {
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

    setIsUploadingMobile(true);
    try {
      const { base44 } = await import("@/api/base44Client");
      const response = await base44.integrations.Core.UploadFile({ file });
      updateContent('mobile_image_url', response.file_url);
    } catch (error) {
      alert('Failed to upload image: ' + error.message);
    } finally {
      setIsUploadingMobile(false);
    }
  };

  const AVAILABLE_FONTS = [
    { value: 'Poppins, sans-serif', label: 'Poppins' },
    { value: "'Degular Medium', 'Poppins', sans-serif", label: 'Degular Medium' },
    { value: 'Georgia, serif', label: 'Georgia' },
    { value: 'Arial, sans-serif', label: 'Arial' },
    { value: "'Times New Roman', serif", label: 'Times New Roman' }
  ];

  const fontWeights = [
    { value: 300, label: 'Light' },
    { value: 400, label: 'Regular' },
    { value: 500, label: 'Medium' },
    { value: 600, label: 'Semibold' },
    { value: 700, label: 'Bold' },
    { value: 800, label: 'Extra Bold' }
  ];

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
          placeholder="e.g., image-panel"
          className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
          data-testid="input-imagepanel-anchor"
        />
        <p className="text-xs text-slate-500 mt-1">
          Used for linking directly to this section (e.g., /page#anchor-id)
        </p>
      </div>

      {/* Settings Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('settings')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
        >
          <span className="font-semibold text-sm">Settings</span>
          {expandedSections.settings ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.settings && (
          <div className="p-4 space-y-4">
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                id="full_width"
                checked={content.full_width || false}
                onChange={(e) => updateContent('full_width', e.target.checked)}
                className="w-4 h-4 rounded border-slate-300"
                data-testid="checkbox-imagepanel-fullwidth"
              />
              <label htmlFor="full_width" className="text-sm font-medium">
                Full Width Background
              </label>
            </div>
            <p className="text-xs text-slate-500">
              When enabled, the background extends to full width while content remains constrained to the page width.
            </p>
          </div>
        )}
      </div>

      {/* Background & Layout Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('background')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
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
                    value={content.background_color || '#1a1a2e'}
                    onChange={(e) => updateContent('background_color', e.target.value)}
                    className="w-16 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                  />
                  <input
                    type="text"
                    value={content.background_color || '#1a1a2e'}
                    onChange={(e) => updateContent('background_color', e.target.value)}
                    className="flex-1 px-3 py-2 border border-slate-300 rounded-md font-mono text-sm"
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
                  <label className="block text-sm font-medium mb-1">Image Fit</label>
                  <select
                    value={content.image_fit || 'cover'}
                    onChange={(e) => updateContent('image_fit', e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md"
                  >
                    <option value="cover">Cover (fill, may crop)</option>
                    <option value="contain">Contain (show all)</option>
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
              <label className="block text-sm font-medium mb-1">Height Setting</label>
              <select
                value={content.height_type || 'custom'}
                onChange={(e) => updateContent('height_type', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
              >
                <option value="custom">Custom Height</option>
                <option value="image">Match Image Height</option>
              </select>
              <p className="text-xs text-slate-500 mt-1">
                {content.height_type === 'image' 
                  ? 'Container will size to match the background image height'
                  : 'Set a minimum height in pixels'}
              </p>
            </div>

            {(content.height_type || 'custom') === 'custom' && (
              <div>
                <label className="block text-sm font-medium mb-1">Minimum Height (px)</label>
                <input
                  type="number"
                  value={content.min_height || 500}
                  onChange={(e) => updateContent('min_height', parseInt(e.target.value) || 500)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                  min="200"
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Mobile Background Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('mobileBackground')}
          className="w-full flex items-center justify-between p-3 bg-blue-50 hover:bg-blue-100 text-left"
        >
          <span className="font-semibold text-sm text-blue-800">Mobile Background</span>
          {expandedSections.mobileBackground ? <ChevronUp className="w-4 h-4 text-blue-800" /> : <ChevronDown className="w-4 h-4 text-blue-800" />}
        </button>
        
        {expandedSections.mobileBackground && (
          <div className="p-4 space-y-4 bg-blue-50/30">
            <div className="p-3 bg-blue-100/50 border border-blue-200 rounded-md">
              <p className="text-sm text-blue-800">
                Configure a different background for mobile devices. Set to "Same as Desktop" to use the desktop background settings.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Mobile Background Type</label>
              <select
                value={mobileBackgroundType}
                onChange={(e) => updateContent('mobile_background_type', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
              >
                <option value="same">Same as Desktop</option>
                <option value="color">Solid Color</option>
                <option value="gradient">Gradient</option>
                <option value="image">Image</option>
              </select>
            </div>

            {mobileBackgroundType !== 'same' && (
              <>
                {mobileBackgroundType === 'color' && (
                  <div>
                    <label className="block text-sm font-medium mb-1">Mobile Background Color</label>
                    <div className="flex gap-2 items-center">
                      <input
                        type="color"
                        value={content.mobile_background_color || '#1a1a2e'}
                        onChange={(e) => updateContent('mobile_background_color', e.target.value)}
                        className="w-16 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                      />
                      <input
                        type="text"
                        value={content.mobile_background_color || '#1a1a2e'}
                        onChange={(e) => updateContent('mobile_background_color', e.target.value)}
                        className="flex-1 px-3 py-2 border border-slate-300 rounded-md font-mono text-sm"
                      />
                    </div>
                  </div>
                )}

                {mobileBackgroundType === 'gradient' && (
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

                {mobileBackgroundType === 'image' && (
                  <>
                    <div>
                      <label className="block text-sm font-medium mb-1">Mobile Background Image</label>
                      <div className="space-y-2">
                        <label className="inline-block">
                          <div className={`px-4 py-2 rounded-md text-sm font-medium cursor-pointer ${
                            isUploadingMobile 
                              ? 'bg-slate-300 cursor-not-allowed' 
                              : 'bg-blue-600 hover:bg-blue-700 text-white'
                          }`}>
                            {isUploadingMobile ? 'Uploading...' : 'Upload Mobile Image'}
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
                            disabled={isUploadingMobile}
                          />
                        </label>
                      </div>
                      {content.mobile_image_url && (
                        <div className="mt-2 relative">
                          <img
                            src={content.mobile_image_url}
                            alt="Mobile Preview"
                            className="w-full h-32 object-cover rounded"
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
                    </div>

                    <div>
                      <label className="block text-sm font-medium mb-1">Mobile Image Fit</label>
                      <select
                        value={content.mobile_image_fit || 'cover'}
                        onChange={(e) => updateContent('mobile_image_fit', e.target.value)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md"
                      >
                        <option value="cover">Cover (fill, may crop)</option>
                        <option value="contain">Contain (show all)</option>
                      </select>
                    </div>

                    <div className="space-y-3 p-3 bg-slate-50 rounded-md">
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
                            <label className="block text-sm font-medium mb-1">Opacity (%)</label>
                            <input
                              type="number"
                              value={content.mobile_overlay_opacity || 50}
                              onChange={(e) => updateContent('mobile_overlay_opacity', e.target.value)}
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

              </>
            )}

            {/* Mobile min height - always available regardless of background type */}
            <div>
              <label className="block text-sm font-medium mb-1">Mobile Minimum Height (px)</label>
              <input
                type="number"
                value={content.mobile_min_height || ''}
                onChange={(e) => updateContent('mobile_min_height', e.target.value ? parseInt(e.target.value) : null)}
                placeholder="Same as desktop"
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
                min="100"
              />
              <p className="text-xs text-slate-500 mt-1">
                Leave empty to use the desktop minimum height value
              </p>
            </div>

            {/* Mobile text gap - controls spacing between top and bottom text for all cards */}
            <div>
              <label className="block text-sm font-medium mb-1">Mobile Text Gap (px)</label>
              <input
                type="number"
                value={content.mobile_text_gap ?? ''}
                onChange={(e) => updateContent('mobile_text_gap', e.target.value ? parseInt(e.target.value) : null)}
                placeholder="Use per-card desktop settings"
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
                min="0"
              />
              <p className="text-xs text-slate-500 mt-1">
                Distance between top and bottom text on all cards. Leave empty to use each card's individual setting.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Dividers Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('dividers')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
        >
          <span className="font-semibold text-sm">Vertical Divider Lines</span>
          {expandedSections.dividers ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.dividers && (
          <div className="p-4">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Color</label>
                <input
                  type="color"
                  value={content.divider_color || '#ffffff'}
                  onChange={(e) => updateContent('divider_color', e.target.value)}
                  className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Weight (px)</label>
                <input
                  type="number"
                  value={content.divider_weight || 1}
                  onChange={(e) => updateContent('divider_weight', parseInt(e.target.value) || 1)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                  min="1"
                  max="10"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Opacity (%)</label>
                <input
                  type="number"
                  value={content.divider_opacity || 30}
                  onChange={(e) => updateContent('divider_opacity', parseInt(e.target.value) || 30)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                  min="0"
                  max="100"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Panels Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('panels')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
        >
          <span className="font-semibold text-sm">Panels ({panels.length}/5)</span>
          {expandedSections.panels ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.panels && (
          <div className="p-4 space-y-4">
            {panels.length < 5 && (
              <button
                type="button"
                onClick={addPanel}
                className="px-3 py-1 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-md"
              >
                + Add Panel
              </button>
            )}

            {panels.length === 0 && (
              <div className="text-center py-6 bg-slate-50 rounded-md">
                <p className="text-slate-500 mb-3">No panels configured yet</p>
                <button
                  type="button"
                  onClick={addPanel}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-sm"
                >
                  Add First Panel
                </button>
              </div>
            )}

            <div className="space-y-3">
              {panels.map((panel, index) => (
                <div key={index} className="border border-slate-200 rounded-md">
                  <div 
                    className="flex items-center justify-between p-3 bg-slate-50 cursor-pointer"
                    onClick={() => togglePanelExpanded(index)}
                  >
                    <span className="font-medium text-sm">
                      Panel {index + 1}
                      {panel.header_text && (
                        <span className="text-slate-500 ml-2">
                          - {String(panel.header_text).replace(/<[^>]*>/g, '').substring(0, 20)}{String(panel.header_text).replace(/<[^>]*>/g, '').length > 20 ? '...' : ''}
                        </span>
                      )}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); removePanel(index); }}
                        className="px-2 py-1 text-xs bg-red-100 hover:bg-red-200 text-red-700 rounded"
                      >
                        Remove
                      </button>
                      <span className="text-slate-400">{expandedPanels[index] ? '▼' : '▶'}</span>
                    </div>
                  </div>
              
              {expandedPanels[index] && (
                <div className="p-3 space-y-4">
                  <div className="border-b pb-3">
                    <h5 className="text-sm font-semibold text-slate-700 mb-2">Panel Padding</h5>
                    <div className="grid grid-cols-4 gap-2">
                      <div>
                        <label className="block text-xs font-medium mb-1">Top</label>
                        <input
                          type="number"
                          value={panel.padding_top ?? 40}
                          onChange={(e) => updatePanel(index, 'padding_top', parseInt(e.target.value) || 0)}
                          className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                          min="0"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium mb-1">Bottom</label>
                        <input
                          type="number"
                          value={panel.padding_bottom ?? 40}
                          onChange={(e) => updatePanel(index, 'padding_bottom', parseInt(e.target.value) || 0)}
                          className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                          min="0"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium mb-1">Left</label>
                        <input
                          type="number"
                          value={panel.padding_left ?? 20}
                          onChange={(e) => updatePanel(index, 'padding_left', parseInt(e.target.value) || 0)}
                          className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                          min="0"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium mb-1">Right</label>
                        <input
                          type="number"
                          value={panel.padding_right ?? 20}
                          onChange={(e) => updatePanel(index, 'padding_right', parseInt(e.target.value) || 0)}
                          className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                          min="0"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="border-b pb-3">
                    <h5 className="text-sm font-semibold text-slate-700 mb-2">Header Text (Top)</h5>
                    <div className="space-y-3">
                      <div>
                        <label className="block text-xs font-medium mb-1">Text</label>
                        <div className="panel-editor-quill">
                          <ReactQuill
                            theme="snow"
                            value={panel.header_text || ''}
                            onChange={(value) => updatePanel(index, 'header_text', value)}
                            modules={panelQuillModules}
                            placeholder="Enter header text..."
                          />
                        </div>
                      </div>
                      
                      <AlignmentButtons 
                        value={panel.header_align || 'left'}
                        onChange={(val) => updatePanel(index, 'header_align', val)}
                        label="Alignment"
                      />
                      
                      <TypographyStyleSelector
                        value={panel.header_typography_style_id}
                        onChange={(styleId, style) => {
                          const newPanels = [...panels];
                          if (!newPanels[index]) newPanels[index] = { ...defaultPanel };
                          
                          const updates = { header_typography_style_id: styleId };
                          if (style) {
                            const styleProps = applyTypographyStyle(style);
                            if (styleProps.font_family) updates.header_font_family = styleProps.font_family;
                            if (styleProps.font_size) updates.header_font_size = styleProps.font_size;
                            if (styleProps.font_size_mobile) updates.header_font_size_mobile = styleProps.font_size_mobile;
                            if (styleProps.font_weight) updates.header_font_weight = styleProps.font_weight;
                            if (styleProps.line_height) updates.header_line_height = styleProps.line_height;
                            if (styleProps.letter_spacing !== undefined) updates.header_letter_spacing = styleProps.letter_spacing;
                            if (styleProps.text_transform) updates.header_text_transform = styleProps.text_transform;
                            if (styleProps.color) updates.header_color = styleProps.color;
                          }
                          
                          newPanels[index] = { ...newPanels[index], ...updates };
                          updateContent('panels', newPanels);
                        }}
                        label="Typography Style"
                      />
                      
                      <details className="text-xs">
                        <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">
                          Manual Font Settings
                        </summary>
                        <div className="mt-2 grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-xs font-medium mb-1">Font</label>
                          <select
                            value={panel.header_font_family || 'Poppins, sans-serif'}
                            onChange={(e) => updatePanel(index, 'header_font_family', e.target.value)}
                            className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                          >
                            {AVAILABLE_FONTS.map(font => (
                              <option key={font.value} value={font.value}>{font.label}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-medium mb-1">Weight</label>
                          <select
                            value={panel.header_font_weight || 600}
                            onChange={(e) => updatePanel(index, 'header_font_weight', parseInt(e.target.value))}
                            className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                          >
                            {fontWeights.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-medium mb-1">Size (px)</label>
                          <input
                            type="number"
                            value={panel.header_font_size || 24}
                            onChange={(e) => updatePanel(index, 'header_font_size', parseInt(e.target.value) || 24)}
                            className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                            min="10"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium mb-1">Color</label>
                          <input
                            type="color"
                            value={panel.header_color || '#ffffff'}
                            onChange={(e) => updatePanel(index, 'header_color', e.target.value)}
                            className="w-full h-8 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium mb-1">Letter Spacing (px)</label>
                          <input
                            type="number"
                            value={panel.header_letter_spacing || 0}
                            onChange={(e) => updatePanel(index, 'header_letter_spacing', parseFloat(e.target.value) || 0)}
                            className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                            step="0.5"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium mb-1">Line Height</label>
                          <input
                            type="number"
                            value={panel.header_line_height || 1.3}
                            onChange={(e) => updatePanel(index, 'header_line_height', parseFloat(e.target.value) || 1.3)}
                            className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                            step="0.1"
                            min="0.8"
                          />
                        </div>
                        </div>
                      </details>
                    </div>
                  </div>

                  <div className="border-b pb-3">
                    <h5 className="text-sm font-semibold text-slate-700 mb-2">Text Layout</h5>
                    <div className="space-y-4">
                      <div>
                        <label className="block text-xs font-medium mb-1">Bottom Text Vertical Alignment</label>
                        <p className="text-xs text-slate-500 mb-2">
                          Controls where the bottom text sits within the panel.
                        </p>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => updatePanel(index, 'bottom_vertical_align', 'top')}
                            className={`flex-1 px-3 py-2 rounded border text-sm font-medium transition-colors ${
                              (panel.bottom_vertical_align || 'bottom') === 'top'
                                ? 'bg-blue-600 text-white border-blue-600'
                                : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                            }`}
                          >
                            Top (below header)
                          </button>
                          <button
                            type="button"
                            onClick={() => updatePanel(index, 'bottom_vertical_align', 'bottom')}
                            className={`flex-1 px-3 py-2 rounded border text-sm font-medium transition-colors ${
                              (panel.bottom_vertical_align || 'bottom') === 'bottom'
                                ? 'bg-blue-600 text-white border-blue-600'
                                : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                            }`}
                          >
                            Bottom (push down)
                          </button>
                        </div>
                      </div>
                      
                      <div>
                        <label className="block text-xs font-medium mb-1">Gap Between Header & Bottom Text</label>
                        <p className="text-xs text-slate-500 mb-2">
                          Set the minimum gap in pixels.
                        </p>
                        <div className="flex items-center gap-3">
                          <input
                            type="range"
                            min="0"
                            max="200"
                            step="5"
                            value={panel.text_gap ?? 0}
                            onChange={(e) => updatePanel(index, 'text_gap', parseInt(e.target.value) || 0)}
                            className="flex-1"
                          />
                          <input
                            type="number"
                            value={panel.text_gap ?? 0}
                            onChange={(e) => updatePanel(index, 'text_gap', parseInt(e.target.value) || 0)}
                            className="w-16 px-2 py-1.5 border border-slate-300 rounded-md text-sm text-center"
                            min="0"
                            max="500"
                          />
                          <span className="text-xs text-slate-500">px</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="border-b pb-3">
                    <h5 className="text-sm font-semibold text-slate-700 mb-2">Bottom Text</h5>
                    <div className="space-y-3">
                      <div>
                        <label className="block text-xs font-medium mb-1">Text</label>
                        <div className="panel-editor-quill">
                          <ReactQuill
                            theme="snow"
                            value={panel.bottom_text || ''}
                            onChange={(value) => updatePanel(index, 'bottom_text', value)}
                            modules={panelQuillModules}
                            placeholder="Enter bottom text..."
                          />
                        </div>
                      </div>
                      
                      <AlignmentButtons 
                        value={panel.bottom_align || 'left'}
                        onChange={(val) => updatePanel(index, 'bottom_align', val)}
                        label="Alignment"
                      />
                      
                      <TypographyStyleSelector
                        value={panel.bottom_typography_style_id}
                        onChange={(styleId, style) => {
                          const newPanels = [...panels];
                          if (!newPanels[index]) newPanels[index] = { ...defaultPanel };
                          
                          const updates = { bottom_typography_style_id: styleId };
                          if (style) {
                            const styleProps = applyTypographyStyle(style);
                            if (styleProps.font_family) updates.bottom_font_family = styleProps.font_family;
                            if (styleProps.font_size) updates.bottom_font_size = styleProps.font_size;
                            if (styleProps.font_size_mobile) updates.bottom_font_size_mobile = styleProps.font_size_mobile;
                            if (styleProps.font_weight) updates.bottom_font_weight = styleProps.font_weight;
                            if (styleProps.line_height) updates.bottom_line_height = styleProps.line_height;
                            if (styleProps.letter_spacing !== undefined) updates.bottom_letter_spacing = styleProps.letter_spacing;
                            if (styleProps.text_transform) updates.bottom_text_transform = styleProps.text_transform;
                            if (styleProps.color) updates.bottom_color = styleProps.color;
                          }
                          
                          newPanels[index] = { ...newPanels[index], ...updates };
                          updateContent('panels', newPanels);
                        }}
                        label="Typography Style"
                      />
                      
                      <details className="text-xs">
                        <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">
                          Manual Font Settings
                        </summary>
                        <div className="mt-2 grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-xs font-medium mb-1">Font</label>
                          <select
                            value={panel.bottom_font_family || 'Poppins, sans-serif'}
                            onChange={(e) => updatePanel(index, 'bottom_font_family', e.target.value)}
                            className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                          >
                            {AVAILABLE_FONTS.map(font => (
                              <option key={font.value} value={font.value}>{font.label}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-medium mb-1">Weight</label>
                          <select
                            value={panel.bottom_font_weight || 400}
                            onChange={(e) => updatePanel(index, 'bottom_font_weight', parseInt(e.target.value))}
                            className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                          >
                            {fontWeights.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-medium mb-1">Size (px)</label>
                          <input
                            type="number"
                            value={panel.bottom_font_size || 16}
                            onChange={(e) => updatePanel(index, 'bottom_font_size', parseInt(e.target.value) || 16)}
                            className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                            min="10"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium mb-1">Color</label>
                          <input
                            type="color"
                            value={panel.bottom_color || '#ffffff'}
                            onChange={(e) => updatePanel(index, 'bottom_color', e.target.value)}
                            className="w-full h-8 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium mb-1">Letter Spacing (px)</label>
                          <input
                            type="number"
                            value={panel.bottom_letter_spacing || 0}
                            onChange={(e) => updatePanel(index, 'bottom_letter_spacing', parseFloat(e.target.value) || 0)}
                            className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                            step="0.5"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium mb-1">Line Height</label>
                          <input
                            type="number"
                            value={panel.bottom_line_height || 1.5}
                            onChange={(e) => updatePanel(index, 'bottom_line_height', parseFloat(e.target.value) || 1.5)}
                            className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                            step="0.1"
                            min="0.8"
                          />
                        </div>
                        </div>
                      </details>
                    </div>
                  </div>

                  <div>
                    <h5 className="text-sm font-semibold text-slate-700 mb-2">Button (Optional)</h5>
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-xs font-medium mb-1">Button Text</label>
                          <input
                            type="text"
                            value={panel.button?.text || ''}
                            onChange={(e) => updatePanelButton(index, 'text', e.target.value)}
                            className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                            placeholder="Button text..."
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium mb-1">Link URL</label>
                          <input
                            type="text"
                            value={panel.button?.link || ''}
                            onChange={(e) => updatePanelButton(index, 'link', e.target.value)}
                            className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                            placeholder="/page or https://..."
                          />
                        </div>
                      </div>

                      {panel.button?.text && (
                        <>
                          <div>
                            <label className="block text-xs font-medium mb-1">Button Style</label>
                            <select
                              value={panel.button?.button_style_id || ''}
                              onChange={(e) => updatePanelButton(index, 'button_style_id', e.target.value)}
                              className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                            >
                              <option value="">Default</option>
                              {buttonStyles.map(s => (
                                <option key={s.id} value={s.id}>{s.name}</option>
                              ))}
                            </select>
                          </div>

                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="block text-xs font-medium mb-1">Size</label>
                              <select
                                value={panel.button?.size || 'default'}
                                onChange={(e) => updatePanelButton(index, 'size', e.target.value)}
                                className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                              >
                                <option value="small">Small</option>
                                <option value="default">Default</option>
                                <option value="large">Large</option>
                              </select>
                            </div>
                            <div className="flex items-end gap-2">
                              <label className="flex items-center gap-1 text-xs">
                                <input
                                  type="checkbox"
                                  checked={panel.button?.open_in_new_tab || false}
                                  onChange={(e) => updatePanelButton(index, 'open_in_new_tab', e.target.checked)}
                                  className="rounded"
                                />
                                New Tab
                              </label>
                              <label className="flex items-center gap-1 text-xs">
                                <input
                                  type="checkbox"
                                  checked={panel.button?.show_arrow || false}
                                  onChange={(e) => updatePanelButton(index, 'show_arrow', e.target.checked)}
                                  className="rounded"
                                />
                                Arrow
                              </label>
                            </div>
                          </div>

                          <div className="p-2 bg-slate-50 rounded-md">
                            <label className="flex items-center gap-2 text-xs mb-2">
                              <input
                                type="checkbox"
                                checked={panel.button?.transparent_bg || false}
                                onChange={(e) => updatePanelButton(index, 'transparent_bg', e.target.checked)}
                                className="rounded"
                              />
                              <span className="font-medium">Use Custom Colors</span>
                            </label>
                            
                            {panel.button?.transparent_bg && (
                              <div className="grid grid-cols-3 gap-2">
                                <div>
                                  <label className="block text-xs mb-1">Bg Color</label>
                                  <input
                                    type="color"
                                    value={panel.button?.custom_bg_color || '#3b82f6'}
                                    onChange={(e) => updatePanelButton(index, 'custom_bg_color', e.target.value)}
                                    className="w-full h-8 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                                  />
                                </div>
                                <div>
                                  <label className="block text-xs mb-1">Text Color</label>
                                  <input
                                    type="color"
                                    value={panel.button?.custom_text_color || '#ffffff'}
                                    onChange={(e) => updatePanelButton(index, 'custom_text_color', e.target.value)}
                                    className="w-full h-8 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                                  />
                                </div>
                                <div>
                                  <label className="block text-xs mb-1">Border Color</label>
                                  <input
                                    type="color"
                                    value={panel.button?.custom_border_color || '#3b82f6'}
                                    onChange={(e) => updatePanelButton(index, 'custom_border_color', e.target.value)}
                                    className="w-full h-8 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                                  />
                                </div>
                              </div>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
